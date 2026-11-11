#!/usr/bin/env python3
"""Exercise the local CI container's HTTP/CSRF/CRUD contract. No Discord calls."""
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar
import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener

BASE = "http://127.0.0.1:18080"
cookies = CookieJar()
client = build_opener(HTTPCookieProcessor(cookies))


def request(path, method="GET", body=None, token=None):
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers[token["headerName"]] = token["token"]
    req = Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
    with client.open(req, timeout=5) as response:
        data = response.read()
        return json.loads(data) if data else None


def main():
    for attempt in range(60):
        try:
            if request("/actuator/health/readiness")["status"] == "UP":
                break
        except (URLError, TimeoutError):
            pass
        time.sleep(1)
    else:
        raise AssertionError("CI container did not become ready")
    with client.open(BASE + "/", timeout=5) as response:
        html = response.read().decode()
        assert 'href="./style.css"' in html and 'src="./app.js"' in html
    for path in ("/style.css", "/app.js"):
        with client.open(BASE + path, timeout=5) as response:
            assert response.status == 200
    later = (datetime.now(timezone(timedelta(hours=9))) + timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0, tzinfo=None)
    body = {"title": "CI schedule", "description": "Disposable CI DB only", "startsAt": (later + timedelta(hours=1)).isoformat(), "endsAt": (later + timedelta(hours=2)).isoformat()}
    try:
        request("/api/schedules", "POST", body)
        raise AssertionError("Mutation without CSRF was accepted")
    except HTTPError as error:
        assert error.code == 403
    token = request("/api/csrf")
    schedule_id = request("/api/schedules", "POST", body, token)["id"]
    version = 1
    try:
        row = next(row for row in request("/api/schedules") if row["id"] == schedule_id)
        actual = datetime.fromisoformat(row["starts_at"].replace("Z", "+00:00"))
        assert actual == (later + timedelta(hours=1)).replace(tzinfo=timezone(timedelta(hours=9)))
        history = [row for row in request("/api/notifications") if row["schedule_id"] == schedule_id]
        assert len(history) == 1 and history[0]["status"] == "PENDING"
        request("/api/schedules/" + schedule_id, "PUT", dict(body, title="Updated CI schedule", version=1), token)
        version = 2
        try:
            request("/api/schedules/" + schedule_id + "?version=1", "DELETE", token=token)
            raise AssertionError("Stale delete was accepted")
        except HTTPError as error:
            assert error.code == 409
    finally:
        request("/api/schedules/" + schedule_id + "?version=" + str(version), "DELETE", token=token)
    assert all(row["id"] != schedule_id for row in request("/api/schedules"))
    print("PASS: container readiness, relative assets, CSRF session, CRUD, Seoul timestamps and stale version conflict")


if __name__ == "__main__":
    main()
