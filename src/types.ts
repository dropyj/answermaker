export type VaultType = "ssh key" | "api key" | "account" | "token" | "certificate" | "file";
export interface VaultItem {
  id: string;
  key: string; // 平台名
  value: string; // 值（明文只存在于解锁后的内存中；落盘为 WebCrypto 加密，见 crypto.ts）
  type: VaultType;
  account: string;
  url: string;
}
export const vaultRef = (i: { key: string; type: VaultType }) => `vault://${i.key}/${i.type.replace(/\s/g, "-")}`;

export type DocSource = "本地文件" | "在线链接";
export type IngestStage = "解析" | "切分" | "向量化" | "索引" | "已入库" | "仅登记" | "同步中";
export type DocStatus = "indexed" | "registered"; // indexed=真实切块已入库；registered=仅登记元数据（无正文）
export interface KnowledgeDoc {
  id: string;
  name: string;
  source: DocSource;
  chunks: number; // indexed 时为真实切块数；registered 时为 0
  stage: IngestStage;
  status: DocStatus;
  syncStatus: string; // 同步/入库状态说明
  mirror?: string; // 在线文档的本地明文镜像摘要
  content?: string; // 在线链接拉取到的正文（KM/POPO 文档经 popo-cli）
  size?: number; // 源文件字节数（本地文件）
  origin?: string; // 原始文件绝对路径或在线链接（溯源用）
  importedAt?: number; // 导入时间戳（毫秒）
  accountId?: string; // 在线来源所属授权账号（WF5）；本地文件为空
}

/** POPO 团队空间。 */
export interface PopoTeamSpace {
  id: string;
  name: string;
  key?: string | null;
  updated_at?: string | null;
}

/** POPO 云空间/团队空间目录条目。 */
export interface PopoSpaceItem {
  id: string;
  name: string;
  kind: string; // folder | doc | markdown | sheet | file | mtable | other
  doc_type: number;
  url: string;
  team_space_id?: string | null;
  has_children: boolean;
  created_at: number;
  creator?: string | null;
}

export interface PopoSpaceList {
  items: PopoSpaceItem[];
  more: boolean;
  next_cursor?: string | null;
}

export interface SearchHit {
  docId: string;
  docName: string;
  chunkIndex: number;
  text: string;
  /** 最终排序分（基础分 + 反馈调整）；基础分见 bm25Score / vecScore。 */
  score: number;
  /** BM25 基础分（反馈闭环接入后保留原值，便于展示与排查）。 */
  bm25Score?: number;
  /** 向量通道基础分（项3 向量检索开启时才有；未开启为 undefined）。 */
  vecScore?: number;
  /** 召回反馈调整量（已计入 score）；0/undefined 表示未受反馈影响。 */
  fbAdj?: number;
  /** 反馈方向标注：up=因你的反馈加权，down=因你的反馈降权。 */
  fbDir?: "up" | "down";
}

/** 召回反馈（项3b）：用户对检索结果的显式 👍/👎 与打开行为弱信号，存 SQLite retrieval_feedback。 */
export interface RetrievalFeedback {
  id: string;
  query: string;
  /** 片段唯一键：`${docId}#${chunkIndex}` */
  chunkId: string;
  docId: string;
  /** 显式反馈 +1/-1；打开弱信号固定 +0.3（kind=open）。 */
  signal: number;
  kind: "explicit" | "open";
  bm25Score: number | null;
  vecScore: number | null;
  createdAt: number;
}

/** 文件管理归档条目：知识库录入的文件或在线链接。 */
export type FileKind = "file" | "link";
export interface FileEntry {
  id: string;
  name: string; // 链接：自定义名称或内容标题；文件：文件名
  kind: FileKind;
  source: string; // http(s) 链接或本地绝对路径
  docId?: string; // 关联的知识库文档 id
  importedAt: number;
  size?: number;
  status?: DocStatus;
  accountId?: string; // 在线来源所属授权账号（WF5）；本地文件为空
}

/** MCP 密钥临时取用请求（只在应用内展示，不含明文）。 */
export interface SecretRequest {
  id: string;
  vaultId?: string;
  key: string;
  type: string;
  ref: string;
  client?: string;
  purpose?: string;
  ttlSec?: number;
  createdAt?: number;
}

/** popo-cli OpenID 登录状态（与 CodeMaker 同款鉴权）。 */
export interface PopoAuthStatus {
  logged_in: boolean;
  user?: string | null;
  method?: string | null;
  expires_at?: string | null;
  device_id?: string | null;
  message?: string | null;
}

/** 在线链接读取结果。 */
export interface LinkReadResult {
  url: string;
  kind: string; // "km" | "popo-doc"
  title?: string | null;
  content?: string | null;
  summary?: string | null;
}

export type ChatMode = "chat" | "rag" | "search";
export type ModelId = "ollama" | "openai" | "claude" | "agent";

/** 保险库检索命中：不携带明文，复制时按 id 现场解密。 */
export interface VaultHit {
  id: string;
  key: string;
  type: VaultType;
  url: string;
  accountMasked: string;
  valueMasked: string;
  matchedSecret: boolean; // 是否命中了明文 value/account
  locked: boolean;
  legacy: boolean; // V0.1 明文旧数据（建议迁移）
  score: number;
}

/** 本地 Ollama 运行环境状态。 */
export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  models_dir: string;
  models: string[];
  recommended_model: string;
  recommended_reason: string;
  ram_gb: number;
  vram_gb: number;
  gpu: string;
}

/** 本机硬件信息（Rust machine_info 命令，字段拿不到时为 null）。 */
export interface RustMachineInfo {
  total_ram_gb: number | null;
  cpu_cores: number | null;
  cpu_name: string | null;
  gpu_name: string | null;
  gpu_vram_gb: number | null;
  free_disk_gb: number | null;
  models_dir: string;
}

/** 本地 Agent CLI 探测结果。 */
export interface AgentCli {
  id: string;
  name: string;
  path?: string | null;
  available: boolean;
}

/** 项目空间：跨模块的组织维度，实体通过 ProjectLink 关联（可多属）。 */
export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: number;
  updatedAt: number;
}

export type ProjectEntityType = "doc" | "file" | "vault" | "link" | "system" | "note" | "todo";
export interface ProjectLink {
  id: string;
  entityType: ProjectEntityType;
  entityId: string;
  projectId: string;
}

/** 系统导航条目：常用 Web 系统/应用的地址簿，可关联保险库条目一键复制凭据。 */
export interface SystemEntry {
  id: string;
  name: string;
  url: string;
  description: string; // 功能一句话
  keywords: string; // 搜索关键词（空格分隔）
  projectIds: string[];
  vaultItemId?: string; // 关联的保险库条目 id（加密条目）
  iconUrl?: string;
  accountId?: string; // 在线系统所属授权账号（WF5）；本地/无账号为空
  createdAt: number;
  updatedAt: number;
}

/** 速记笔记（WF2）。 */
export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  pinned?: boolean;
}

/** 待办（WF2）。 */
export interface Todo {
  id: string;
  title: string;
  dueAt?: number;
  priority: "high" | "normal" | "low";
  status: "todo" | "done";
  projectId?: string;
  source?: string;
  createdAt: number;
  updatedAt: number;
}

/** 日程（WF2）。 */
export interface CalEvent {
  id: string;
  title: string;
  startAt: number;
  endAt?: number;
  note?: string;
  projectId?: string;
  remindMin?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 授权账号（WF5）：个人云账号与在线文档授权账号严格隔离管理。
 * popo 会话由 popo-cli 统一托管（见 docs 的隔离边界说明）。
 */
export type AccountKind = "popo" | "personal-cloud" | "doc-source";
export interface Account {
  id: string;
  kind: AccountKind;
  provider: string; // netease-popo | google | notion | feishu | webdav | custom
  label: string;
  identity: string; // 账号显示名/邮箱，未知可空
  status: "connected" | "disconnected";
  createdAt: number;
  updatedAt: number;
}

/** 聊天智能创建的回执（WF2）。 */
export interface CreatedItemRef {
  kind: "note" | "todo" | "event";
  id: string;
  title: string;
  when?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: string[];
  hits?: SearchHit[];
  vaultHits?: VaultHit[];
  fileHits?: FileEntry[];
  systemHits?: SystemEntry[];
  createdItems?: CreatedItemRef[];
  kind?: ChatMode; // 该轮对话的模式：聊天 / RAG / 本地搜索
  vaultLocked?: boolean; // 本轮匹配时保险库处于锁定状态
}

export function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
export function save(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); }
export const uid = () => Math.random().toString(36).slice(2, 10);
export function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "am_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
