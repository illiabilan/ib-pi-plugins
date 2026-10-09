"""mitmproxy addon: serve fixture files for one URL, switchable at runtime.

Env:
  VQA_FIXTURES  directory with <name>.json fixtures
  VQA_MATCH     substring of the request URL to mock
  VQA_CURRENT   file holding the current fixture name ("passthrough" | "404" | "<name>")
  VQA_LOG       request/decision log
  VQA_NEEDLES   optional comma separated strings: requests whose body contains one are logged (telemetry slice)
"""
import os
import time

from mitmproxy import http

FIXTURES = os.environ.get("VQA_FIXTURES", ".")
MATCH = os.environ.get("VQA_MATCH", "")
CURRENT = os.environ.get("VQA_CURRENT", "/tmp/vqa-current-fixture")
LOG = os.environ.get("VQA_LOG", "/tmp/vqa-proxy.log")
NEEDLES = [n for n in os.environ.get("VQA_NEEDLES", "").split(",") if n]


def _current():
    try:
        with open(CURRENT) as f:
            return f.read().strip() or "passthrough"
    except OSError:
        return "passthrough"


def _log(line):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {line}\n")


def request(flow: http.HTTPFlow) -> None:
    url = flow.request.pretty_url
    if NEEDLES:
        body = flow.request.get_text(strict=False) or ""
        hits = [n for n in NEEDLES if n in body]
        if hits:
            _log(f"NEEDLE {flow.request.method} {url[:200]} hits={hits} body={body[:1500]}")
    if not MATCH or MATCH not in url:
        return
    fx = _current()
    _log(f"MATCH {flow.request.method} {url} fixture={fx} body={flow.request.get_text(strict=False)}")
    if fx == "passthrough":
        return
    if fx == "404":
        flow.response = http.Response.make(404, b'{"error":"not found (mock)"}', {"Content-Type": "application/json"})
        _log("  -> mocked 404")
        return
    path = os.path.join(FIXTURES, fx + ".json")
    try:
        with open(path, "rb") as f:
            content = f.read()
    except OSError as e:
        flow.response = http.Response.make(404, b'{"error":"fixture missing"}', {"Content-Type": "application/json"})
        _log(f"  -> fixture missing {path}: {e}")
        return
    flow.response = http.Response.make(200, content, {"Content-Type": "application/json; charset=utf-8"})
    _log(f"  -> mocked 200 from {fx}.json ({len(content)} bytes)")
