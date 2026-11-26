# AnswerMaker

本地 AI 中枢桌面应用：**加密保险库 + RAG 知识库 + MCP/CLI 网关 + 可切换模型的聊天主区域**。
开发基线：PRD + 架构设计文档 **V1.1（已冻结，2026-11-25）**，产品名 AnswerMaker，CLI 名 `answermaker`（别名 `am`），首发 **Windows P0 / Mac P1**。

> 当前架构、已实现范围与待开发清单：见 [`docs/architecture-and-todo.md`](docs/architecture-and-todo.md)。

## 图标

应用图标使用用户选定的**第一版渐变 A artwork（带光泽立体感版）**：
源图 `~/workspace/imagine_media/media-generation-answermaker-icon-a-0-addb4b1a-ecce-4142-9da8-e9bf371ea092.webp`
（蓝 → 紫 → 粉红 → 橙渐变。此前生成的扁平版未纳入本项目。）

由 `scripts/make-icons.py`（Pillow）生成：

- `src-tauri/icons/`：`32x32.png`、`128x128.png`、`256x256.png`、`512x512.png`、`icon.png`(512)、`icon.ico`（Windows 多尺寸）
- `public/logo.png`（顶栏 logo）、`public/favicon.png`
- `icon.icns`（macOS）需在 Mac 上用 `iconutil` 由 512 PNG 生成，未随本骨架附带，`tauri.conf.json` 未引用它

重新生成：`python3 scripts/make-icons.py`

## 技术栈

Tauri 2.0 + React 18 + TypeScript + Vite 5；Rust 后端在 `src-tauri/`；Node 版 MCP 服务端与 CLI 在 `server/` 与 `cli/`（仅 Node 标准库，零第三方依赖）；本地模型通过 Ollama 接入，本地 Agent 通过 CodeMaker / Claude Code / Codex / Gemini CLI 接入。

## 目录结构

```
answermaker/
├─ index.html / package.json / vite.config.ts / tsconfig.json
├─ public/                 favicon.png、logo.png（由图标脚本生成）
├─ scripts/make-icons.py   图标多尺寸生成脚本
├─ src/
│  ├─ main.tsx / App.tsx   三栏布局：左侧分区导航 + 主区域（含 Ollama 真实请求与回退）
│  ├─ styles.css
│  ├─ types.ts             五字段模型、通用工具、Token 生成
│  ├─ bridge.ts            Tauri 命令封装（在线登录/链接读取，浏览器预览降级）
│  ├─ db.ts                本地仓储：SQLite 读写 + 首次 localStorage 迁移 + 浏览器回退
│  ├─ crypto.ts            保险库 WebCrypto 加密（PBKDF2 + AES-GCM，密文入 SQLite）
│  ├─ search.ts            真实切块（512/重叠80）+ BM25 检索 + 切块内存缓存/落库
│  ├─ mcpSync.ts           应用数据 → server/data 自动同步（供 MCP/CLI）
│  ├─ files.ts             文件管理归档、按名称/地址检索、去重
│  └─ modules/
│     ├─ Vault.tsx         保险库：主密码设置/解锁/锁定、加密条目、旧数据迁移、匹配识别、复制 JSON
│     ├─ Knowledge.tsx     知识库：文本类真实读取切块、KM/POPO 链接经 popo-cli 读取、自定义链接名、原始路径/导入时间、导出 knowledge.json
│     ├─ Files.tsx         文件管理：归档列表、类型过滤、打开源地址
│     ├─ FileHitCard.tsx   文件/链接卡片（浏览器/资源管理器打开、复制地址）
│     ├─ PopoImport.tsx    POPO 个人空间/团队空间浏览与一键导入知识库
│     ├─ vaultSearch.ts    保险库检索（加密条目解锁后检索密码；V0.1 明文兼容）
│     ├─ VaultHitCard.tsx  聊天区保险库命中卡片（复制密码 / 复制 JSON）
│     ├─ OllamaBootstrap.tsx 启动时检测 Ollama，缺失自动安装/启动/下载推荐模型
│     ├─ Mcp.tsx           MCP 网关控制面板：真实启停、端口/Token、配置 JSON 复制、协议自检、工具清单
│     ├─ Chat.ts           真实 BM25 检索回复、RAG 摘录回退、Ollama /api/chat 请求
│     └─ Settings.tsx      设置：在线内容 OpenID 登录、Ollama/Agent 环境、数据与安全
├─ server/
│  ├─ mcp-server.mjs       Node 版 MCP 服务端（Streamable HTTP 最小可用子集，Token 鉴权）
│  ├─ popo-lib.mjs         POPO 链接读取与空间浏览（供 MCP/CLI 复用）
│  └─ data/                knowledge.json（文档+文件归档）、vault-refs.json（引用示例）
├─ cli/
│  └─ answermaker.mjs      CLI：vault list / search / mcp config / mcp start
└─ src-tauri/
   ├─ Cargo.toml / build.rs / tauri.conf.json   productName=AnswerMaker，identifier=com.answermaker.app
   ├─ capabilities/default.json
   ├─ icons/                多尺寸 PNG + icon.ico
   └─ src/
      ├─ main.rs / lib.rs  命令骨架与数据目录解析（Win %APPDATA%/AnswerMaker、macOS ~/Library/Application Support/AnswerMaker）
      ├─ db.rs             本地 SQLite（WAL）：文档/切块/文件/保险库密文，含 localStorage 迁移标记
      ├─ popo.rs           POPO/KM 在线内容：popo-cli OpenID 登录状态、登录、刷新、登出、链接读取
      ├─ mcp.rs            本机 MCP 服务控制：状态/启停/Token 轮换/协议自检、局域网地址与数据量
      ├─ ollama.rs         本地 Ollama 检测 / winget 安装 / 启动 / 模型拉取 / 硬件推荐
      ├─ agent.rs          本地 Agent CLI 探测与非交互执行（CodeMaker / Claude / Codex / Gemini）
      └─ vault_crypto.rs   Argon2id + AES-256-GCM 信封加密设计（桌面端目标，函数体仍为占位，见下）
```

## 运行前端预览（无需 Rust）

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # tsc + vite 生产构建（V0.2 已验证通过）
```

## 运行 MCP 服务端与 CLI（Node，无需额外依赖）

```bash
npm run mcp:start
# 或指定 Token：ANSWERMAKER_MCP_TOKEN=my-token node server/mcp-server.mjs
# 服务端默认只监听 http://127.0.0.1:7361/mcp（端口可用 ANSWERMAKER_MCP_PORT 改）；ANSWERMAKER_MCP_LAN=1 才开放局域网
# 端口占用会自动 +1 顺延（最多 20 次）；首次启动生成 server/data/mcp-token.txt 并复用

npm run cli -- vault list                 # 列出保险库引用（只含 vault:// 与元数据）
npm run cli -- vault search <关键词>       # 按 key/type/url 检索引用
npm run cli -- search <关键词>             # 与聊天一致：文件/链接 + 保险库引用 + 知识库 BM25
npm run cli -- knowledge list             # 列出文档（来源/切块数）
npm run cli -- knowledge get <id|名称>     # 读取文档全部切块
npm run cli -- files list                 # 列出文件管理归档
npm run cli -- files search <关键词>       # 检索文件/链接名称与地址
npm run cli -- link read <url>            # 经 popo-cli 读取 KM/POPO 正文
npm run cli -- popo spaces                # 列出团队空间
npm run cli -- popo ls personal [folderId]     # 个人云空间目录
npm run cli -- popo ls <teamSpaceId> [folderId] # 团队空间目录
npm run cli -- mcp config                 # 输出 MCP 配置 JSON（自动读取运行端口与 Token）
npm run cli -- mcp status                 # 查看运行状态、端口、Token 与健康信息
npm run cli -- mcp start                  # 拉起 MCP 服务端
npm run cli -- token list                 # 列出客户端 Token（名称/状态/最后使用，不显示值）
npm run cli -- token add <name>           # 新增客户端 Token（值只完整显示一次）
npm run cli -- token revoke <name>        # 撤销某客户端 Token（服务热加载，立即生效）
npm run cli -- audit tail [n]             # 查看最近 n 条审计记录（默认 20）
```

MCP 服务端实现 JSON-RPC：`initialize`、`ping`、`tools/list`、`tools/call`；支持批量请求与 CORS 预检；无/错 Token 返回 401。

工具（16 个）：

| 工具 | 说明 |
| --- | --- |
| `vault_list_refs` / `vault_search` | 保险库引用与元数据，绝不返回明文 |
| `vault_get_secret` | 申请临时使用某条目；需应用内授权，返回临时文件路径（响应不含明文） |
| `vault_secret_status` / `vault_secret_release` | 查询请求状态/到期时间，用完后立即删除临时文件 |
| `knowledge_search` / `knowledge_list` / `knowledge_get_doc` | 知识库 BM25 检索（与聊天区同一算法）、列表、按 id/名称读取切块 |
| `search_all` | 与聊天区一致的统一检索：文件/链接 + 保险库引用 + 知识库 BM25 |
| `files_list` / `files_search` | 文件管理归档列表与名称/地址检索 |
| `link_read` | 经 popo-cli 读取 KM / POPO 文档正文 |
| `popo_spaces` / `popo_list` | 列团队空间、个人云空间/团队空间目录 |
| `server_info` / `server_status` | 版本/工具清单、运行状态与数据量（调试） |

数据来源：
- 应用启动及知识库/文件/保险库变化后，自动把同一份 `docs`（含切块）、`files` 与保险库引用写入 `server/data/`，MCP 与聊天检索输入保持一致（去抖 0.8s，仅元数据，不含密码明文）。
- 也可手动「知识库 → 导出 knowledge.json」「保险库 → 导出引用 JSON」覆盖 `server/data/`。
- `server/popo-lib.mjs` 复用 popo-cli；`link_read` 与 `popo_*` 需要本机已登录 popo-cli。

### 应用内启停与自检

「MCP 网关」页面直接控制本机服务，展示的都是真实状态（不再是示例地址）：

- **启动 / 停止 / 刷新**：Rust `mcp_start` / `mcp_stop` / `mcp_status` 调用 `server/mcp-server.mjs`；端口占用自动顺延，日志写入 `server/data/mcp-server.log`
- **随主进程关闭**：面板勾选「关闭应用时同时停止 MCP 服务」（默认勾选）；勾选时退出应用会停止服务，取消勾选则服务继续在后台运行。偏好保存在 localStorage，启动时同步给 Rust。
- **状态**：局域网端点、端口、PID、运行时长、版本、Token 来源（文件 / 环境变量）、Node 版本
- **Token**：显示 / 复制 / 重新生成（写入 `mcp-token.txt`，运行中自动重启生效）
- **监听范围**：默认仅本机 127.0.0.1；面板可显式开启局域网访问（绑定 0.0.0.0，带风险提示，下次启动生效），本机模式下配置 JSON 使用 127.0.0.1 端点
- **多客户端 Token**：`server/data/tokens.json` 按客户端存储，可在面板或 CLI（`am token add/revoke`）增删撤销；Token 只在新增时显示一次，服务端热加载立即生效
- **审计**：鉴权失败、工具调用与密钥取用写入 `server/data/audit.log`（JSONL，不含 Token 值与密钥明文）；面板展示最近 20 条，CLI 用 `am audit tail` 查看
- **自检**：发送 `initialize` + `tools/list`，返回工具数与耗时
- **数据量**：知识文档、文件/链接、保险库引用数量及两份导出的更新时间
- 打包版需随应用附带 `server/` 目录，或设置 `ANSWERMAKER_MCP_SERVER` 指向 `mcp-server.mjs`

### 保险库密钥的临时取用（给 AI 使用，不直接返回明文）

其他 Agent 通过 MCP 查询到保险库条目后，按以下流程实际使用：

1. `vault_list_refs` / `vault_search` 找到条目的 `id` 或 `vault://<key>/<type>` 引用（引用 JSON 已包含条目 `id`）
2. 调用 `vault_get_secret { id | ref, purpose, ttlSec, waitMs }`
   - 需要 AnswerMaker 正在运行且保险库已解锁
   - 等待用户在「保险库 → MCP 密钥请求」中点击「允许并生成临时文件」
   - 未及时响应时返回 `status: pending` + `requestId`，稍后用 `vault_secret_status` 查询
3. 允许后，应用在本地解密该条目，把它写成当前用户临时目录下的 JSON：
   `%TEMP%/answermaker-secrets/<requestId>.json`（macOS/Linux 权限 0600）
   - MCP 响应只返回 `path`、`ttlSec`、`expiresAt`，**不包含任何明文**
   - 有效期默认 60 秒，可设 15–300 秒；到期自动删除
4. Agent 读取该文件获得 `key/type/account/value/url` 并立即使用；不要写入日志或提交仓库
5. 用完后调用 `vault_secret_release { requestId }` 立即删除文件；应用与服务端也会定期清理过期文件
6. 用户拒绝或保险库锁定时，返回 `denied` / `pending` 及原因，不会生成任何文件

安全边界：请求需用户在应用内逐次授权；临时文件只存在于本机用户临时目录；MCP 协议响应、日志与 CLI 输出均不包含明文；未响应的请求 10 分钟后失效。

### 开发与调试

```bash
npm run mcp:smoke                 # 临时端口启动服务，检查鉴权/CORS/工具/批量/参数校验
SMOKE_POPO=1 npm run mcp:smoke    # 额外测试 POPO 团队空间与目录
ANSWERMAKER_MCP_DEBUG=1 npm run mcp:start   # 输出请求、工具参数与耗时
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ANSWERMAKER_MCP_PORT` | `7361` | 基础端口；占用时自动 +1（最多 20 次） |
| `ANSWERMAKER_MCP_TOKEN` | — | 显式 Token；未设置时读取/生成 Token 文件 |
| `ANSWERMAKER_MCP_TOKEN_FILE` | `server/data/mcp-token.txt` | 默认客户端 Token 持久化文件（gitignored） |
| `ANSWERMAKER_MCP_TOKENS_FILE` | `server/data/tokens.json` | 多客户端 Token 存储（gitignored） |
| `ANSWERMAKER_MCP_AUDIT_FILE` | `server/data/audit.log` | 审计日志 JSONL（gitignored） |
| `ANSWERMAKER_MCP_LAN` | — | `1` 时监听 0.0.0.0 开放局域网；默认只听 127.0.0.1 |
| `ANSWERMAKER_MCP_HOST` | — | 显式指定绑定地址（指定非本机地址等同开启局域网） |
| `ANSWERMAKER_MCP_RUNTIME_FILE` | `server/data/mcp-runtime.json` | 运行端口/pid（gitignored） |
| `ANSWERMAKER_DATA_DIR` | `server/data` | `knowledge.json` / `vault-refs.json` 目录 |
| `ANSWERMAKER_MCP_DEBUG` | — | `1` 开启详细日志 |

`am mcp status` 展示运行状态、实际端口、Token 是否存在与健康检查结果；`am mcp config` 自动读取运行端口与持久化 Token，直接生成可粘贴配置。

## 本地数据存储（SQLite）

业务数据保存在本地 SQLite（`rusqlite` bundled，WAL）：

- 路径：Windows `%APPDATA%/AnswerMaker/answermaker.db`；macOS `~/Library/Application Support/AnswerMaker/answermaker.db`
- 表：`docs`（文档 JSON）、`chunks`（切块正文）、`files`（文件归档）、`vault_meta` / `vault_items`（WebCrypto 密文 + 元数据）、`meta`
- 保险库仍由前端加密后再落库，SQLite 中只有密文；会话密钥只存内存
- 首次启动自动把旧的 localStorage 数据导入 SQLite（一次性，localStorage 原键保留作备份），之后所有读写以 SQLite 为准
- 删除文档时同时删除其切块；重启后切块载入内存供 BM25 使用，检索结果与之前一致
- 浏览器预览（无桌面端）自动回退 localStorage，便于纯前端调试
- MCP/CLI 仍读取 `server/data/*.json`；应用在数据变化时自动同步该副本

Rust 侧命令在 `src-tauri/src/db.rs`（`db_load_all` / `db_save_docs` / `db_save_chunks` / `db_save_files` / `db_save_vault` 等），前端仓储封装在 `src/db.ts`。

## 在 Windows 上跑 Tauri（需先装 Rust）

1. 安装 Rust（rustup）与 Microsoft C++ Build Tools，并确保 WebView2 已安装
2. 在项目根目录：

```bash
npm install
npm run tauri dev     # 开发运行
npm run tauri build   # 打包（图标使用 src-tauri/icons/）
```

> Rust 侧已在本机（Rust 1.100 + MSVC BuildTools + WebView2）实际编译通过；首次编译会下载 crates，耗时较长。开发端口使用 `127.0.0.1:5173`（Windows 保留端口段占用 1420）。

## 在线链接鉴权（POPO / KM，与 CodeMaker 同款）

AnswerMaker 不自己实现账号体系，也不保存 token；在线内容登录复用 CodeMaker 生态里的
**网易 OpenID 统一鉴权**，由 `popo-cli` 托管（登录、令牌刷新、身份注入都在 CLI 内完成）。
KM 与 POPO 官方技能同样要求：所有在线读取必须经过 `popo-cli`，不得直连上游 API。

依赖安装：

```bash
npm i -g @popo/cli
popo-cli auth status    # 查看当前登录状态
popo-cli auth login     # 浏览器 OpenID 登录（CLI 自动打开浏览器）
```

应用内入口：「设置 → 在线内容登录」可查看登录状态、调起 OpenID 登录、刷新令牌、登出。
登录成功后，「知识库」的链接输入框会真实读取正文并按与本地文件相同的规则切块入库：

| 链接域名 | 实际命令 |
| --- | --- |
| `km.netease.com` / `kms-int.netease.com` | `popo-cli km resource_detail url=<URL>`（正文缺失时再按类型+ID 拉全文） |
| `docs.popo.netease.com`（云空间文档） | `popo-cli popo doc_get_doc_detail docId=<ID>` |
| `docs.popo.netease.com/team/pc/.../pageDetail/...` | 先 `doc_get_folder_path url=<URL>` 取 `teamSpaceId`，再 `doc_get_doc_detail docId=<ID> teamSpaceId=<ID>` |

实现位置：`src-tauri/src/popo.rs`（命令）、`src/bridge.ts`（前端封装）、
`src/modules/Settings.tsx`（登录入口）、`src/modules/Knowledge.tsx`（读取→切块→BM25）。
凭据存放在 `popo-cli` 自己的凭据库中，AnswerMaker 只读状态、不接触 token。
`docs.popo.netease.com/pages/...` 多维表链接会明确提示暂不支持；浏览器预览无本地后端时仅登记链接。

## 本地模型与 Agent（新增）

### Ollama 自动检测与拉起

应用启动时会调用 `ollama_status`：

- 未安装：Windows 通过 `winget install Ollama.Ollama` 自动安装；macOS 通过 `brew install ollama`；
- 未运行：自动执行 `ollama serve`；
- 推荐模型未下载：自动 `ollama pull <推荐模型>`，前端轮询状态显示进度。

推荐规则（按显存 / 内存自动选择）：

| 硬件 | 推荐模型 |
| --- | --- |
| 显存 ≥ 8GB | `qwen2.5:7b` |
| 显存 ≥ 4GB | `qwen2.5:3b`（本机 GTX 1650 4GB 即此档） |
| 内存 ≥ 16GB | `qwen2.5:3b`（CPU 推理） |
| 其他 | `qwen2.5:1.5b` |

模型目录：`%USERPROFILE%\.ollama\models`（可用 `OLLAMA_MODELS` 覆盖）。
「设置 → 本地模型（Ollama）」提供安装 / 启动 / 下载推荐模型 / 刷新等手动控制。

### 本地 Agent CLI

支持探测并调用 **CodeMaker / Claude Code / Codex / Gemini CLI**：

- 聊天区模型选择「本地 Agent CLI」后，再选择具体 Agent；
- 非交互执行：CodeMaker `run`、Claude `-p`（stdin 传 prompt）、Codex `exec --skip-git-repo-check`、Gemini `-p`；
- RAG 模式会把知识库检索片段作为上下文拼接进 prompt；
- 240 秒超时、ANSI 清理；Codex 使用 `-o` 只取最后一条回复，CodeMaker 过滤终端 UI 行；
- 仅允许固定白名单，不接受任意命令；Agent 以本机 CLI 权限运行，请自行确认其登录与授权状态。

### 聊天区：RAG + 本地搜索已合并

聊天模式简化为两个：

- **智能聊天**（默认）：每次发送都会自动匹配知识库（BM25）、文件/链接名称与保险库；
  - 文件/链接名称命中卡片**优先展示**在最前；
  - 知识库/RAG 命中卡片**默认折叠**，只显示匹配行与来源，点「展开」查看全文与「复制片段」；
  - 知识片段作为模型上下文传给 Ollama / 本地 Agent CLI；
  - 保险库只传 `vault://` 引用与元数据，**绝不把明文密码传给模型**；
  - 命中结果在回复中以卡片展示，知识片段带来源与「复制片段」，保险库卡片带「复制密码 / 复制 JSON」；
  - 锁定状态只检索 key/type/url；解锁后额外解密并检索 value/account；
  - 模型不可用时，自动回退为 RAG 摘录式回答 + 命中卡片。
- **仅搜索**：不调用模型，只展示知识库、文件/链接与保险库的原始命中。
- V0.1 旧明文条目也会被检索并标注「建议迁移」。

### 文件管理（新增）

知识库录入时自动归档到「文件管理」：

- **在线链接**：录入时可填「自定义名称」；留空则使用抓取到的内容标题；两者都没有时用 URL
- **本地文件**：使用文件名（桌面端同时记录绝对路径）
- 归档列表展示名称、类型（链接/文件）、源地址、导入时间、大小、关联知识文档，可按名称/地址过滤、按类型筛选
- **Tab 分组切换**：`已同步 RAG`（已切块入库）/ `仅登记`（关联知识文档但未切块，如 PDF/Word）/ `单独新增`（仅文件管理登记、未同步 RAG），Tab 上显示各分组数量
- 「打开」：HTTP/HTTPS 用系统浏览器；本地路径用资源管理器打开（文件会定位并选中）
- 「复制地址」：复制源链接或本地路径
- 聊天「仅搜索 / 智能聊天」会同时匹配文件/链接名称，命中时返回文件卡片，带「打开 / 复制地址」
- 从文件管理移除不会删除知识库文档；知识库「编辑来源」会把新地址同步到归档记录

实现：`src/files.ts`、`src/modules/Files.tsx`、`src/modules/FileHitCard.tsx`；
后端命令 `open_url`（浏览器）与 `open_path`（资源管理器）。

### POPO 空间导入（新增）

知识库页「从 POPO 导入」支持浏览并一键导入：

- **个人空间（云空间）**：`doc_get_folder_children folderId=0`（不传 teamSpaceId）
- **团队空间**：`doc_search_teamspace keyword=` 列出全部有权限空间，再用 `doc_get_folder_children folderId=0 teamSpaceId=<ID>` 列根目录
- 支持进入子文件夹、返回上级、刷新、全选当前目录、批量勾选
- 切换个人/团队空间或目录时显示加载态；拉取失败会展示错误原因和「重试」按钮
- 请求带序号保护，快速切换空间时旧响应不会覆盖新目录
- 导入规则：
  - POPO 文档（docType=1）拉取正文并去 HTML 标签；Markdown（docType=4）保留原文
  - 按 512/80 切块入本地 BM25 索引，同时写入「文件管理」归档（关联知识文档）
  - 表格 / 多维表 / 文件类节点暂不支持解析正文，仅登记链接
  - 同一来源 URL 已存在时自动跳过
- POPO CLI 调用在应用内**串行化**并设置 45 秒超时，避免并发锁导致界面卡死

### 知识库溯源

每条知识文档保存 `origin`（原始文件绝对路径或在线链接）与 `importedAt`（导入时间），列表与搜索结果都会展示，并支持「复制来源 / 编辑来源」。
在线链接录入时可填自定义名称（留空用内容标题），本地文件使用文件名；所有录入项同时归档到「文件管理」。
桌面端拖拽文件使用 Tauri 原生 drag-drop 获取绝对路径；「选择文件入库」使用 `tauri-plugin-dialog` 原生文件选择器；浏览器预览只能拿到文件名。

## V0.2 已实现（真实功能）

- **保险库真实加密（WebCrypto 版）**：首次进入设置主密码，PBKDF2-SHA256（210,000 次迭代，随机 salt）派生 AES-GCM 256 密钥；每条目 value 独立随机 IV 加密，type=account 时 account 同样加密，之后才写入本地 SQLite——落盘只有密文（自查与序列化检查均未发现明文 value/account，解密往返正确）。解锁/锁定流程完整：密钥只存内存变量，锁定即清除；密码错误有明确报错（校验块解密校验）。列表仍只显示 `vault://<key>/<type>` 引用与掩码，点「复制」需已解锁 + 确认授权，复制内容为该条目的 JSON 源数据（含 id 与五个字段），明文不上屏。每条目支持「改名」：可修改 key（平台名/详细类型）、type、url，value/account 密文保持不变；vault:// 引用会随 key/type 更新。
  - 与 PRD 桌面端口径的差异：桌面端（Rust）最终用 **Argon2id** 派生；WebCrypto 没有 Argon2id，故浏览器版用 PBKDF2-SHA256 替代。加密算法（AES-256-GCM）、每条目独立 IV、密钥只存内存等语义与 PRD §14 一致。
  - **旧数据迁移**：检测到 V0.1 明文 `am_vault` 时，保险库顶部出现提示横幅，提供「一键迁移（重新加密后删除明文，并自动自查无明文残留）」或「清空旧数据」，不会静默丢失；V0.1 的知识库模拟文档则自动降级为「仅登记」并注明原因。
- **知识库真实入库与本地搜索**：拖入/选择 `.txt/.md/.csv/.json/.html` 时用 `File.text()` 真实读取正文（HTML 自动去标签），按段落优先、约 512 字符、重叠 80 真实切块，切块正文写入 SQLite 的 `chunks` 表；本地搜索与 RAG 模式走真实 BM25 检索，返回真实命中片段、标注来源文档名，搜索结果高亮关键词；RAG 回退回答直接引用检索到的片段原文。
  - KM 文章与 POPO 文档链接经 `popo-cli`（OpenID 鉴权）真实拉取正文，再走同一套切块 + BM25 入库流程，可直接被本地搜索 / RAG 使用。
  - 容量：不再受 localStorage 约 5MB 限制，落 SQLite（WAL）；检索仍为内存 BM25，后续可迁移到 SQLite FTS5 / Rust 实现以支持更大规模。
- **Node 版 MCP 服务端 + CLI**：见上节。MCP 现有 16 个工具（知识库 BM25、文件管理、保险库引用与临时密钥取用、统一检索 `search_all`、POPO 空间/链接读取、server_info/server_status）；CLI 支持同名能力。`npm run mcp:smoke` 已通过 20/20（含 POPO 在线测试时 22/22），覆盖鉴权、CORS、批量请求、参数校验、密钥请求生命周期与全部数据工具。
- **聊天接 Ollama**：模型选 Ollama 时真实请求 `http://localhost:11434/api/chat`（非流式，模型名输入框默认使用推荐模型）；RAG 模式会把真实检索片段作为上下文发给 Ollama。请求失败自动回退本地模拟，并在消息开头明确标注「⚠ Ollama 未连接，以下为本地模拟」。
- **聊天区 UI**：CodeMaker 风格圆角输入框（随内容自动增高、模型/Agent/模式 chips、纸飞机发送按钮：默认浅色主题色、hover 填充并微抬升、禁用态灰化；Enter/Shift+Enter 提示在宽屏显示）；各按钮均有 hover / focus-visible / active 反馈。右侧「对话轮次」列表按用户轮次展示，带「聊天 / RAG / 搜索」类型徽标，点击可平滑跳转到对应消息。
- 三栏布局与 V0.1 的模型/模式切换、MCP 网关面板、匹配识别候选清单（模拟识别结果，确认后加密入库）等保持不变。

## V0.3 已实现（安全组第一批）

- **MCP 默认只听本机**：服务端默认绑定 127.0.0.1，本机模式 CORS 仅允许本机来源；局域网需显式开启（环境变量 `ANSWERMAKER_MCP_LAN=1` 或应用面板开关），开启时启动日志与面板均有风险提示，`server_info` / `server_status` / 健康检查返回 `bind` / `lan`
- **多客户端 Token**：`tokens.json` 按客户端管理（名称/创建时间/最后使用/撤销），旧 env / `mcp-token.txt` 兼容为 default；服务端按文件 mtime 热加载，新增/撤销无需重启
- **审计**：`audit.log`（JSONL，append-only）记录 auth_fail / tool_call / secret_request / secret_status / secret_release，含申请客户端名、ref、用途与结果；应用授权/拒绝经 Rust 回写同一日志；不记录 Token 值与密钥明文
- **保险库前端安全**：复制条目明文 JSON 后 30 秒自动清空剪贴板（清空前读回比对，避免误删用户新复制内容）；解锁后闲置 5 分钟自动锁定（可在保险库页关闭，默认开）

## V0.2 未实现（如实标注）

- **Rust 原生**：已在本机编译通过（`cargo check` / `tauri dev`）；`vault_crypto.rs` 的 Argon2id 实现仍为占位（桌面端加密以 WebCrypto 版为当前可用实现）
- **PDF/Word 解析**：拖入二进制格式只登记元数据并明确提示「暂不支持解析」，不切块
- **在线文档**：KM / POPO 文档已经 popo-cli 真实读取并按链接手动入库；其他域名仍仅登记（受 CORS/鉴权限制）；内容/权限/删除的自动同步（ETag/版本校验）未实现
- **云端向量库**：仅预留接口，界面标注「待开发」，不实现、不上传
- **Embedding/向量检索**：当前检索为 BM25 关键词检索；bge-m3 + LanceDB 混合检索为桌面端规划
- **聊天 OpenAI/Claude**：模型下拉里的 OpenAI / Claude 仍是本地模拟；要接真实 Claude 请选「本地 Agent CLI → Claude Code」
- **Ollama / Agent 限制**：Ollama 首次自动安装依赖 winget/brew 与网络，模型下载体积较大；本地 Agent 为非流式调用（最长 240 秒），不展示逐 token 输出
- **保险库检索**：密码明文检索需要先解锁；锁定状态只检索 key/type/url 元数据。保险库「匹配识别」的真实文件扫描仍为模拟候选

## 后续路线

- **V0.3**：安全组第一批已完成（见上）；剩余：保险库从 WebCrypto 迁移到 Rust Argon2id + `.enc` 落盘与系统钥匙串；PDF 解析；在线文档自动同步（ETag/版本校验 + 权限/删除同步）；聊天接 OpenAI/Claude
- **V1.0**：macOS（P1）适配与打包（含 icon.icns）、知识库迁移 SQLite FTS5/向量索引 + bge-m3 混合检索、云端向量库（当前仅预留接口，备注待开发，转排期前需补齐设计）
