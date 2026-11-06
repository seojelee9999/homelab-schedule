#!/usr/bin/env python3
"""Record a published SHA image and enable the two app replicas in deploy/."""
import json
from pathlib import Path
import sys
from prepare_deployment import validate_image


def update(path, image):
    name, sha = validate_image(image)
    config = json.loads(path.read_text())
    if config.get("kind") != "Kustomization" or config.get("namespace") != "schedule":
        raise ValueError("unexpected kustomization")
    images = config.get("images", [])
    if len(images) != 1 or images[0].get("name") != name or set(images[0]) != {"name", "newTag"}:
        raise ValueError("image repository differs from reviewed deployment; refusing to replace it")
    if config.get("replicas") not in ([{"name": "schedule", "count": 0}], [{"name": "schedule", "count": 2}]):
        raise ValueError("unexpected replica configuration")
    images[0]["newTag"] = sha
    config["replicas"] = [{"name": "schedule", "count": 2}]
    path.write_text(json.dumps(config, indent=2) + "\n")


if __name__ == "__main__":
    update(Path("deploy/kustomization.yaml"), sys.argv[1])
