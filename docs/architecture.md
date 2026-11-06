# 일정 앱 MVP와 저장소 분석

## 확인한 저장소

작업 시작 시 `/home/lyrica/schedule`에는 `.gitignore`만 있었으며 `.git`·README·빌드·코드가 없었다. 사용자가 이 위치에 앱을 새로 만들고 배포 파일을 분리하도록 지정했다. 이후 요청에 따라 배포 경로를 `deploy/`로 확정했다. 연결되지 않은 origin URL은 추정하지 않는다.

참조한 로컬 저장소:

- `/home/lyrica/homelab-argocd/README.md`, `POSTGRES.md`
- `argocd/applicationset.yaml`, `apps/diet-app.json`
- `cluster-resources/longhorn-database.yaml`, `aws-parameter-store.yaml`, `ghcr-external-secret.yaml`, `discord-alerts-secret.yaml`
- `/home/lyrica/diet-app/.github/workflows/ci.yml`
- `/home/lyrica/finance-app/build.gradle`, `Dockerfile`, `src/`

규칙: Java 17/Gradle 계열 앱, GHCR 전체 commit SHA 태그, Kustomize 이미지 갱신, HTTPS repoURL과 `apps/*.json` 기반 ApplicationSet. 앱 등록 키는 `appName`, `repoURL`, `targetRevision`, `manifest_path`, `namespace`이다. 기존 README에는 이전 경로가 남아 있어 실제 JSON을 우선한다.

Secret은 AWS SSM SecureString → ESO `external-secrets.io/v1` → `aws-parameter-store` ClusterSecretStore로 공급한다. 기존 AWS 리전은 `ap-northeast-2`. DB용 StorageClass `longhorn-database`는 Longhorn, 복제본 2개, `Retain`으로 정의되어 있다. 이는 **저장소 정의 확인**이며 현재 클러스터 설치·상태 확인을 의미하지 않는다. 기존 PV/PVC의 연결 상태나 용량 여유는 조회하지 않았고 임의로 재사용하지 않는다.

## 범위와 구조

- Spring Boot 웹/API, 일정 등록·목록·수정·삭제, 단일 사용자 공유 일정.
- 브라우저 입력·표시는 Asia/Seoul. DB의 절대 시각은 `timestamptz`.
- PostgreSQL + Flyway. 앱 Pod는 무상태, DB StatefulSet 1개와 전용 PVC.
- 일정 변경과 알림 생성/취소를 같은 DB 트랜잭션에서 수행.
- 영속 알림 큐와 시도 이력, Discord 메시지 ID 추적.
- 반복 일정, 사용자 계정/권한, DB HA, 백업 자동화는 MVP에 포함하지 않는다.
- 사용자 요청에 따라 `akibaha.shop/day`를 기존 Envoy Gateway에 연결한다. HTTPRoute는 schedule 네임스페이스에서 앱과 함께 관리하고 Service는 ClusterIP를 유지한다. 앱에는 로그인 기능이 없으며 CSRF는 인증 기능을 대신하지 않는다.

## 알림 보장과 복구

실행 주체는 Spring `@Scheduled` 작업자다. `schedule.poll-ms=5000`의 fixed delay로 회차당 최대 20건을 순차 발송한다. 사용자 지정 시각·수정·삭제가 빈번한 알림은 DB 예약으로 관리하며 Kubernetes CronJob을 일정마다 생성하지 않는다. CronJob은 정기 요약·정리 배치에 더 적합하고, 사용하더라도 중복 방지를 위한 DB 선점은 여전히 필요하다. 웹/API와 발송 부하를 분리할 때는 별도 worker Deployment를 검토한다.

DB에서 도래한 알림을 `FOR UPDATE SKIP LOCKED`로 선점하여 여러 replica가 같은 알림을 동시에 발송하지 않도록 한다. 선점과 전송 시도를 먼저 영속화하고, 전송 시 다시 해당 상태를 검사한다. HTTP 요청 중에는 해당 알림 행 잠금을 유지하여 살아 있는 발송 작업과 복구/수정이 경쟁하지 않게 한다. 전송 제한 시간은 짧게 둔다.

Discord에는 `wait=true`로 요청하고 성공 응답의 메시지 ID를 저장한다. 메시지에 알림 ID를 포함하고 사용자 입력이 `@everyone` 등을 발생시키지 않도록 allowed_mentions를 비운다. 응답 본문이나 예외의 웹훅 URL은 로그·DB에 보관하지 않는다.

선점·발송·복구는 각각 `REQUIRES_NEW` 트랜잭션이다. 발송은 `notification ID + active_attempt + SENDING` 조건을 다시 확인하며, 복구 이전이라도 만료된 선점은 발송하지 않는다. 복구는 기본 60초가 지난 선점 중 잠기지 않은 행을 최대 100개씩 UNKNOWN으로 변경한다. HTTP 연결 제한은 3초, 요청 제한은 8초이고 리다이렉트를 따르지 않는다. 복구 기준은 최소 30초로 제한한다.

429의 유효한 `retry_after` 또는 `Retry-After`만 초 단위로 해석하여 DB의 `next_attempt_at`을 갱신한다. 지연이 누락되거나 유효하지 않으면 FAILED로 남긴다. 408을 제외한 기타 4xx는 FAILED, 408·5xx·네트워크 실패·성공 응답의 메시지 ID 누락은 UNKNOWN이다. 상태 저장에 실패하면 앞서 커밋한 SENDING이 남아 복구 대상이 된다. API는 JDBC Timestamp를 ISO 8601 UTC 문자열로 반환하며 UI는 Asia/Seoul로 표시한다.

오래된 SENDING은 재시작 후 UNKNOWN으로 전환한다. 네트워크 타임아웃, 불명확한 응답, 전송 후 DB commit 실패도 확인 대상으로 남는다. UNKNOWN은 자동 재전송하지 않는다. Discord 채널에서 알림 ID를 검색한 후 수동 재시도하거나 재전송 없이 종료한다. 수동 재시도에는 중복 가능성 확인이 필요하다.

이 설계는 외부 HTTP 전송과 DB commit을 하나의 원자적 트랜잭션으로 만들 수 없다는 한계를 명시한다. 정확히 한 번 전송을 주장하지 않으며, 불명확한 전송을 추적 가능하게 보존한다. 앱 중단 중 도래한 PENDING은 기동 후 처리한다. UNKNOWN이 존재하면 운영자 확인 전까지 미전송 상태가 지속될 수 있다. 수정·삭제와 이미 실행된 외부 전송은 되돌릴 수 없다.

## 스토리지와 비밀값

새 앱 전용 PVC만 선언한다. 기존 PV/PVC 삭제나 StorageClass 생성/변경을 하지 않는다. PVC뿐 아니라 Namespace도 Argo CD `Prune=false,Delete=false`로 보호한다. Namespace 삭제는 내부 PVC를 함께 삭제하므로 별도 보호가 필요하다. 이 annotation은 직접 실행한 `kubectl delete`나 관리자 삭제를 막는 접근제어는 아니다.

DB 앱 계정은 비관리자이며 관리자 비밀번호와 분리한다. 비밀번호와 Discord URL은 SSM 참조만 Git에 저장한다. DB 초기화는 빈 데이터 디렉터리에서만 실행된다. 기존 DB의 비밀번호는 SSM 값 변경만으로 바뀌지 않는다. 회전 시 DB 역할 비밀번호 변경, SSM 갱신, ESO 동기화와 앱 재시작을 조율해야 한다. Longhorn 복제는 백업이 아니며 운영 데이터는 별도 pg_dump/복원 절차가 필요하다.

## 참고

- [Spring Boot 시스템 요구사항](https://docs.spring.io/spring-boot/3.5/system-requirements.html)
- [PostgreSQL SELECT 및 SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
- [Discord Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)
- [Discord Rate Limits](https://docs.discord.com/developers/topics/rate-limits)
- [Kubernetes CronJob의 실행 제한](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/#job-creation)

## CI/CD와 /day 경로

`~/diet-app`의 테스트 → GHCR 전체 SHA → Kustomize 갱신 흐름과 `~/homelab-argocd`의 apps/*.json ApplicationSet 규칙을 따른다. PG17에서 운영 init 스크립트로 제한된 앱 계정을 만들고 통합 테스트를 수행한다. 컨테이너 smoke 후 저장한 이미지를 publish job이 그대로 로드·게시하므로 테스트와 배포 사이에 다시 빌드하지 않는다. 이미지 게시가 성공해야 deploy/kustomization.yaml의 SHA와 초기 앱 replicas=0을 2로 갱신한다. 더 최신 소스 커밋이 있거나 fast-forward push가 충돌하면 오래된 빌드의 배포 반영을 건너뛰거나 다시 검사한다.

등록 파일은 appName=schedule, repoURL=https://github.com/seojelee9999/homelab-schedule.git, targetRevision=main, manifest_path=deploy, namespace=schedule이다. 현재 환경에서 homelab 저장소는 읽기 전용이므로 gitops/에 파일과 적용 패치를 제공한다. 실제 등록은 homelab 저장소에 반영된 뒤 성립한다.

HTTPRoute의 Exact /day는 HTTPS 443의 /day/로 redirect하고, PathPrefix /day는 /로 rewrite한다. parentRefs는 gateway-system/tunnel-gateway의 http listener다. 해당 Gateway는 다른 네임스페이스의 Route를 이미 허용한다. 정적 파일은 상대 경로, fetch는 document.baseURI 기준 상대 API URL을 사용하여 로컬 /와 배포 /day/를 모두 지원한다. 배포 세션 쿠키는 DAYSESSION, Path=/day, Secure=true, SameSite=lax로 분리한다. 앱을 수정하기 위한 로그인은 별도 구현되지 않았다.
