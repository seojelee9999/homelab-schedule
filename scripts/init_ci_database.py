#!/usr/bin/env python3
"""Run the exact production initialization against an explicitly configured CI DB."""
import os
from pathlib import Path
import subprocess
import yaml

if os.environ.get("CI") != "true":
    raise SystemExit("This initializer is only for the disposable CI PostgreSQL service (CI=true).")
for key in ("PGHOST", "PGPORT", "POSTGRES_USER", "PGPASSWORD", "DB_PASSWORD"):
    if not os.environ.get(key):
        raise SystemExit("Missing explicit CI database environment: " + key)
root = Path(__file__).resolve().parents[1]
docs = yaml.safe_load_all((root / "deploy/postgres.yaml").read_text())
config = next(d for d in docs if d["kind"] == "ConfigMap")
subprocess.run(["bash", "-euo", "pipefail"], input=config["data"]["01-create-app.sh"], text=True, check=True)
env = dict(os.environ, PGUSER="schedule_app", PGDATABASE="schedule", PGPASSWORD=os.environ["DB_PASSWORD"])
result = subprocess.check_output(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c",
    "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname = current_user"],
    env=env, text=True).strip()
if result != "f":
    raise SystemExit("Application role unexpectedly privileged")
subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-c",
    "BEGIN; CREATE TABLE public.ci_privilege_check(id integer); ROLLBACK;"], env=env, check=True)
print("Production init created the restricted app role with schema write access.")
