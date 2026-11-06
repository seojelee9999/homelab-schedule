#!/usr/bin/env python3
"""Local rendering and deployment contract checks. Never accesses the cluster."""
import ast
import json
from pathlib import Path
import subprocess
import tempfile
import yaml
from prepare_deployment import ROOT, prepare, validate_image
from update_image import update


def rejected(call):
    try:
        call()
    except ValueError:
        return
    raise AssertionError("unsafe input was accepted")


def check_resources(documents):
    docs = {(d["kind"], d["metadata"]["name"]): d for d in documents if d}
    assert not any(kind in {"StorageClass", "PersistentVolume", "Ingress", "Gateway", "GatewayClass"} for kind, _ in docs)
    for key in [("Namespace", "schedule"), ("PersistentVolumeClaim", "schedule-postgres-data")]:
        options = docs[key]["metadata"]["annotations"]["argocd.argoproj.io/sync-options"]
        assert {"Prune=false", "Delete=false"} <= set(options.split(","))
    for (kind, _), document in docs.items():
        if kind != "Namespace":
            assert document["metadata"]["namespace"] == "schedule"
    pvc = docs[("PersistentVolumeClaim", "schedule-postgres-data")]["spec"]
    assert pvc["storageClassName"] == "longhorn-database"
    assert pvc["resources"]["requests"]["storage"] == "10Gi"
    app = docs[("Deployment", "schedule")]["spec"]
    pod = app["template"]["spec"]
    assert not pod.get("nodeSelector") and not pod.get("nodeName")
    assert pod["terminationGracePeriodSeconds"] >= 30
    assert pod["securityContext"]["runAsUser"] == 10001
    container = pod["containers"][0]
    if container["image"].endswith(":bootstrap"):
        assert app["replicas"] == 0, "bootstrap must never start an unpublished app image"
    else:
        validate_image(container["image"])
        assert app["replicas"] == 2
    assert container["securityContext"]["readOnlyRootFilesystem"]
    assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
    env = {entry["name"]: entry for entry in container["env"]}
    assert env["DB_URL"]["value"] == "jdbc:postgresql://schedule-postgres:5432/schedule"
    assert env["DB_USERNAME"]["value"] == "schedule_app"
    assert "POSTGRES_ADMIN_PASSWORD" not in env
    for key, expected in {"NAME": "DAYSESSION", "PATH": "/day", "SECURE": "true", "SAMESITE": "lax"}.items():
        assert env["SERVER_SERVLET_SESSION_COOKIE_" + key]["value"] == expected
    assert container["ports"][0]["containerPort"] == 8080
    for probe, suffix in [("startupProbe", "liveness"), ("livenessProbe", "liveness"), ("readinessProbe", "readiness")]:
        assert container[probe]["httpGet"]["path"] == "/actuator/health/" + suffix
    db = docs[("StatefulSet", "schedule-postgres")]["spec"]
    assert db["replicas"] == 1 and "volumeClaimTemplates" not in db
    dbpod = db["template"]["spec"]
    assert dbpod["containers"][0]["image"] == "postgres:17"
    assert dbpod["volumes"][0]["persistentVolumeClaim"]["claimName"] == "schedule-postgres-data"
    db_env = {entry["name"]: entry for entry in dbpod["containers"][0]["env"]}
    assert db_env["POSTGRES_PASSWORD"]["valueFrom"]["secretKeyRef"]["name"] == "schedule-postgres-admin"
    assert db_env["DB_PASSWORD"]["valueFrom"]["secretKeyRef"]["name"] == "schedule-app"
    paths = set()
    for (kind, _), document in docs.items():
        if kind == "ExternalSecret":
            assert document["apiVersion"] == "external-secrets.io/v1"
            assert document["spec"]["secretStoreRef"] == {"name": "aws-parameter-store", "kind": "ClusterSecretStore"}
            paths.update(entry["remoteRef"]["key"] for entry in document["spec"]["data"])
    assert paths == {"/homelab/schedule/DB_PASSWORD", "/homelab/schedule/POSTGRES_ADMIN_PASSWORD",
                     "/homelab/schedule/DISCORD_WEBHOOK_URL", "/homelab/ghcr/GHCR_USERNAME", "/homelab/ghcr/GHCR_TOKEN"}
    init = docs[("ConfigMap", "schedule-postgres-init")]["data"]["01-create-app.sh"]
    subprocess.run(["bash", "-n"], input=init, text=True, check=True)
    assert "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" in init
    assert "PASSWORD :'app_password'" in init
    route = docs[("HTTPRoute", "schedule")]["spec"]
    assert route["parentRefs"] == [{"group": "gateway.networking.k8s.io", "kind": "Gateway",
                                    "name": "tunnel-gateway", "namespace": "gateway-system", "sectionName": "http"}]
    assert route["hostnames"] == ["akibaha.shop"]
    redirect, rewrite = route["rules"]
    assert redirect["matches"] == [{"path": {"type": "Exact", "value": "/day"}}]
    assert redirect["filters"] == [{"type": "RequestRedirect", "requestRedirect": {
        "scheme": "https", "port": 443, "path": {"type": "ReplaceFullPath", "replaceFullPath": "/day/"}, "statusCode": 302}}]
    assert rewrite["matches"] == [{"path": {"type": "PathPrefix", "value": "/day"}}]
    assert rewrite["filters"] == [{"type": "URLRewrite", "urlRewrite": {
        "path": {"type": "ReplacePrefixMatch", "replacePrefixMatch": "/"}}}]
    assert rewrite["backendRefs"] == [{"group": "", "kind": "Service", "name": "schedule", "port": 8080, "weight": 1}]
    return container


def main():
    for path in (ROOT / "scripts").glob("*.py"):
        ast.parse(path.read_text(), filename=str(path))
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    # Parse every multiline shell step without executing it.
    for job in workflow["jobs"].values():
        for step in job["steps"]:
            if "run" in step:
                subprocess.run(["bash", "-n"], input=step["run"], text=True, check=True)
    for bad in ["ghcr.io/check/schedule:latest", "ghcr.io/check/schedule:abc", "docker.io/check/schedule:" + "a"*40]:
        rejected(lambda: validate_image(bad))
    rejected(lambda: prepare("https://github.com/check/schedule.git", "ghcr.io/check/schedule:" + "a"*40, ROOT / "deploy" / "unsafe"))
    staging = ROOT / "scripts/.prepared"
    staging.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="validation-", dir=staging) as work:
        # Synthetic inputs are used only in this disposable test directory.
        image = "ghcr.io/seojelee9999/homelab-schedule:" + "a"*40
        bundle = prepare("https://github.com/validation-only/schedule.git", image, Path(work) / "bundle")
        rendered = subprocess.check_output(["kubectl", "kustomize", str(bundle)], text=True)
        container = check_resources(list(yaml.safe_load_all(rendered)))
        assert container["image"] == image
        registration = json.loads((bundle.parent / "schedule.json").read_text())
        assert registration["manifest_path"] == "deploy"
        assert set(registration) == {"appName", "repoURL", "targetRevision", "manifest_path", "namespace"}
        rejected(lambda: prepare(registration["repoURL"], image, bundle.parent))
        config = bundle / "kustomization.yaml"
        before = config.read_text()
        rejected(lambda: update(config, "ghcr.io/other/image:" + "b"*40))
        assert config.read_text() == before
        next_image = "ghcr.io/seojelee9999/homelab-schedule:" + "b"*40
        update(config, next_image)
        rendered = subprocess.check_output(["kubectl", "kustomize", str(bundle)], text=True)
        assert check_resources(list(yaml.safe_load_all(rendered)))["image"] == next_image
    active = ROOT / "deploy/kustomization.yaml"
    check_resources(list(yaml.safe_load_all(subprocess.check_output(["kubectl", "kustomize", str(active.parent)], text=True))))
    registration = json.loads((ROOT / "gitops/homelab-argocd/apps/schedule.json").read_text())
    assert registration == {"appName": "schedule", "repoURL": "https://github.com/seojelee9999/homelab-schedule.git",
                            "targetRevision": "main", "manifest_path": "deploy", "namespace": "schedule"}
    # Exercise initial activation using a disposable copy; never put synthetic SHAs in deploy/.
    with tempfile.TemporaryDirectory() as work:
        path = Path(work) / "kustomization.yaml"
        path.write_text(active.read_text())
        update(path, "ghcr.io/seojelee9999/homelab-schedule:" + "c"*40)
        assert json.loads(path.read_text())["replicas"] == [{"name": "schedule", "count": 2}]
    print("PASS: deploy rendering, /day route, cookie scope, retention, secrets, bootstrap activation, registration and image update; no cluster access")


if __name__ == "__main__":
    main()
