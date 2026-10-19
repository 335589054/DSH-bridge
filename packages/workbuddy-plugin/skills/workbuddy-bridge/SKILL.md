---
name: workbuddy-bridge
description: 查看和排查本机 WorkBuddy 模型桥（WorkBuddy LLM Bridge）与会话捕获。当用户问「DSH 里 WorkBuddy 模型连不上」「bridge 状态」「会话没抓到」「WorkBuddy 模型列表」时使用。
---

# WorkBuddy 模型桥与会话捕获

本机 `127.0.0.1:8790` 上运行着一个把 WorkBuddy 订阅模型导出为 OpenAI 兼容接口的桥，
DeepSeek Harness（DSH）通过 `workbuddy` 路由调用它。**桥不读登录文件、不申请 API Key**，
凭证来自本机抓包：客户端自己发请求时带的 `Authorization` / `X-User-Id` 被捕获后复用。

## 排查顺序

1. 调 `capture_status`：
   - `captured: false` → 抓包没生效，走第 2 步。
   - `expired: true` → 会话过期，让客户端再发一条消息刷新。
2. 检查抓包链路：mitmproxy 是否在跑、客户端是否已被接管（`HTTP_PROXY` → `127.0.0.1:8899`）、CA 是否已信任。
   在 WorkBuddy 里发一条消息即可触发捕获。
3. 调 `bridge_health`：确认 `ok`、`mode`、`auth.type = captured`、`error`。
4. `ok: true` 但 DSH 调用失败 → 看错误码：401 会话过期、429 上游限流、
   10085 标识头缺失、11140 账号被风控。
5. 调 `bridge_models`：确认目标模型 id 在当前账号的目录里。

## 边界

- 桥与抓包层只监听回环地址，不对外暴露。
- 不要把令牌、请求头原文写进日志或对话。
- 抓包只用于获取自己账号的会话，不做多账号池化或对外服务。
- embedding 不支持，`/v1/embeddings` 固定 501。
