# AnswerMaker 架构与开发状态

> 版本：0.2.0（PRD 基线 V1.1） · 更新：2026-11-26 · 平台：Windows P0（已验证）/ macOS P1（未实测）
>
> 本文档描述当前代码的真实状态，区分「已实现」「占位/模拟」「待开发」。

---

## 1. 总览

AnswerMaker 是本地 AI 中枢桌面应用：加密保险库 + RAG 知识库 + 本地文件管理 + MCP/CLI 网关 + 可切换模型的聊天区。

```
┌──────────────────────────── React 18 + TypeScript (WebView) ────────────────────────────┐
│ App.tsx                                                                                │
│  ├─ Chat（BM25/RAG、Ollama、Agent CLI、保险库卡片、文件卡片、轮次列表、纸飞机发送）        │
│  ├─ Vault（WebCrypto 加密、MCP 密钥请求授权）                                              │
│  ├─ Knowledge（文件/链接/POPO 导入、切块、溯源、导出）                                      │
│  ├─ Files（RAG/仅登记/单独新增 Tab、手动归档）                                             │
│  ├─ Mcp（真实启停、Token、自检、工具清单）                                                  │
│  └─ Settings（OpenID 状态、Ollama/Agent 环境、存储信息）                                   │
└───────────────┬───────────────────────────────┬────────────────────────────────────────┘
                │ Tauri invoke                  │ fetch
┌───────────────▼──────────────────┐   ┌────────▼─────────┐
│ Rust 后端（Tauri 2）              │   │ Ollama 11434     │
│ db.rs / mcp.rs / popo.rs          │   └──────────────────┘
│ ollama.rs / agent.rs / lib.rs     │
└──┬──────────┬──────────┬──────────┘
   │          │          └───────────── popo-cli（OpenID）/ 本地 Agent CLI
   │          │
   │          └────────── SQLite：%APPDATA%/AnswerMaker/answermaker.db（WAL）
   │
   └────────── server/data/*.json（自动导出快照）
                         │
               ┌─────────▼──────────┐        ┌────────────────────┐
               │ Node MCP 服务 :7361 │◄──────►│ 外部 AI / Agent     │
               │ 16 个工具 / Token   │        │ MCP 客户端          │
               └─────────┬──────────┘        └────────────────────┘
                         │
               ┌─────────▼──────────────────────────────┐
               │ 临时密钥文件 %TEMP%/answermaker-secrets │
               │ 需应用内授权 + 保险库解锁，TTL 自动删除  │
               └────────────────────────────────────────┘
```

### 进程与端口

| 组件 | 形态 | 地址 / 路径 |
| --- | --- | --- |
| 桌面应用 | Tauri 2 + WebView2 | 开发端口 `127.0.0.1:5173`（1420 被 Windows 保留段占用） |
| Rust 后端 | 应用内进程 | 无网络监听 |
| MCP 服务 | 独立 Node 进程（零依赖） | 默认 `0.0.0.0:7361/mcp`，占用自动 +1（最多 20 次） |
| SQLite | 应用内 rusqlite（bundled） | `%APPDATA%/AnswerMaker/answermaker.db`（WAL） |
| MCP 数据快照 | 文件 | `server/data/knowledge.json`、`vault-refs.json` |
| 密钥请求队列 | 文件 | `server/data/secret-requests/`、`secret-responses/` |
| 临时密钥文件 | 文件 | `%TEMP%/answermaker-secrets/<requestId>.json` |
| popo-cli | 外部 CLI | 由用户安装，凭据由 CLI 管理 |
| Ollama | 外部服务 | `127.0.0.1:11434` |

---

## 2. 技术栈

- **前端**：React 18、TypeScript 5、Vite 5、Font Awesome 7（solid）
- **桌面**：Tauri 2、Rust（edition 2021）、tauri-plugin-dialog
- **数据库**：SQLite（rusqlite bundled，WAL）
- **加密**：WebCrypto PBKDF2-SHA256（210,000 次）+ AES-256-GCM（每条目独立 IV）
- **检索**：本地 BM25（中文单字 + 双字 bigram；英文/数字按词）；k1=1.5、b=0.75
- **MCP**：Node 标准库实现 Streamable HTTP JSON-RPC 子集（initialize / ping / tools/list / tools/call），Bearer Token
- **CLI**：Node 标准库，入口 `cli/answermaker.mjs`（`am` / `answermaker`）
- **本地模型**：Ollama HTTP API（非流式）
- **本地 Agent**：CodeMaker / Claude Code / Codex / Gemini CLI 非交互调用

---

## 3. 目录与模块职责

```
src/
├─ App.tsx                 布局、启动加载、搜索合并、聊天发送、MCP 密钥请求轮询、Toast
├─ db.ts                   SQLite 仓储 + localStorage 首次迁移 + 浏览器回退
├─ crypto.ts               保险库 WebCrypto；密文入 SQLite；会话密钥仅内存
├─ search.ts               切块（512/80）+ 切块内存缓存 + BM25
├─ mcpSync.ts              应用数据 → server/data 自动同步（供 MCP/CLI）
├─ files.ts                文件归档去重、名称/地址检索
├─ bridge.ts               Tauri 命令封装与浏览器降级
├─ types.ts                领域类型、旧版 load/save 工具
├─ styles.css              主题（#7f71f1）、布局、滚动条、组件样式
└─ modules/
   ├─ Chat.ts              检索回复、RAG 回退、Ollama 请求、模式/模型定义
   ├─ Vault.tsx            保险库 UI、复制 JSON、改名、迁移、MCP 请求授权
   ├─ vaultSearch.ts       保险库检索（锁定仅元数据；解锁含 value/account）
   ├─ VaultHitCard.tsx     保险库命中卡片
   ├─ Knowledge.tsx        文件/链接入库、切块与 BM25、溯源、导出
   ├─ PopoImport.tsx       POPO 个人/团队空间浏览与导入（loading/重试/取消保护）
   ├─ Files.tsx            文件管理 Tab（RAG/仅登记/单独新增）+ 手动新增
   ├─ FileHitCard.tsx      文件卡片（打开/复制地址/移除）
   ├─ Mcp.tsx              MCP 控制面板（启停/Token/自检/配置/工具）
   ├─ OllamaBootstrap.tsx  启动检测、自动安装、拉起、推荐模型下载
   └─ Settings.tsx         OpenID 登录、Ollama/Agent 环境、数据与安全

src-tauri/src/
├─ lib.rs                  数据目录、vault/knowledge/chat 旧桩命令、通用命令、注册
├─ db.rs                   SQLite schema 与 9 个 db_* 命令
├─ mcp.rs                  MCP 启停/状态/Token/自检/数据同步/密钥请求（含单测）
├─ popo.rs                 popo-cli 封装（CLI_LOCK 串行、45s 超时、JSON 解析）
├─ ollama.rs               检测/安装/启动/拉模型/硬件推荐
├─ agent.rs                Agent 探测与非交互执行（白名单、240s 超时、ANSI 清理）
└─ vault_crypto.rs         Argon2id 信封加密设计（**占位，未实现**）

server/
├─ mcp-server.mjs          MCP 服务端（16 工具、Token、CORS、批量、端口顺延、密钥请求）
├─ popo-lib.mjs            POPO/KM 读取与空间浏览
└─ data/                   快照、Token、runtime、密钥请求队列（gitignored 敏感项）

cli/answermaker.mjs        CLI：vault/search/knowledge/files/link/popo/mcp
scripts/mcp-smoke.mjs      MCP 冒烟测试（20 项 / POPO 22 项）
scripts/make-icons.py      图标生成
docs/                      本文档等
```

> `src/components/` 目前为空；`types.ts` 的 `load/save` 仅剩历史兼容用途。

---

## 4. 数据架构

### 4.1 SQLite（主存储）

路径：Windows `%APPDATA%/AnswerMaker/answermaker.db`；macOS `~/Library/Application Support/AnswerMaker/answermaker.db`。WAL 模式，单连接 Mutex 串行写。

| 表 | 字段 | 说明 |
| --- | --- | --- |
| `docs` | id, data(JSON), imported_at | KnowledgeDoc 完整 JSON（含在线正文 `content`） |
| `chunks` | doc_id, idx, text | 文档切块正文，BM25 输入 |
| `files` | id, data(JSON), imported_at | 文件/链接归档 |
| `vault_meta` | id=1, data(JSON) | PBKDF2 参数、salt、校验块 |
| `vault_items` | id, data(JSON), created_at | 加密条目（value/account 为密文） |
| `meta` | key, value | 迁移标记 `migrated_from_localstorage=1` |

启动流程：

1. `db_load_all` 读取 docs/files/chunks/vault/meta
2. 若未迁移且 localStorage 有旧数据 → 逐项导入 → 写入迁移标记（localStorage 原键保留备份）
3. 切块注入 `search.ts` 内存；保险库注入 `crypto.ts` 内存
4. 渲染 UI；文档/文件变化写回 SQLite（去抖由 React 状态驱动），同时自动同步 `server/data`

### 4.2 localStorage

- **仅作为**：首次迁移的备份、浏览器预览（无 Tauri）的存储、V0.1 明文 `am_vault`（待用户迁移）
- 桌面端正常运行时不再读写 `am_docs` / `am_chunks_v2` / `am_files` / 保险库键
- 例外：POPO 浏览偏好等纯 UI 状态未迁移

### 4.3 server/data 快照

应用变化后自动写 `knowledge.json`（docs + chunks + files）与 `vault-refs.json`（仅 id/key/ref/type/url，无明文）。MCP 与 CLI 读取该快照，保证与聊天检索同一份数据、同一套 BM25。

### 4.4 临时密钥文件

- 位置：`%TEMP%/answermaker-secrets/<requestId>.json`（Unix 0600）
- 内容：单条目的 `id/key/type/account/value/url/ref` 明文 JSON
- 生命周期：用户授权时创建；TTL 15–300 秒（默认 60）；服务端与应用双向清理；`vault_secret_release` 可立即删除
- 协议响应只给路径，不给明文

---

## 5. 核心流程

### 5.1 知识入库与检索

```
文件/链接/POPO → 读取正文 → chunkText(512/80) → SQLite docs + chunks + files
                                                   │
                                      内存切块 → BM25（聊天 / 仅搜索 / RAG）
                                                   │
                                      server/data/knowledge.json → MCP/CLI
```

- 文本类：`.txt .md .csv .json .html` 真实读取；HTML 去标签
- KM/POPO：经 popo-cli 拉正文
- PDF/Word 等：仅登记元数据（无切块）
- 每条保留 `origin` 与 `importedAt`，可复制/编辑来源

### 5.2 保险库

```
主密码 → PBKDF2(210k) → AES-GCM key（仅内存）
条目 → value/account 分别加密（独立 IV）→ SQLite vault_items
检索：锁定 → key/type/url；解锁 → 额外解密 value/account
复制：本地解密 → JSON 写入剪贴板（明文不上屏）
```

### 5.3 MCP 检索对齐

- 聊天与 MCP 使用同一份 docs/chunks；BM25 实现三处一致（前端 / Node / CLI）
- `knowledge_search` 与聊天分数、顺序一致
- `search_all` = 文件 + 保险库引用 + 知识库，顺序与聊天卡片一致

### 5.4 MCP 临时取用密钥

```
Agent: vault_get_secret(id|ref, purpose, ttlSec)
  → server/data/secret-requests/<id>.json
  → 应用 2s 轮询 → Toast / 保险库请求卡
  → 用户允许（需解锁）→ 前端解密 → mcp_secret_fulfill
  → 写临时文件 + secret-responses/<id>.json（path/expiresAt）
Agent: vault_secret_status → path（无明文）
Agent: 读取文件使用 → vault_secret_release → 删除文件
```

拒绝 → `denied`；锁定 → 保持 `pending`；10 分钟未响应自动失效。

### 5.5 在线鉴权

- 复用网易 OpenID（CodeMaker 同款），由 `popo-cli` 托管登录/刷新/登出
- AnswerMaker 不保存 token；仅调用 CLI
- popo-cli 调用在应用内串行 + 45s 超时，避免并发锁

### 5.6 本地模型与 Agent

- 启动检测 Ollama：未安装 winget/brew 安装；未运行 `ollama serve`；推荐模型按 VRAM/RAM（8G→7B，4G/16G→3B，其他→1.5B）
- Agent 非交互：CodeMaker `run`、Claude `-p`、Codex `exec -o`、Gemini `-p`；白名单 + 240s 超时 + ANSI 清理
- 聊天把 BM25 片段作为上下文；保险库只传引用

### 5.7 MCP 生命周期

- 应用 `mcp_start` 拉起 `server/mcp-server.mjs`，日志 `server/data/mcp-server.log`
- 端口占用自动顺延；写 `mcp-runtime.json`
- Token：`ANSWERMAKER_MCP_TOKEN` 或 `mcp-token.txt`；轮换后自动重启
- 自检：`initialize` + `tools/list`
- **随主进程关闭（可选，默认勾选）**：MCP 面板勾选「关闭应用时同时停止 MCP 服务」；勾选时 Tauri `RunEvent::Exit` 调用 `stop_if_following` 停止服务，取消勾选则服务继续在后台运行。偏好存 localStorage，启动时通过 `mcp_set_follow_main` 同步给 Rust
- 外部部署可单独运行 MCP 与 CLI，读取同一 `server/data`

---

## 6. 对外接口

### 6.1 MCP 工具（16）

| 工具 | 作用 | 含明文 |
| --- | --- | --- |
| `server_info` / `server_status` | 版本/工具；运行状态与数据量 | 否 |
| `vault_list_refs` / `vault_search` | 保险库引用与元数据 | 否 |
| `vault_get_secret` | 申请临时使用条目，返回临时文件路径 | 否（协议层） |
| `vault_secret_status` / `vault_secret_release` | 查询请求/立即删除临时文件 | 否 |
| `knowledge_search` / `knowledge_list` / `knowledge_get_doc` | 知识库 BM25 / 列表 / 全文切块 | 是（知识库正文） |
| `search_all` | 文件 + 保险库引用 + 知识库统一检索 | 否（保险库）/是（知识） |
| `files_list` / `files_search` | 文件归档列表 / 名称地址检索 | 否 |
| `link_read` | popo-cli 读取 KM/POPO 正文 | 是（在线文档） |
| `popo_spaces` / `popo_list` | 团队空间 / 云空间目录 | 否 |

### 6.2 CLI

```
am vault list|search
am search
am knowledge list|get
am files list|search
am link read <url>
am popo spaces|ls
am mcp status|config|start
```

### 6.3 Tauri 命令（主要）

- 存储：`db_load_all` `db_load_vault` `db_save_docs` `db_save_chunks` `db_delete_chunks` `db_save_files` `db_save_vault` `db_mark_migrated` `db_info`
- MCP：`mcp_status` `mcp_start` `mcp_stop` `mcp_rotate_token` `mcp_self_test` `mcp_sync_data` `mcp_secret_pending` `mcp_secret_deny` `mcp_secret_fulfill`
- POPO：`popo_auth_status/login/refresh/logout` `link_read` `popo_team_spaces` `popo_space_children`
- Ollama：`ollama_status/install/start/pull`
- Agent：`agent_probe/run`
- 通用：`read_text_file` `open_url` `open_path`
- **旧桩（未使用，待清理/实现）**：`vault_list` `vault_upsert` `vault_get_ref` `knowledge_ingest` `chat_send`

---

## 7. 安全模型

- 保险库：WebCrypto 加密后再落库；密钥不可导出、只存内存，锁定即清除；无明文落盘
- MCP：默认无 Token 拒绝；保险库只暴露 `vault://` 引用；密钥取用需应用内逐次授权 + 临时文件 + TTL
- 密钥文件：随机 id、路径校验、Unix 0600；服务端只删除自身目录内文件
- 在线鉴权：凭据由 popo-cli 管理，应用不接触 token
- 已知风险：CSP 为 null（未处理）；临时文件为明文。MCP 暴露面已收敛（V0.3 安全组）：默认只绑定 127.0.0.1、本机模式 CORS 仅限本机来源、局域网需显式开启（开启时 CORS 为 *，靠多客户端 Token + 审计约束）

---

## 8. 已完成功能（V0.2）

- [x] 保险库真实加密、解锁/锁定、复制 JSON、改名、旧明文迁移、自查
- [x] 知识库真实读取/切块/BM25、来源与导入时间、导出
- [x] SQLite 全量迁移（docs/chunks/files/vault），WAL，冷启动验证
- [x] MCP 与聊天检索数据/算法对齐；`search_all`
- [x] MCP 控制面板：真实启停、状态、Token 轮换、自检、配置 JSON、工具清单、随主进程关闭开关
- [x] MCP 临时密钥取用（请求/授权/状态/释放，TTL 清理）
- [x] POPO 个人/团队空间浏览与一键导入（loading/重试/请求序号保护）
- [x] 文件管理：自动归档、溯源、打开、复制、Tab 分组、手动新增不同步 RAG
- [x] Ollama 检测/自动安装/启动/推荐模型下载
- [x] 本地 Agent CLI 嵌入（4 种）
- [x] 聊天：智能检索合并、折叠 RAG 卡片、保险库卡片、轮次列表、纸飞机发送按钮与完整 hover/focus/active
- [x] 主题色 #7f71f1、Font Awesome 图标、无全页滚动 + 自定义滚动条
- [x] 设置：OpenID 状态、Ollama/Agent、SQLite 路径与数据量
- [x] MCP smoke 20/20（POPO 22/22）；Rust 密钥写入单测；`npm run build` 通过
- [x] **V0.3 安全组第一批**：MCP 默认本机绑定 + 局域网显式开关与 CORS 收敛（server_status/health 带 bind/lan）；多客户端 Token 与撤销（tokens.json 热加载，CLI 与面板可管理）；密钥取用/鉴权审计（audit.log JSONL + 面板最近 20 条 + CLI audit tail）；剪贴板 30 秒比对后自动清空；保险库闲置 5 分钟自动锁定（可关）；MCP smoke 扩至 28/28

---

## 9. 待开发清单

### P0 — 安全 / 正确性

1. **Rust 保险库实现**：`vault_crypto.rs` 仍为占位；目标 Argon2id + OS 钥匙串，替代前端 PBKDF2；设计迁移路径（保持现有密文可解密）。
2. **MCP 密钥取用审计**：✅ V0.3 已落地：服务端 append-only 写 `server/data/audit.log`（JSONL：ts/client/event/tool/ref/purpose/result），覆盖鉴权失败、工具调用、密钥申请/状态查询/释放；应用授权/拒绝经 Rust 回写同一日志；MCP 面板有最近 20 条只读列表，CLI 有 `audit tail`；绝不记录 Token 值与密钥明文。
3. **多 Token / 按客户端授权与撤销**：✅ V0.3 已落地：`server/data/tokens.json` 多客户端存储（{id,name,token,createdAt,lastUsedAt,revoked}），旧 env / mcp-token.txt 兼容为 default 客户端；服务端按文件 mtime 热加载，撤销即时生效、lastUsedAt 60 秒节流落盘；CLI `token list|add|revoke` 与 MCP 面板均可管理，Token 只在新增时完整显示一次。
4. **临时文件安全加固**：Windows ACL 收紧、应用/服务退出清理、崩溃残留扫描；可选「一次性读取即删除」。
5. **CSP 与 MCP 暴露面**：MCP 暴露面 ✅ V0.3 已落地：默认只监听 127.0.0.1；局域网模式显式开启（`ANSWERMAKER_MCP_LAN=1` / `ANSWERMAKER_MCP_HOST` / 面板开关，开启时启动日志与面板有风险提示）；本机模式 CORS 仅允许 127.0.0.1/localhost 来源，局域网模式保留 *。剩余：Tauri CSP 仍为 null，不在本批范围。
6. **崩溃场景的 MCP 回收**：当前仅正常退出时按勾选停止；强杀/崩溃会留下服务进程，需 Job Object（Windows）或父进程看护。
7. **打包可用性**：`server/` 与 Node 运行时未随安装包分发；需 resources/sidecar 打包或内置服务，并在缺 Node 时给出可用方案。
8. **数据库运维**：schema 版本迁移、备份/恢复/导出 UI、损坏检测与恢复提示。

### P1 — 功能

9. **OpenAI / Claude 真实接入**：当前为本地模拟；需 API Key 管理（可入保险库）、流式响应、错误重试。
10. **流式输出**：Ollama 与 Agent 目前非流式；改为逐 token/逐行展示与可取消。
11. **向量/混合检索**：bge-m3 embedding + sqlite-vec / LanceDB；当前 BM25 全量载入内存，数据量大时内存与延迟上升。
12. **PDF / Word / Excel 解析**：当前仅登记；需文本抽取、表格与页级溯源。
13. **在线文档自动同步**：ETag/版本校验、权限与删除同步；目前仅手动读取入库。
14. **MCP 能力扩展**：写工具（如受控 `knowledge_ingest`）、resources/prompts、GET/SSE 与会话、协议版本升级；CLI 对齐 16 工具（含密钥请求）。
15. **保险库匹配识别真实化**：当前候选为模拟结果；需实际扫描 `.ssh`、`.env` 等并预览/去重。
16. **MCP 密钥策略**：可选「已解锁时自动授权（限定 ref/时长）」、按用途模板、一次性凭据、使用后自动 `release`。
17. **设置项**：MCP 监听地址/端口、自动启动、临时文件 TTL 默认值、日志级别 UI。
18. **macOS 适配与打包**：`icon.icns`、权限、Ollama/Agent 路径、SQLite 路径验证。

### P2 — 技术债 / 质量

19. **检索实现去重**：`search.ts` / `mcp-server.mjs` / `cli` 三份 BM25 与分词；抽共享规范 + 黄金用例，防漂移。
20. **DB 写入优化**：`db_save_docs` 每次全表删插；改为增量 upsert + 去抖；命令移出主线程（`spawn_blocking`）；批量导入事务。
21. **文档数据规范化**：`docs.content` 与 `chunks` 重复存储；评估只保留 chunks 或独立镜像表。
22. **错误可见性**：多处 `catch {}`（同步、轮询、存储）静默；增加状态页/重试与结构化日志。
23. **旧代码清理**：`src/components/` 空目录；`types.ts` 旧 `load/save`；`lib.rs` V0.1 桩命令与过时注释；未使用依赖 `aes-gcm`/`argon2`/`base64`（cargo 警告）。
24. **测试与 CI**：仅 MCP smoke + 1 个 Rust 单测；缺前端单测/E2E、密钥授权端到端、迁移回归；建议 CI 跑 `tsc`、`cargo test`、smoke。
25. **localStorage 清理策略**：迁移后旧键长期保留；提供「确认后清除备份」入口。
26. **可访问性与窄屏**：键盘导航、`focus-visible` 已部分覆盖；<1100px 隐藏轮次列表，需平板布局。
27. **依赖与体积**：Node 侧零依赖是优点；前端 Font Awesome 仅 solid；评估图标子集化。

---

## 10. 里程碑建议

### V0.3（安全与可发布）
- P0 全部：Rust 保险库/钥匙串、密钥审计、多 Token、CSP、打包 server、DB 备份与迁移
- PDF/Word 解析、在线文档自动同步
- 流式输出（Ollama/Agent）
- macOS 打包验证

### V1.0（能力与规模）
- 向量/混合检索（bge-m3 + sqlite-vec/LanceDB）
- OpenAI/Claude 真实接入与统一模型层
- MCP 写能力与资源/提示词、协议完整度
- 多客户端授权与审计面板

---

## 11. 已知限制（如实）

- OpenAI / Claude 模型仍为模拟回复
- 保险库匹配识别为模拟候选
- `vault_crypto.rs`、`vault_*`/`knowledge_ingest`/`chat_send` 为旧桩
- PDF/Word/Excel 不解析正文
- 在线文档仅 KM/POPO 可读；非 KM/POPO 域名仅登记
- BM25 为关键词检索，无 embedding
- MCP 局域网 HTTP 明文传输（Token 鉴权）；CSP 未设置
- 打包版未内置 Node 与 `server/`
- 仅 Windows 实机验证；macOS 未实测
- 「关闭应用时同时停止 MCP」仅在正常退出时生效；强杀/崩溃不触发清理

---

## 12. 快速运行与验证

```bash
npm install
npm run tauri dev          # 桌面端（127.0.0.1:5173）
npm run build              # tsc + vite
npm run mcp:start          # 单独启动 MCP
npm run mcp:smoke          # 20 项；SMOKE_POPO=1 为 22 项
npm run cli -- search 关键词
cargo test --manifest-path src-tauri/Cargo.toml   # 含密钥写入单测
```
