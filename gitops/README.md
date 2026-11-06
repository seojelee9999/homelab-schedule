# homelab-argocd 등록

`homelab-argocd/apps/schedule.json`은 기존 ApplicationSet이 읽을 등록 파일이며 `homelab-argocd.patch`는 동일한 파일을 추가하는 패치이다.

대상은 `~/homelab-argocd/apps/schedule.json`이다. 현재 세션에서는 대상 디렉터리가 읽기 전용이라 변경하지 않았다. `git apply --check`는 통과했으며 실제 등록은 대상 저장소에 적용하고 main에 push한 뒤 이루어진다. 기존 사용자 변경 파일은 수정하지 않았다.

[배포 가이드](../deploy/README.md)의 최초 등록 순서를 따른다. HTTPRoute는 이 앱의 deploy/에서 함께 관리하므로 homelab gateway-resources에 중복 등록하지 않는다.
