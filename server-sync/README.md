# AnswerMaker 同步服务端

零依赖 Node 服务，只存储端到端加密的 `.amsync` 同步包（零知识：同步口令永不经过服务器）。
2026-11-26 已部署到用户服务器 111.230.147.240，对外入口为 Caddy 反代：
`https://heytiger.cn/amsync`（Caddyfile 中 `(amsync)` 片段 → 127.0.0.1:7362）。

## API 契约

| 方法 | 路径（经 Caddy 时带 /amsync 前缀，剥离后） | 说明 |
| --- | --- | --- |
| GET | /health | 无需鉴权，返回 {ok, service, version} |
| PUT | /package | Bearer 设备 Token；body 为 .amsync 原文；头 X-Device-Id / X-Device-Name（URL 编码）；保留最近 10 个版本 |
| GET | /package/latest | Bearer；返回最新包原文 + X-Package-* 头 |
| GET | /packages | Bearer；版本列表（version/设备/大小/时间） |

Token 存服务器 `data/tokens.json`（0600），首次启动自动生成默认 Token 到 `data/bootstrap-token.txt`。
审计 `data/audit.log`（JSONL，只记事件/设备/版本/大小，不记 Token 与包内容）。

## 部署

```bash
mkdir -p ~/answermaker-sync/data
cp sync-server.mjs ~/answermaker-sync/
sudo cp answermaker-sync.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now answermaker-sync
```

服务只绑 127.0.0.1:7362，对外必须经 Caddy（heytiger.cn 的 /amsync 路由）或自行放行端口直连（不推荐）。
