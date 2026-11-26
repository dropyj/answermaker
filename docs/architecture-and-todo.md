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
- **加密**：双实现双读单写——WebCrypto PBKDF2-SHA256（210,000 次）+ AES-256-GCM（浏览器与存量数据，cryptoVer=web-pbkdf2）；桌面端 Rust Argon2id（m=64MiB/t=3/p=4）派生 KEK + 每条目随机 DEK 的 AES-256-GCM 信封加密（cryptoVer=rust-argon2id，`vault_crypto.rs` 已实现并接线，KEK 只存 Rust 进程内存）。解密按条目 cryptoVer 分发，存量密文永远可读；不强制迁移，桌面端新写入优先 Rust、编辑重存自然升级；整库 rust 主格式仅在桌面端首次建库时产生（浏览器打不开，会明确报错）
- **检索**：本地 BM25（中文单字 + 双字 bigram；英文/数字按词）；k1=1.5、b=0.75；其上有本地召回反馈闭环（项3b，±15% 封顶调整，见 §4.3）
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
├─ feedback.ts             召回反馈（项3b）：采集存储、查询相似度、±15% 封顶调整
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
└─ vault_crypto.rs         Argon2id + AES-256-GCM 信封加密（已实现：derive/encrypt/decrypt/bytes/lock 命令 + 会话 KEK 状态；本机无 cargo 未编译，待 Windows cargo check）

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
| `vault_items` | id, data(JSON), created_at | 加密条目（value/account 为密文；含 expiresAt/env/lastUsedAt 健康元数据） |
| `projects` / `entity_links` | id, data(JSON) | 项目空间与实体↔项目关联（WF1，JSON 整行存） |
| `systems` | id, data(JSON), created_at | 系统导航条目（WF1） |
| `notes` / `todos` / `events` | id, data(JSON), created_at | 速记 / 待办 / 日程（WF2） |
| `vault_attachments` | id, data(JSON), created_at | 保险库加密附件密文（WF3，每条目一个，≤5MB） |
| `accounts` | id, data(JSON), created_at | 授权账号（WF5：personal-cloud / doc-source / popo 隔离） |
| `doc_vectors` | chunk_id PK, doc_id/idx/model/dim/vec(base64) | 文档切块向量（项3，向量检索开启时生成） |
| `retrieval_feedback` | id, query, chunk_id, doc_id, signal, kind, bm25_score, vec_score, created_at | 召回反馈（项3b，列式存储；见 §4.3） |
| `meta` | key, value | 迁移标记 `migrated_from_localstorage=1` |

启动流程：

1. `db_load_all` 读取 docs/files/chunks/vault/meta
2. 若未迁移且 localStorage 有旧数据 → 逐项导入 → 写入迁移标记（localStorage 原键保留备份）
3. 切块注入 `search.ts` 内存；保险库注入 `crypto.ts` 内存
4. 渲染 UI；文档/文件变化写回 SQLite（去抖由 React 状态驱动），同时自动同步 `server/data`

### 4.3 召回反馈闭环（项3b）

纯本地反馈回路，不依赖任何外部资源；实现在 `src/feedback.ts`，排序钩子在 `src/search.ts` 的 `bm25Search` 最终排序前，项3 向量通道开启后基础分换成 hybrid 分即可、反馈层不变。

**采集点**

- 聊天/仅搜索/RAG 的结果片段卡片（`App.tsx` HitCard）上 👍/👎：显式反馈，signal ±1；同 (query, chunkId) 再次点击同向撤销、反向覆盖，只保留最新一条。
- 展开片段或打开来源：弱正反馈 kind=`open`、signal +0.3（同 query+chunk 只留一条；已有显式反馈时不记，避免叠加）。
- 反馈发生时的 bm25Score / vecScore 一并落库（vecScore 在向量通道未开启时为 null），供排查。

**排序公式**

```
finalScore = baseScore + baseScore * 0.15 * clamp(raw, -1, 1)
raw = Σ_{该 chunk 的历史反馈, sim >= 0.3} sim(query, fb.query) * fb.signal * (kind=explicit ? 1 : 0.5)
sim = token 集合 Jaccard（复用 BM25 的 tokenize，含中文 bigram；相同 query 时 sim=1）
```

**封顶与防误杀**

- 调整封顶 ±15%（MAX_ADJ_RATIO=0.15）：反馈只能微调名次，不能把不相关片段顶上来，也不能把相关片段压没。
- 累计 raw ≤ -0.6（DEMOTE_LINE）视为「降权」而非删除：命中仍会出现，只是排序靠后；结果卡片标注「因你的反馈加权/降权」（标注阈值 |raw| ≥ 0.2）。
- 查询相似度阈值 SIM_THRESHOLD=0.3：与当前查询不相似的历史反馈不参与，避免反馈污染无关查询。

**体检面板**：设置页「召回反馈」——总数与 👍/👎/打开分布、最近 10 条（可单条删除）、受影响文档 Top5（按净加权绝对值）、导出反馈 JSON、一键清空。清空/删除后排序即时恢复无反馈状态。

**自查**：`npm run feedback:check`（scripts/feedback-check.mjs，esbuild 打包真实 search/feedback 模块）：基线 → 👍 后相似查询分数与排名上升且调整 ≤15% → 👎 后分数下降但不消失 → 撤销恢复基线 → 无关查询不受影响。

### 4.2 localStorage

- **仅作为**：首次迁移的备份、浏览器预览（无 Tauri）的存储、V0.1 明文 `am_vault`（待用户迁移）
- 桌面端正常运行时不再读写 `am_docs` / `am_chunks_v2` / `am_files` / 保险库键
- 例外：POPO 浏览偏好等纯 UI 状态未迁移

### 4.3 server/data 快照

应用变化后自动写 `knowledge.json`（docs + chunks + files + projects/links/systems/notes/todos/events/accounts 元数据）与 `vault-refs.json`（仅 id/key/ref/type/url/hasAttachment，无明文与附件内容）。MCP 与 CLI 读取该快照，保证与聊天检索同一份数据、同一套 BM25。MCP 写工具（notes/todos/events）经 `ingest-requests/` 请求文件队列由应用轮询导入落库并 ack，形成闭环。

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

### 6.1 MCP 工具（23）

| 工具 | 作用 | 含明文 |
| --- | --- | --- |
| `server_info` / `server_status` | 版本/工具；运行状态与数据量 | 否 |
| `vault_list_refs` / `vault_search` | 保险库引用与元数据 | 否 |
| `vault_get_secret` | 申请临时使用条目，返回临时文件路径 | 否（协议层） |
| `vault_secret_status` / `vault_secret_release` | 查询请求/立即删除临时文件 | 否 |
| `knowledge_search` / `knowledge_list` / `knowledge_get_doc` | 知识库 BM25 / 列表 / 全文切块 | 是（知识库正文） |
| `search_all` | 文件 + 保险库引用 + 知识库 + 系统/笔记/待办统一检索（结果带来源账号标注） | 否（保险库）/是（知识） |
| `files_list` / `files_search` | 文件归档列表 / 名称地址检索 | 否 |
| `link_read` | popo-cli 读取 KM/POPO 正文；可选 `accountId`（归属标注+审计，会话由 popo-cli 托管） | 是（在线文档） |
| `popo_spaces` / `popo_list` | 团队空间 / 云空间目录；可选 `accountId` | 否 |
| `notes_list` / `notes_add` | 速记列表 / 新增（写经 ingest 队列由应用落库） | 否 |
| `todos_list` / `todos_add` / `todos_done` | 待办列表 / 新增 / 完成（写经 ingest 队列） | 否 |
| `events_list` / `events_add` | 日程列表 / 新增（写经 ingest 队列） | 否 |

### 6.2 CLI

```
am vault list|search
am search
am knowledge list|get
am files list|search
am link read <url> [--account <id>]
am popo spaces|ls [--account <id>]
am notes list|add
am todos list|add|done
am events list|add
am mcp status|config|start
am token list|add|revoke
am audit tail [n]
```

### 6.3 Tauri 命令（主要）

- 存储：`db_load_all` `db_load_vault` `db_save_docs` `db_save_chunks` `db_delete_chunks` `db_save_files` `db_save_vault` `db_save_projects` `db_save_links` `db_save_systems` `db_save_notes` `db_save_todos` `db_save_events` `db_save_accounts` `db_save_vault_attachments` `db_mark_migrated` `db_info`
- MCP：`mcp_status` `mcp_start` `mcp_stop` `mcp_rotate_token` `mcp_self_test` `mcp_sync_data` `mcp_secret_pending` `mcp_secret_deny` `mcp_secret_fulfill` `mcp_ingest_pending` `mcp_ingest_ack` `mcp_set_lan` `mcp_tokens_list` `mcp_token_add` `mcp_token_revoke` `mcp_audit_tail`
- POPO：`popo_auth_status/login/refresh/logout` `link_read` `popo_team_spaces` `popo_space_children`
- Ollama：`ollama_status/install/start/pull`
- Agent：`agent_probe/run`
- 通用：`read_text_file` `read_binary_file_base64` `write_text_file` `open_url` `open_path`
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
- [x] **项目空间 + 系统导航 + 全局命令面板**（WF1）：projects/entity_links/systems 表；项目聚合文档/文件/密钥/系统/笔记/待办，删除只解关联；导航卡片一键打开/复制凭据（走保险库解锁 + 30 秒清剪贴板）；Ctrl+K/Cmd+K 命令面板聚合 BM25/文件/保险库引用/系统/项目/笔记/待办；聊天命中系统返回系统卡片
- [x] **笔记/待办/日程 + 今日简报 + MCP 写工具**（WF2）：「事务」三 Tab；聊天智能创建（中文相对日期解析器，自查 8/8）；今日简报卡；MCP 新增 7 工具（共 23），写工具经 ingest 队列应用落库闭环；CLI notes/todos/events；smoke 37/37
- [x] **跨设备加密同步 + 密钥健康 + 加密附件**（WF3）：.amsync 零知识同步包（独立同步口令 PBKDF2+AES-GCM，文件头无明文；Node 自查 4/4）；通道三类——本地文件夹（已实现）、同步盘/Git 文件夹（同机制）、自托管服务器端点（已实现：默认端点 https://heytiger.cn/amsync 写死预填、可改自建；账号登录为主路径——POST /auth/register、/auth/login（已有账号后再注册需邀请码）、/auth/logout、GET /auth/me，会话 Token Bearer 鉴权、服务器按账号隔离存储、会话 401 客户端清本地会话提示重登；手动设备 Token 收进高级折叠区作兼容；客户端按契约接通 PUT /package、GET /package/latest、GET /packages、GET /health，推送前断言包体为加密格式拒绝明文，拉取走既有解密+合并；Node mock server 自查 13/13（设备 Token 兼容路径））；按 id+updatedAt 合并、保险库按本地主密码重加密；expiresAt/env/lastUsedAt 健康标注（7 天黄/过期红，简报汇总）；加密附件（会话密钥，≤5MB，MCP 只标 hasAttachment）
- [x] **PDF 正文解析**（WF4）：pdfjs-dist 本地打包 worker；逐页抽文本层真实入库，状态「已入库（PDF 解析，N 页）」；无文本层明确提示「未抽到文本（可能是扫描件）」仅登记；Node 实测抽取通过。Word(.docx) 仍仅登记
- [x] **账号隔离**（WF5）：accounts 表与三类 kind 分组管理；旧 POPO 数据迁移补 accountId 到默认账号「网易 POPO（工作）」；导入前选当前账号、列表徽标与按账号筛选；断开只清该账号（可选移除其文档，默认保留）；聊天/search_all/knowledge_search 结果带账号标注；MCP 在线工具可选 accountId 且审计带 accountId；CLI --account。隔离自查 6/6（迁移/筛选/断开互不影响）。**边界：POPO 会话由 popo-cli 统一托管，多账号会话隔离受 CLI 限制**（数据层隔离已实现，会话层不假装）
- [x] **V0.3 安全组第一批**：MCP 默认本机绑定 + 局域网显式开关与 CORS 收敛（server_status/health 带 bind/lan）；多客户端 Token 与撤销（tokens.json 热加载，CLI 与面板可管理）；密钥取用/鉴权审计（audit.log JSONL + 面板最近 20 条 + CLI audit tail）；剪贴板 30 秒比对后自动清空；保险库闲置 5 分钟自动锁定（可关）；MCP smoke 扩至 28/28

---

## 9. 待开发清单

### P0 — 安全 / 正确性

1. **Rust 保险库实现**：`vault_crypto.rs` 已实现 Argon2id + AES-256-GCM 信封加密并接线（双读单写、按条目 cryptoVer 分发、不强制迁移）；待 Windows `cargo check` 验证编译；后续目标 OS 钥匙串托管 KEK。
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
12. **PDF / Word / Excel 解析**：PDF ✅ WF4 已落地（文本层抽取入库，扫描件仅登记）；剩余 Word(.docx)/Excel 仍仅登记，需文本抽取、表格与页级溯源。
13. **在线文档自动同步**：ETag/版本校验、权限与删除同步；目前仅手动读取入库。
14. **MCP 能力扩展**：notes/todos/events 写工具 ✅ WF2 已落地（ingest 队列落库）；剩余受控 `knowledge_ingest`、resources/prompts、GET/SSE 与会话、协议版本升级。
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
- Word/Excel 不解析正文（PDF 已支持文本层；扫描版 PDF 无文本层仅登记）
- POPO 多账号**会话**隔离受 popo-cli 限制：登录态由 CLI 统一托管，应用只做数据归属/筛选/断开/审计层隔离
- 同步服务器通道默认端点已上 HTTPS（https://heytiger.cn/amsync）并改为账号登录（会话 Token 按账号隔离）；自建端点若用 HTTP 明文，链路上 Token 明文可见，只建议可信网络使用。浏览器预览下文件夹同步降级为手动导出/导入文件
- 本批新增 Rust 命令（db_save_projects/links/systems/notes/todos/events/accounts/vault_attachments、mcp_ingest_pending/ack、write_text_file、read_binary_file_base64）未在 VM 编译（无 cargo），需 Windows cargo check
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
npm run mcp:smoke          # 39 项；SMOKE_POPO=1 额外测 POPO 在线项
node scripts/sync-check.mjs  # 同步包加解密自查 4/4
npm run cli -- search 关键词
cargo test --manifest-path src-tauri/Cargo.toml   # 含密钥写入单测
```


## 向量检索（项3，已落地）

- 模型：`Xenova/bge-small-zh-v1.5`（transformers.js ONNX 量化版，512 维，约 100MB），选型理由：bge 是中文检索常用基线，small 版体积/速度适合桌面本地；首次开启在设置里下载并缓存，之后纯本地运行。查询侧加 bge-zh-v1.5 官方检索指令前缀，文档侧不加。
- 开关：设置「语义检索（实验）」，默认关；关或模型未就绪时检索与纯 BM25 完全一致。开启时新入库切块自动生成向量（search.saveChunks 钩子），已有文档由设置页回填。
- 存储：SQLite `doc_vectors`（chunk_id + Float32 base64），浏览器回退 localStorage；与 chunks 同生命周期（删文档/删切块同步删向量，db_save_docs 有孤儿清理兜底）。
- 混合排序：候选 = BM25 命中 ∪ 余弦 ≥ 0.35 的向量命中；`hybrid = 0.5 * (bm25/本次最大bm25) + 0.5 * clamp(余弦, 0, 1)`；hybrid 作为 baseScore 进入召回反馈层（项3b 公式/面板不变）。聊天与搜索模式走 `searchKnowledge` 异步入口；命令面板仍用同步 BM25（快速跳转场景，不等模型）。
- 自查：`npm run embedding:check`（Node + transformers.js 实测：cos(相近句)=0.6782 > cos(不相干句)=0.3426，PASS）。


## 安装包与自动更新（项4，已落地代码侧）

- bundle.resources 打包 server/ 与 cli/；mcp.rs 路径候选打包内优先、开发回退；数据目录可写探测，安装目录只读时回退 %APPDATA%/AnswerMaker/mcp-data 并以 ANSWERMAKER_DATA_DIR 注入服务端进程。
- Node 不打包：启动检测 node_version，未装时报错与 MCP 面板都给安装指引。
- updater：tauri-plugin-updater + tauri-plugin-process 已注册，公钥在 tauri.conf.json，端点 https://heytiger.cn/updates/{{target}}/{{current_version}}，createUpdaterArtifacts 已开；私钥在工作区 .updater/（gitignore）。代码签名无证书跳过（SmartScreen 提示已写进设置页与 README）。
- 待联调：服务器 /updates/ 静态目录与 latest.json 发布流程需在首次正式发版时在服务器侧落地并实测一次完整升级。
