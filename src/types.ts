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
  score: number;
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

/** 本地 Agent CLI 探测结果。 */
export interface AgentCli {
  id: string;
  name: string;
  path?: string | null;
  available: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: string[];
  hits?: SearchHit[];
  vaultHits?: VaultHit[];
  fileHits?: FileEntry[];
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
