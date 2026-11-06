#!/usr/bin/env python3
"""Prepare a reviewable bundle; never contact Git, AWS, registries or Kubernetes."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
IMAGE = re.compile(r"ghcr\.io/[a-z0-9][a-z0-9_.-]*/[a-z0-9][a-z0-9_./-]*:[0-9a-f]{40}")
REPO = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git")


def validate_image(image):
    if not IMAGE.fullmatch(image):
        raise ValueError("image must be ghcr.io/owner/image:<full 40-character lowercase commit SHA>")
    return image.rsplit(":", 1)


def prepare(repo, image, output):
    name, sha = validate_image(image)
    if not REPO.fullmatch(repo):
        raise ValueError("repo must be the real HTTPS GitHub repository URL ending in .git")
    output = Path(output).resolve()
    # Stage only in this explicitly unwatched local directory.
    staging = ROOT / "scripts" / ".prepared"
    if output == staging or staging not in output.parents:
        raise ValueError("output must be a new directory beneath scripts/.prepared/")
    if output.exists():
        raise ValueError("output already exists; choose a new directory")
    config = json.loads((ROOT / "deploy/kustomization.yaml").read_text())
    if name != config["images"][0]["name"]:
        raise ValueError("image repository differs from the deploy configuration")
    resources = config["resources"]
    bundle = output / "deploy"
    bundle.mkdir(parents=True)
    for resource in resources:
        (bundle / resource).write_text((ROOT / "deploy" / resource).read_text())
    config["images"][0]["newTag"] = sha
    config["replicas"] = [{"name": "schedule", "count": 2}]
    (bundle / "kustomization.yaml").write_text(json.dumps(config, indent=2) + "\n")
    registration = {"appName": "schedule", "repoURL": repo, "targetRevision": "main",
                    "manifest_path": "deploy", "namespace": "schedule"}
    (output / "schedule.json").write_text(json.dumps(registration, indent=2) + "\n")
    return bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-url", required=True)
    parser.add_argument("--image", required=True, help="An already-published real GHCR image with full commit SHA")
    parser.add_argument("--output", required=True, help="New directory under scripts/.prepared/")
    args = parser.parse_args()
    try:
        print(prepare(args.repo_url, args.image, args.output))
    except ValueError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
