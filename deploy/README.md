# Schedule 배포 · https://akibaha.shop/day/

이 디렉터리는 Argo CD가 감시할 **실제 Kustomize 경로**이다. 기존 `~/diet-app`의 CI/GHCR/GitOps 방식과 `~/homelab-argocd`의 ApplicationSet·Envoy Gateway 구성을 따른다.

## 리소스

| 파일 | 역할 |
| --- | --- |
| namespace.yaml | schedule 네임스페이스, prune/delete 보호 |
| app.yaml | 앱 ClusterIP Service 8080, Deployment 2개, probes, /day 세션 쿠키 |
| postgres.yaml | PostgreSQL17 StatefulSet 1개, 초기화 ConfigMap, headless Service, 별도10Gi PVC |
| secrets.yaml | 앱 DB/Discord와 별도 DB 관리자 비밀번호 ExternalSecret |
| ghcr.yaml | 기존 GHCR SSM 값을 사용하는 imagePullSecret |
| httproute.yaml | akibaha.shop/day → 기존 tunnel-gateway → schedule:8080 |
| kustomization.yaml | 이미지 SHA 및 최초 활성화 설정. JSON은 유효한 YAML이다. |

`bootstrap`은 실제 게시 이미지가 아니다. 초기 Kustomize override는 앱 replicas=0이며, **이미지 게시에 성공한 CI만 실제 전체 SHA와 replicas=2를 함께 반영**한다. PostgreSQL은 별도로1개이므로 등록 전에 SSM·스토리지 준비를 마쳐야 한다.

## CI/CD

PR은 테스트만, main push와 main 대상 workflow_dispatch는 테스트 후 게시·배포 설정 갱신까지 수행한다.

1. Java17 / Gradle8.14.3 / PostgreSQL17. 운영과 같은 init 스크립트로 schedule_app 비관리자 계정과 전용 CI DB를 생성한다.
2. `gradle test bootJar`: 통합 테스트는 고유한 schema를 생성·정리하며 Discord mock을 사용한다.
3. UI mock smoke를 /day/와 로컬 / 양쪽에서 실행하고 `kubectl kustomize deploy` 및 배포 규칙을 검사한다.
4. 읽기 전용 컨테이너를 실제 CI PostgreSQL에 연결하여 readiness, 상대 정적 파일, CSRF 세션, CRUD, 서울 시각, 버전 충돌을 검사한다. WORKER_ENABLED=false이므로 실제 Discord 전송은 없다.
5. 통과한 컨테이너 이미지를 artifact로 보존한다. publish job은 이 이미지를 그대로 로드하여 `ghcr.io/seojelee9999/homelab-schedule:<전체 소스 SHA>`로 게시한다.
6. 게시 성공 후 deploy/kustomization.yaml만 갱신·commit/push한다. 더 최신 소스/config 커밋이 있으면 오래된 배포 반영을 건너뛴다. push 경쟁은 fast-forward 거부 후 재검사하며 force push하지 않는다.
7. Argo CD가 main의 deploy 경로를 자동 sync/prune/selfHeal한다. 이미지 갱신만 있는 커밋은 CI를 다시 시작하지 않는다.

GitHub Actions에는 packages:write와 contents:write 권한이 필요하다. main branch protection이 봇의 갱신 커밋을 막는 경우 해당 정책에 맞게 배포 변경 경로를 허용해야 한다. 테스트·게시 실패 시 GitOps 이미지 값은 갱신하지 않는다.

## 최초 등록 순서

1. 기존 `longhorn-database` StorageClass(Retain, Longhorn replica2), ESO v1, `aws-parameter-store` ClusterSecretStore, 스토리지 여유를 확인한다. 기존 PV/PVC를 삭제·재사용하지 않는다.
2. 기존 SSM SecureString 절차로 다음 값을 준비한다. 실제 값은 Git/로그에 넣지 않는다.

   - /homelab/schedule/DB_PASSWORD
   - /homelab/schedule/POSTGRES_ADMIN_PASSWORD (앱 DB 비밀번호와 분리)
   - /homelab/schedule/DISCORD_WEBHOOK_URL

   기존 /homelab/ghcr/GHCR_USERNAME, /homelab/ghcr/GHCR_TOKEN도 읽을 수 있어야 한다. ESO의 AWS identity에 읽기·복호화 권한이 필요하다. SSM 값은 이번 작업에서 생성하지 않았다.
3. 소스를 `https://github.com/seojelee9999/homelab-schedule.git` main에 반영한다. CI 성공과 deploy/kustomization.yaml의 실제 SHA 및 count=2를 확인한다. GHCR 이미지가 존재하고 pull 가능한지 확인한다.
4. `gitops/homelab-argocd.patch`를 homelab 저장소에 적용한다. 기존 ApplicationSet이 apps/*.json을 읽으므로 ApplicationSet 본체를 수정할 필요가 없다.

```bash
# 원격 최신 상태와 로컬 변경을 먼저 확인
git -C ~/homelab-argocd status --short
git -C ~/homelab-argocd apply --check /home/lyrica/schedule/gitops/homelab-argocd.patch
git -C ~/homelab-argocd apply /home/lyrica/schedule/gitops/homelab-argocd.patch
git -C ~/homelab-argocd add apps/schedule.json
git -C ~/homelab-argocd commit -m "Register schedule application"
git -C ~/homelab-argocd push origin main
```

등록 내용은 appName=schedule, repoURL=https://github.com/seojelee9999/homelab-schedule.git, targetRevision=main, manifest_path=deploy, namespace=schedule이다. Argo CD의 기존 저장소 자격증명이 새 HTTPS repoURL에도 읽기 권한을 가져야 한다. 이 패치는 현재 로컬 homelab 저장소에서 apply --check만 검증했으며 실제 적용·push하지 않았다.

## /day 라우팅

- 브라우저 `https://akibaha.shop/day` →302→ `https://akibaha.shop/day/`.
- `/day/`, `/day/app.js`, `/day/api/schedules` →접두사 제거→ 앱의 `/`, `/app.js`, `/api/schedules`.
- HTTPRoute는 schedule 네임스페이스의 Service를 참조하고, gateway-system/tunnel-gateway의 http listener에 연결한다. 기존 Gateway는 allowedRoutes.namespaces.from=All이므로 추가 ReferenceGrant나 Gateway 복제본은 필요하지 않다.
- Route는 앱 저장소의 deploy/에서 소유한다. homelab의 gateway-resources에 같은 Route를 중복 추가하지 않는다.
- 기존 Cloudflare Tunnel의 akibaha.shop origin이 Envoy Service를 향해야 한다. TLS는 Cloudflare에서 종료하며 내부 Gateway는 HTTP80이다. /day redirect에 HTTPS443을 명시하여 내부 HTTP 주소로 이동하지 않게 한다.
- 프런트엔드는 문서 경로에 상대적인 정적 파일/API 주소를 사용한다. 배포 세션 쿠키는 DAYSESSION, Path=/day, Secure, SameSite=lax다.

**현재 앱은 로그인 없는 공유 일정이다.** 이 경로에 접근 가능한 사용자는 일정을 조회·변경할 수 있다. CSRF 보호는 사용자 인증을 대신하지 않는다.

```bash
kubectl -n argocd get application schedule
kubectl -n schedule get externalsecrets,pvc,pods
kubectl -n schedule rollout status statefulset/schedule-postgres
kubectl -n schedule rollout status deployment/schedule
kubectl -n schedule describe httproute schedule
curl -I https://akibaha.shop/day
curl -I https://akibaha.shop/day/
```

Route의 Accepted/ResolvedRefs, Gateway의 Programmed 상태를 확인한다. 실제 브라우저에서 정적 파일·CSRF 요청이 /day/ 아래에 머무르고 일정 CRUD가 동작하는지 확인한다.

## 저장소와 운영

PVC와 Namespace는 Prune=false,Delete=false이며 StatefulSet은 독립 PVC를 참조한다. 직접 Namespace/PVC를 삭제하지 않는다. PostgreSQL major 버전 변경에는 별도 마이그레이션이 필요하다. DB 초기화는 빈 PGDATA에서만 실행되므로 SSM 비밀번호 변경만으로 DB 계정 비밀번호는 바뀌지 않는다. SQL 역할 비밀번호·SSM·ESO·Pod 재시작을 함께 조율해야 한다. Longhorn 복제는 DB 백업을 대신하지 않는다.

검토용 별도 번들이 필요하면 이미 게시된 실제 이미지로만 생성한다. 스크립트는 이미지 존재 여부를 확인하지 않는다.

```bash
python3 scripts/prepare_deployment.py \
  --repo-url https://github.com/seojelee9999/homelab-schedule.git \
  --image "$APP_IMAGE" --output scripts/.prepared/review
kubectl kustomize scripts/.prepared/review/deploy
python3 scripts/validate_deployment.py
```

현재 환경에서는 Docker/클러스터/CI 실행을 검증하지 못했다. 상세 결과는 [validation](../docs/validation.md)에 기록한다.
