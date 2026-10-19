"""
mitmproxy 抓包插件：把 WorkBuddy 客户端自己的请求头交给本地 bridge。

用法：
    mitmdump -s packages/capture/mitm_addon.py --listen-port 8899

前置：
    1. bridge 已启动（默认 http://127.0.0.1:8790）
    2. 已把 mitmproxy 的 CA 装进系统信任区（见 README）
    3. WorkBuddy 走 127.0.0.1:8899（bridge 用 HTTP_PROXY 环境变量重启它，不写注册表）

它只做一件事：看到发往 copilot.tencent.com 的对话请求，就把 Authorization / X-User-Id /
Cookie 等一组头 POST 给 bridge 的 /capture/session。不修改任何请求与响应，不落盘。
"""

import hashlib
import json
import os
import pathlib
import urllib.request

BRIDGE = os.environ.get("WB_BRIDGE", "http://127.0.0.1:8790").rstrip("/")

HOSTS = (
    "copilot.tencent.com",
    "staging-copilot.tencent.com",
    "www.workbuddy.ai",
    "www.codebuddy.ai",
    "www.workbuddy.cn",
)

PATHS = ("/chat/completions", "/v3/config")

_last_hash = None


def _capture_key() -> str:
    key = os.environ.get("WB_CAPTURE_KEY")
    if key:
        return key.strip()
    here = pathlib.Path(__file__).resolve()
    candidate = here.parent.parent / "bridge" / ".capture-key"
    if candidate.exists():
        return candidate.read_text(encoding="utf-8").strip()
    raise RuntimeError("找不到抓包密钥：设置 WB_CAPTURE_KEY，或确认 bridge 已生成 .capture-key")


def _post(payload: dict) -> None:
    req = urllib.request.Request(
        BRIDGE + "/capture/session",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "x-capture-key": _capture_key()},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        resp.read()


class Capture:
    def request(self, flow) -> None:
        global _last_hash

        host = flow.request.pretty_host
        if not any(host == h or host.endswith("." + h) for h in HOSTS):
            return
        if not any(p in flow.request.path for p in PATHS):
            return

        headers = {k.lower(): v for k, v in flow.request.headers.items()}
        auth = headers.get("authorization", "")
        if not auth:
            return

        # 同一个 token 只上报一次，避免每个请求都打一次本地 HTTP
        digest = hashlib.sha256(auth.encode("utf-8")).hexdigest()
        if digest == _last_hash:
            return

        try:
            _post({"headers": headers, "source": "mitmproxy", "path": flow.request.path})
            _last_hash = digest
            print(f"[capture] session captured from {host}{flow.request.path}")
        except Exception as exc:  # noqa: BLE001
            print(f"[capture] post failed: {exc}")

    def response(self, flow) -> None:
        # 401 时清掉缓存，让下一次请求重新上报（通常是客户端刚刷新了 token）
        global _last_hash
        if flow.response and flow.response.status_code == 401:
            _last_hash = None


addons = [Capture()]
