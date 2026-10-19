---
description: 查看本地 WorkBuddy bridge 与会话捕获状态
---

先调用 `capture_status`，再调用 `bridge_health`，把结果整理成四行：
运行状态、会话来源、会话过期时间、上游地址。

如果 `captured` 为 false：提示用户在设置页点「开始抓包」（会重启客户端并注入 `HTTP_PROXY`，
不写注册表），等 WorkBuddy 重新打开后在里面发一条消息，然后重新检查。

如果 `expired` 为 true：提示用户再发一条消息让客户端刷新 token。
