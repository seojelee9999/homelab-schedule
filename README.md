# 차곡 · Spring Boot 일정 관리

> 오늘의 시간표, 월간 달력 조회, 날짜를 한 번 선택하는 시간별 일괄 작성과 Discord 카드 알림을 제공합니다. 최신 검증 범위는 [검증 기록](docs/validation.md)을 참고하세요.

일정 등록·조회·수정·삭제와 Discord 예약 알림을 제공하는 PostgreSQL 기반 MVP입니다. 시간 입력과 화면 표시는 **Asia/Seoul** 기준입니다.

저장소: https://github.com/seojelee9999/homelab-schedule.git

## 일정 작성과 조회

- 처음 열면 서울 기준 **오늘 일정**이 시작 시간순으로 표시됩니다. 시간대별 구분과 다음 일정 강조로 할 일을 확인할 수 있습니다.
- **월간 달력**에서 날짜를 누르면 해당 날짜의 시간표로 이동합니다. 이전·다음 달, 이번 달, 오늘 이동을 지원합니다.
- 작성표에서 날짜를 한 번 선택하고 `시작 시간 / 할 일 / 메모` 행을 추가합니다. 최대 48개 일정을 한 번에 저장하며, 저장 오류가 나면 전체가 취소됩니다.
- Discord 알림은 시작 시각, 10분·30분·1시간·하루 전 또는 직접 지정한 분 단위로 계산합니다. 전날로 넘어가는 알림도 자동 계산하며, 알림 시각은 현재 이후여야 합니다.
- Discord에는 `시작 시간 · 할 일`을 제목으로 한 카드와 날짜, 서울 기준 시각, 상대 시간이 표시됩니다. 각 일정은 개별 예약 알림으로 발송됩니다.
- 날짜를 조회하는 동안 작성 중인 내용은 유지됩니다. 다른 일정을 편집하며 기존 입력을 바꾸려는 경우 확인합니다.

API: `GET /api/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD`는 서울 기준 시작일 포함·종료일 제외, 최대 62일을 조회합니다. 날짜 범위 조회에는 기존 전체 목록의 500개 제한을 적용하지 않습니다. `POST /api/schedules/batch`는 `{ "items": [기존 일정 입력 객체, ...] }` 형식이며 모든 행의 시작 날짜가 같아야 합니다.

## 구성

- `src/main/java/`: 일정 API, 트랜잭션 처리, Discord 전송과 알림 작업자
- `src/main/resources/static/`: 한국어 일정 관리 화면과 알림 이력
- `src/main/resources/db/migration/`: Flyway PostgreSQL 스키마
- `src/test/`: 검증 및 PostgreSQL 통합 테스트
- `deploy/`: Kubernetes 리소스, Kustomize 이미지 설정, /plan HTTPRoute와 적용 설명
- `gitops/`: homelab-argocd ApplicationSet 등록 파일과 적용 패치
- `scripts/`: 실제 이미지로 배포 파일 준비, 이미지 갱신, 배포 규칙 검증
- `.github/workflows/ci.yml`: 테스트 → GHCR SHA 이미지 게시 → GitOps 이미지 태그 갱신
- [저장소 분석 및 설계](docs/architecture.md)

## 실행

Java 17, Gradle 8.14.3과 별도 PostgreSQL이 필요합니다. Docker 빌드도 지원합니다. DB는 자동 생성하지 않으며 Flyway가 준비된 DB의 스키마를 초기화합니다.

다음 환경변수를 안전한 실행 환경에서 공급하세요. 실제 값이 들어 있는 `.env`, Secret YAML, 비밀번호 또는 웹훅 URL을 Git에 넣지 마세요.

| 변수 | 값/용도 |
| --- | --- |
| `DB_URL` | PostgreSQL JDBC URL |
| `DB_USERNAME` | 앱 DB 계정, 배포에서는 `schedule_app` |
| `DB_PASSWORD` | 앱 DB 비밀번호 |
| `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/<id>/<token>` 형식, 쿼리 없는 incoming webhook URL. 작업자 비활성화 시 생략 가능 |
| `WORKER_ENABLED` | 알림 작업자 활성화, 운영에서는 true |

```bash
gradle --no-daemon test bootJar
java -jar build/libs/schedule-1.0.0.jar
```

브라우저에서 `http://localhost:8080`으로 접속합니다. 이 MVP에는 사용자 로그인·사용자별 권한이 없습니다. 로컬에서는 루트 경로로 접속하며 배포 시에는 기존 Gateway를 통해 `https://akibaha.shop/plan/`로 접속합니다. 웹 변경 요청에는 CSRF 토큰이 필요합니다. CSRF는 로그인 기능을 대신하지 않습니다.

컨테이너 빌드:

```bash
docker build -t schedule:local .
```

## 알림 처리

일정과 알림 예약을 함께 DB에 저장합니다. Spring 작업자가 기본 5초 간격으로 실행되며 회차당 최대 20건을 순서대로 처리합니다. 정확한 정시 전송을 보장하는 구조는 아니며 처리량·네트워크 상태에 따라 지연될 수 있습니다. 앱이 중단된 동안 도래한 예약은 재기동 후 처리합니다. 여러 replica는 PostgreSQL 행 잠금을 통해 알림을 선점합니다. 전송 시도와 결과, Discord 메시지 ID를 추적합니다.

작업자는 애플리케이션 내부에서 실행하며 Kubernetes CronJob은 사용하지 않습니다. 수시로 등록·수정되는 개별 알림과 취소 처리를 DB에서 함께 관리하기 위한 선택입니다. 독립적인 확장이 필요하면 같은 발송 로직을 별도 Deployment로 분리할 수 있습니다.

HTTP 연결 제한은 3초, 요청 제한은 8초, 오래된 선점의 복구 기준은 기본 60초입니다. 유효한 `retry_after` 또는 `Retry-After`가 있는 429 응답만 자동 재예약합니다. 명확한 4xx 거절은 `FAILED`, 408·5xx·타임아웃·성공 메시지 ID 누락은 `UNKNOWN`으로 남깁니다. 이력의 `RATE_LIMITED`는 발송 시도의 결과이며 해당 알림은 `PENDING` 상태로 다음 시각을 기다립니다.

전송 성공 직후 DB 저장 전에 장애가 발생하거나 HTTP 응답이 불명확하면 실제 전송 여부를 확정할 수 없습니다. 이때 `UNKNOWN`으로 남기며 자동 재전송하지 않습니다. 화면에서 알림 ID와 이력을 확인하고 Discord 채널을 대조한 뒤 재시도하거나 재전송 없이 종료하세요. 수동 재시도 시 중복 가능성을 확인해야 합니다. 정확히 한 번 전송을 보장한다고 가정하지 않습니다.

## Kubernetes 적용 순서

자세한 명령과 필수 사전조건은 [배포 가이드](deploy/README.md)에 있습니다.

1. 기존 `longhorn-database`, `aws-parameter-store`, ESO와 Gateway 상태 및 스토리지 여유를 확인합니다. 기존 PV/PVC를 삭제하거나 재사용하지 않습니다.
2. 기존 SSM 관리 절차로 `/homelab/schedule/DB_PASSWORD`, `/homelab/schedule/POSTGRES_ADMIN_PASSWORD`, `/homelab/schedule/DISCORD_WEBHOOK_URL`을 준비합니다. ESO 읽기·복호화 권한과 기존 GHCR 인증 경로도 확인합니다.
3. 이 소스를 `homelab-schedule` 저장소의 main에 반영합니다. CI가 PG17 테스트·컨테이너 smoke를 통과하면 검증한 이미지를 GHCR 전체 SHA 태그로 게시하고 `deploy/kustomization.yaml`을 갱신합니다.
4. 최초 설정은 `bootstrap` 태그와 앱 replicas=0입니다. CI의 이미지 게시 후 갱신 커밋에서 실제 SHA와 replicas=2로 함께 바뀝니다. bootstrap은 배포 가능한 실제 이미지가 아닙니다.
5. [등록 패치](gitops/homelab-argocd.patch)를 `~/homelab-argocd`에 적용하고 commit/push합니다. 기존 ApplicationSet이 main의 deploy 경로를 자동 sync합니다.

```bash
kubectl kustomize deploy
# homelab-schedule CI 성공과 deploy 이미지 SHA 갱신을 먼저 확인
git -C ~/homelab-argocd apply --check /home/lyrica/schedule/gitops/homelab-argocd.patch
git -C ~/homelab-argocd apply /home/lyrica/schedule/gitops/homelab-argocd.patch
git -C ~/homelab-argocd add apps/schedule.json
git -C ~/homelab-argocd commit -m "Register schedule application"
git -C ~/homelab-argocd push origin main
```

`/plan`는 HTTPS `/plan/`로 이동하고, `/plan/…`는 접두사를 제거해 `schedule/schedule:8080`으로 전달합니다. HTTPRoute는 앱의 deploy/에서 관리하고 기존 `gateway-system/tunnel-gateway`에 연결하므로 Gateway 리소스를 중복 생성하지 않습니다.

```bash
kubectl -n schedule get externalsecrets,pvc,pods
kubectl -n schedule rollout status statefulset/schedule-postgres
kubectl -n schedule rollout status deployment/schedule
kubectl -n schedule describe httproute schedule
curl -I https://akibaha.shop/plan
curl -I https://akibaha.shop/plan/
```

PVC와 Namespace는 `Prune=false,Delete=false`, StorageClass는 기존 `Retain` 정책을 사용합니다. 직접 Namespace/PVC를 삭제하면 안 됩니다. PostgreSQL은 단일 인스턴스이며 복제 스토리지가 별도 DB 백업을 대신하지 않습니다. SSM 비밀번호 교체만으로 기존 DB 역할 비밀번호가 바뀌지 않습니다.

## 검증

CI는 PostgreSQL 17을 사용합니다. 로컬 통합 테스트는 운영 데이터와 분리된 전용 테스트 DB를 사용해야 합니다. 통합 테스트는 실행마다 `schedule_it_<무작위 UUID>` 스키마를 만들고 그 안에서만 테이블 초기화를 수행한 뒤 스키마를 삭제합니다. 테스트 계정에는 해당 DB의 스키마 생성 권한이 필요합니다. 테스트의 Discord 전송은 대역으로 처리하므로 실제 웹훅은 필요하지 않습니다.

```bash
# DB_URL, DB_USERNAME, DB_PASSWORD를 전용 테스트 DB 값으로 공급한 뒤 실행
gradle --no-daemon test bootJar
node --check src/main/resources/static/app.js
node scripts/frontend_smoke.cjs
python3 scripts/validate_deployment.py
```

DB 없이 Discord 처리만 확인하려면 `gradle --no-daemon test --tests '*DiscordClientTest'`를 사용합니다. 검증 결과와 환경 제약은 [검증 기록](docs/validation.md)에 기록합니다.
