# 검증 기록 — 2026-11-06 재개 작업

## 이번 작업에서 통과

- **Java 17 직접 컴파일**: main/test 소스 전체. `javac --release 17 -parameters` 사용. Spring Boot 3.5.16 BOM에 맞는 컴파일 의존성을 Maven Central에서 `/tmp/schedule-tools/verification-jars`에 받아 사용했다. Gradle 빌드 성공과는 구분한다.
- **DiscordClientTest 7개**: JUnit Platform Console 1.12.2에서 성공 7 / 실패 0. 실제 네트워크 전송 없이 주입한 transport로 확인했다.
  - 성공 메시지 ID, 알림 ID, 서울 시각, wait=true, mentions 차단.
  - 429 소수 초·헤더 fallback, 유효하지 않은 재시도 시간.
  - 불명확한 2xx·3xx·408·5xx 및 메시지 ID 누락의 UNKNOWN 처리.
  - 4xx 거절, transport 예외의 비밀값 비노출, interrupt 보존, URL 검증.
- **프런트엔드**: `node --check src/main/resources/static/app.js`, `node scripts/frontend_smoke.cjs` 통과. 실제 app.js에 API 형태의 fixture를 공급하여 서울 수정 시각, 삭제된 일정의 due_at 표시, 중첩 attempts 메시지 ID·발송 시각, RATE_LIMITED 문구, 제목의 텍스트 렌더링을 확인했다. 실제 브라우저/E2E 검증은 아니다.
- **배포 규칙**: `python3 scripts/validate_deployment.py` 통과. 템플릿 렌더링, PVC/Namespace 보호, Secret 참조, probes, 보안 설정, image updater, CI 셸 구문을 확인했다. 클러스터 접근 없음.

## 작성·컴파일했지만 미실행

`ScheduleIntegrationTest`의 PostgreSQL 통합 테스트 **11개**:

- CRUD, 서울 시각 변환, 낙관적 버전 충돌, 수정·삭제 시 이전 예약 취소.
- 실제 세션 CSRF 토큰, 토큰 없는 변경 요청의 403, 정적 페이지 제공.
- 제목·메모 길이, 공백 제목, 알림 시각 검증.
- 별도 작업자 두 개의 동시 선점에서 단일 전송 및 JSON 이력.
- 오래된 선점의 재시작 복구, 수동 재시도 동의, 이전 attempt 발송 차단.
- 복구 전 만료된 선점의 전송 차단.
- SENDING/UNKNOWN의 수정·삭제 차단, 재전송 없이 종료.
- 429 재예약과 UNKNOWN의 자동 재전송 방지.
- FAILED의 수동 재예약과 일정 변경에 따른 취소.
- HTTP 진행 중 잠긴 행을 복구 작업자가 건너뛰는 동작.
- HTTP 성공 후 DB 결과 기록 실패 시 durable SENDING 유지와 UNKNOWN 복구.

매번 고유한 `schedule_it_<UUID>` 스키마를 만들고 그 스키마만 정리한다. 전용 테스트 DB를 사용해야 한다. Discord는 mock으로 대체하고 예약 폴링은 비활성화한다. CI의 기존 PG17 환경변수와 연결된다.

## 실행 차단 및 남은 검증

- Gradle compileJava는 빌드 시작 전에 `Could not determine a usable wildcard IP for this machine` 오류로 실패했다. 현재 샌드박스의 소켓 제한 때문이다.
- 임시 로컬 PG18 시작은 `could not create IPv4 socket ... Operation not permitted`로 실패했다. 이 세션에서 PostgreSQL 서버는 기동되지 않았다.
- 따라서 **Gradle test/bootJar, PG17/PG18 통합 테스트, 실제 앱 기동·UI/API 연동은 미검증**이다. Java 직접 컴파일과 단위 테스트를 해당 검증의 대체 증거로 주장하지 않는다.
- Docker 도구 없음: container build 미실행.
- GitHub CI 실행, GHCR 게시, 실제 Discord 전송, 클러스터 상태 확인·배포 미실행.
- 이전 세션의 임시 PG18 운영 init 스크립트·비관리자 계정 검증 기록은 유지하되, 이번 알림 작업자의 PostgreSQL 검증 증거는 아니다.

## 다음 실행

소켓과 Gradle 캐시 쓰기가 허용된 환경에서 Java 17 / Gradle 8.14.3 / PostgreSQL 17을 준비한다. DB_URL, DB_USERNAME, DB_PASSWORD는 전용 테스트 DB로 설정한다. 통합 테스트는 worker와 Discord를 자체적으로 비활성화·대체하므로 실제 웹훅 비밀값을 공급하지 않는다.

```bash
gradle --no-daemon test bootJar
node scripts/frontend_smoke.cjs
python3 scripts/validate_deployment.py
```

이후 별도 개발 DB와 WORKER_ENABLED=false로 bootJar를 기동하여 브라우저 CRUD·이력을 확인하고, 컨테이너 및 PG17 CI 검증으로 이어간다. 전체 후속 순서는 [HANDOFF](HANDOFF.md)를 따른다.


## 추가 CI/CD·deploy·/day 작업

- deploy/ 실제 YAML과 Kustomize 렌더링 통과. /day redirect/rewrite, Gateway/Service 참조, 쿠키 이름·경로·Secure, PVC 보존, ESO 참조, bootstrap 앱 replicas=0 및 게시 후 replicas=2 갱신 검증 포함.
- /day/와 로컬 /에서 frontend_smoke.cjs 통과. JavaScript 구문 검증 통과.
- homelab-argocd 등록 패치의 git apply --check 통과. 원본 저장소는 읽기 전용이므로 실제 파일 추가·commit·push하지 않았다.
- GitHub SSH 조회는 Temporary failure in name resolution으로 실패. 실제 원격 상태와 CI 실행은 확인하지 못했다.
- CI에 PG17 test/bootJar, 실제 컨테이너 CSRF/CRUD smoke, 검증 이미지 artifact 게시, GitOps 갱신을 연결했다. YAML·셸 구문은 검증했으나 Docker와 실행 권한 제약으로 전체 파이프라인 실행은 미검증.
- 실제 Gateway/Route 적용과 https://akibaha.shop/day 접속은 미검증. 설정 파일 작성 완료와 서비스 운영 완료를 구분한다.
