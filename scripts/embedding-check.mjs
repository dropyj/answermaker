// 项3 向量检索 Node 自查：用 @xenova/transformers 对中文句子做 embedding，
// 验证「语义相近句的余弦 > 不相干句」这一基本盘，并打印实际数值。
// 运行：node scripts/embedding-check.mjs（首次会下载约 100MB 模型到本地缓存）
import { pipeline } from "@xenova/transformers";

const MODEL = "Xenova/bge-small-zh-v1.5";
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

const ex = await pipeline("feature-extraction", MODEL, { quantized: true });
async function embed(texts) {
  const out = await ex(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  return texts.map((_, i) => new Float32Array(out.data.slice(i * dim, (i + 1) * dim)));
}
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

const [q, near, far] = await embed([
  QUERY_PREFIX + "如何重置服务器的账号密码",
  "在服务器上运行重置命令即可修改登录密码，并使旧会话失效",
  "周末去郊外野餐，记得带上防晒霜和折叠椅",
]);
const cosNear = cos(q, near);
const cosFar = cos(q, far);
console.log(`cos(查询, 相近句) = ${cosNear.toFixed(4)}`);
console.log(`cos(查询, 不相干句) = ${cosFar.toFixed(4)}`);
if (cosNear > cosFar) {
  console.log("PASS embedding 语义区分成立");
} else {
  console.log("FAIL embedding 语义区分不成立");
  process.exit(1);
}
