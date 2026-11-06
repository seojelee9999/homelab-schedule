# 재개 안내 — 2026-11-06 갱신

## 사용자 요구와 유지할 조건

- Spring Boot 일정 CRUD + 지정 시각 Discord webhook, PostgreSQL PVC, Asia/Seoul.
- 앱 `/home/lyrica/schedule`, 최신 요청으로 배포 경로는 `deploy/`로 변경됨.
- 지정 저장소 `https://github.com/seojelee9999/homelab-schedule.git`. 이전 세션 ls-remote는 빈 refs였다. 이번 세션에서는 원격 재확인하지 않았다.
- Secret 평문 금지. 기존 SSM/ESO 사용. 기존 PV/PVC 삭제·재사용 금지. 다중 replica 중복 선점 방지, 재시작 이력 유지.
- 사용자가 앱 내부 발송과 k8s CronJob을 비교 질문했다. 개별 지정 시각과 CRUD 취소 처리를 함께 관리할 수 있는 **앱 내부 DB 작업자**를 추천하고 기존 설계대로 구현했다. CronJob 전환 요청은 없었다.
- 사용자는 토큰 여유를 남기고 중단할 때 재개 정보를 요구했다. 정확한 잔여 퍼센트는 확인할 수 없다.

## 구현된 파일과 동작

- 기존 한국어 UI, CRUD API, Spring Security CSRF, Flyway 스키마.
- `DiscordClient.java`: Discord HTTPS URL 검증, wait=true, mentions 차단, 메시지/알림 ID, 서울 시각, 3초 연결/8초 요청 제한. 리다이렉트 비활성화. 비밀 URL·응답 본문·원본 예외를 결과 이력이나 로그에 저장하지 않음.
- `NotificationWorker.java`: REQUIRES_NEW 선점 커밋 → 행 잠금 및 attempt fence → HTTP → 결과 커밋. 5초 fixed delay, 회차당 최대20건. 60초 이상 된 SENDING은 SKIP LOCKED로 최대100건씩 UNKNOWN 복구. 만료된 sender도 직접 전송 차단.
- 유효한 retry_after/Retry-After가 있는 429만 자동 재예약. 기타 명확한 4xx는 FAILED(408 제외), 5xx/408/transport/불명확한 성공은 UNKNOWN. 자동 재전송하지 않음.
- 수동 재시도는 UNKNOWN일 때 중복 위험 동의 필수. 이력과 previous attempt를 보존. 일정 수정·삭제는 SENDING/UNKNOWN이면409, 이전 PENDING/FAILED는 취소.
- JDBC Timestamp를 ISO UTC 문자열로 반환. UI의 due_at, 중첩 attempts 메시지 ID/발송 시각, RATE_LIMITED 표시 연결 수정.
- `DiscordClientTest` 7개 및 `ScheduleIntegrationTest` 11개 작성. 통합 테스트는 실행마다 고유 스키마만 생성·정리하며 Discord mock과 worker 비활성화를 사용.
- `build.gradle`에 junit-platform-launcher runtime 추가.
- `scripts/frontend_smoke.cjs` 추가, CI에서 실행하도록 연결.
- 최신 CI/CD 작업으로 deploy/의 실제 YAML과 Kustomize를 작성하고 기존 manifests/ 템플릿은 제거했다. 초기 이미지는 bootstrap, 앱 replicas=0이며 CI 게시 성공 후 실제 전체 SHA와 replicas=2를 함께 반영한다.
- README/architecture/validation 갱신.


## 최신 CI/CD·Gateway 요청 반영

- 사용자가 ~/diet-app을 참고한 CI/CD, deploy/ 매니페스트, ~/homelab-argocd 저장소 감시 등록, akibaha.shop/day 라우팅을 요청했다.
- .github/workflows/ci.yml: PG17 통합 테스트 → UI/deploy 검증 → 실제 컨테이너 API smoke → 검증한 이미지 artifact → GHCR 전체 SHA 게시 → deploy/kustomization.yaml 갱신. publish에서 다시 빌드하지 않는다. 최신 소스 경쟁 방지와 fast-forward push 유지.
- deploy/: Namespace, 앱 Service/Deployment, PG17 Service/PVC/init/StatefulSet, ESO 및 GHCR Secret 참조, HTTPRoute, Kustomization. 실제 Secret 값은 생성·조회하지 않았다.
- /day → HTTPS443 /day/ redirect; /day prefix 제거 → schedule:8080. 기존 gateway-system/tunnel-gateway http listener에 연결. Gateway 본체는 이미 다른 네임스페이스 Route를 허용하므로 수정할 필요 없다.
- 프런트 정적 파일과 fetch는 상대 경로로 수정했다. 루트 /와 /day/ UI mock smoke 모두 통과. 운영 쿠키는 DAYSESSION, /day, Secure, SameSite=lax.
- gitops/homelab-argocd/apps/schedule.json 및 gitops/homelab-argocd.patch 작성. repoURL은 homelab-schedule.git, main/deploy. 대상 저장소에 git apply --check 통과.
- **실제 Argo 등록은 미완료**: ~/homelab-argocd 디렉터리 읽기 전용. 로컬 기존 변경(DIET_APP_SETUP_AND_CODE.md, ansible/)은 건드리지 않음. GitHub SSH ls-remote도 DNS 실패하여 원격 조회·push·CI·클러스터 적용 미실행.
- 최신 배포 규칙 검증은 route/cookie/초기 replicas0→2/등록 경로/이미지 갱신을 포함한다. scripts/smoke_api.py는 CI에 연결했지만 Docker가 없어 로컬 실행하지 못했다.
- MockMvc는 루트 welcome page를 실제로 재디스패치하지 않으므로 통합 테스트의 / 검사에서 forwardedUrl(index.html)을 확인하고 /index.html의 콘텐츠를 별도로 확인하도록 수정했다. PG 통합 테스트는 여전히 실행 필요.
- 우선 후속 작업: deploy/README.md에 따라 실제 소스 저장소 main 반영 → CI 성공 및 이미지 SHA 확인 → 등록 패치 적용·push → Argo/Route/브라우저 확인. bootstrap 태그로 앱을 강제로 활성화하지 말 것.

## 검증 결과 — 구분 필수

**이번 세션 통과:** Java17 javac로 전체 main/test 소스 직접 컴파일, Discord 단위 테스트7개, JS syntax/UI mock smoke, 배포 validator.

**작성·컴파일만 했음:** PostgreSQL 통합 테스트11개. 실제 테스트 실행은 못 했다.

**현재 환경 차단:** Gradle은 `Could not determine a usable wildcard IP for this machine`, 로컬 PG18은 IPv4 socket `Operation not permitted`로 시작 실패. 샌드박스 승인 카테고리도 허용되지 않아 권한 확대를 요청하지 않았다. 파일 편집과 일반 curl 의존성 다운로드는 가능했다. Gradle 의존성 보고서 성공은 JAR 다운로드·컴파일 완료를 의미하지 않으므로 주의.

**미실행:** Gradle test/bootJar, PG17/PG18 통합 테스트, 실제 앱 및 브라우저 연동, Docker build, GitHub CI, GHCR publish, 실제 Discord 발송, 클러스터 검증·배포.

자세한 항목은 [validation.md](validation.md).

## 임시 도구·실행 환경

- Java `/tmp/schedule-tools/jdk-17.0.21+9`
- Gradle `/tmp/schedule-tools/gradle-8.14.3/bin/gradle`
- 기존 Gradle 캐시 `/home/lyrica/.gradle`는 읽기만 가능. 이번 실패 시도에서 지정한 writable 캐시 `/tmp/schedule-tools/gradle-home`는 미완성.
- 수동 컴파일 의존성 `/tmp/schedule-tools/verification-jars`, classpath `/tmp/schedule-tools/verification-classpath.txt`.
- 직접 컴파일 결과 `/tmp/schedule-tools/verification-classes`, `/tmp/schedule-tools/verification-tests`.
- JUnit 콘솔 `/tmp/schedule-tools/verification-jars/junit-platform-console-standalone-1.12.2.jar`.
- 기존 로컬 PostgreSQL18 `/tmp/schedule-tools/pg/usr/lib/postgresql/18/bin`, 라이브러리 `LD_LIBRARY_PATH=/tmp/schedule-tools/pg/usr/lib/x86_64-linux-gnu`.
- 기존 pgdata `/tmp/schedule-tools/pgdata`, localhost 포트55432, DB schedule_test, user lyrica, trust auth. 운영과 별도인 임시 테스트 DB. 이번 시작 시도는 실패하여 서버가 실행되지 않음.
- 배포/CI는 PostgreSQL17이다. PG18 결과를 PG17 검증으로 주장하지 말 것.
- `.git`은 내용 없는 읽기 전용 디렉터리이며 git status는 not a git repository. init/commit/push 수행 안 함.

## 다음 작업 우선순위

1. 소켓 사용 가능한 검증 환경에서 전용 PostgreSQL17 DB와 Java17/Gradle8.14.3을 준비하고 `gradle --no-daemon test bootJar` 실행. DB_URL, DB_USERNAME, DB_PASSWORD만 테스트 DB로 공급하면 통합 테스트가 별도 스키마 생성/정리 및 Discord 대체를 수행한다. 실제 비밀값 사용 금지.
2. 통합 테스트 실패 수정. 특히 Spring/Flyway 초기화, PG 쿼리와 잠금, concurrent claim, active sender SKIP LOCKED, 오래된 attempt fence, 결과 저장 실패 뒤 UNKNOWN 복구 확인. 지금은 코드 작성과 직접 컴파일만 완료한 상태다.
3. 별도 개발 DB, WORKER_ENABLED=false로 bootJar 기동 후 실제 브라우저 CRUD·CSRF·서울 시각·알림 이력 확인. `node scripts/frontend_smoke.cjs`는 실제 브라우저 검증을 대체하지 않는다.
4. Docker build 및 PG17 GitHub CI. 사용자가 CI/CD와 Argo 등록·/day 라우팅을 요청했다. 현재는 환경 제한 때문에 로컬 구현·검증과 등록 패치 준비까지만 수행했다.
5. 실제 GHCR 전체 SHA 이미지 게시와 CI의 deploy/kustomization.yaml 갱신을 확인하고 등록 패치를 적용한다. 필요하면 prepare_deployment.py로 별도 검토 번들을 생성한다. 가짜 SHA로 활성 배포 파일을 만들지 말 것. ESO/스토리지 사전조건 확인 후 기존 GitOps 등록 순서 준수.
6. 결과를 README/validation/HANDOFF에 갱신.

## 재개 프롬프트

`docs/HANDOFF.md와 docs/validation.md를 읽고 미실행인 PostgreSQL 통합 테스트와 실제 앱 기동 검증부터 이어서 진행해. 구현 소스와 직접 컴파일·단위 테스트 결과를 전체 빌드 완료로 오해하지 마. 기존 GitOps 규칙을 지키고 실제 비밀값이나 기존 PV/PVC를 건드리지 마.`
