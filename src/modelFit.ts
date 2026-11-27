// 聊天模型 × 本机配置适配比对（纯函数，供 UI 与 scripts/fit-check.mjs 自查）。
//
// 判定口径（与 docs/architecture-and-todo.md「聊天本地模型管理」节同步）：
// 以目录条目的 ramGB（建议内存）与 sizeGB（约体积）为基准——
//   内存：可用内存 ≥ ramGB → 该项过关；≥ sizeGB×1.3（最低线）但 < ramGB →
//         tight（能跑但紧）；低于最低线 → no。
//   磁盘：freeDiskGB 已知且 < sizeGB → 直接 no（装不下）；未知只提示不判负。
//   GPU：检测到显存 ≥ sizeGB → 标「可 GPU 加速」；否则（只有核显、非 NVIDIA
//         独显探测不到显存、或显存不足）按 CPU 推理给速度经验预估。
//   内存未知时整体最高只给 tight（保守）。综合等级取各硬项的最差者。
// 速度区间是经验预估（Q4 量化、短中上下文），文案里明示「经验值」，
// 实际随 CPU/GPU 型号、核数与上下文长度而异，不是实测承诺。

import type { ChatModelInfo } from "./chatModels";
import type { EmbeddingModelInfo } from "./models";
import type { MachineInfo } from "./machineInfo";

export type FitLevel = "good" | "tight" | "no";

export interface ModelFit {
  level: FitLevel;
  /** 可读原因行：内存 / 磁盘 / GPU / 速度各一行，含本机数值与要求数值。 */
  reasons: string[];
  /** 速度预估文案（经验值）。 */
  estNote: string;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function paramsB(params: string): number {
  const v = Number.parseFloat(params);
  return Number.isFinite(v) ? v : 0;
}

/** CPU 推理经验速度（tok/s），按参数量分档。 */
function cpuSpeedRange(b: number): string {
  if (b <= 1) return "约 25–60 tok/s";
  if (b <= 2) return "约 18–40 tok/s";
  if (b <= 4) return "约 10–25 tok/s";
  if (b <= 9) return "约 5–12 tok/s";
  if (b <= 16) return "约 2.5–6 tok/s";
  return "约 1–3 tok/s";
}

/** GPU 加速经验速度（tok/s），按参数量分档。 */
function gpuSpeedRange(b: number): string {
  if (b <= 1) return "约 60–120 tok/s";
  if (b <= 2) return "约 45–90 tok/s";
  if (b <= 4) return "约 30–70 tok/s";
  if (b <= 9) return "约 25–55 tok/s";
  if (b <= 16) return "约 12–28 tok/s";
  return "约 6–14 tok/s";
}

export function assessModelFit(
  info: MachineInfo,
  model: Pick<ChatModelInfo, "params" | "sizeGB" | "ramGB">,
): ModelFit {
  const reasons: string[] = [];
  let level: FitLevel = "good";
  const downgrade = (l: FitLevel) => {
    if (l === "no") level = "no";
    else if (l === "tight" && level === "good") level = "tight";
  };
  const minRam = model.sizeGB * 1.3;

  // 内存
  if (info.totalRamGB === null) {
    reasons.push("内存：未检测到本机内存总量，无法确认是否达到建议值，按保守口径判定");
    downgrade("tight");
  } else if (info.totalRamGB >= model.ramGB) {
    reasons.push(`内存：本机 ${fmt(info.totalRamGB)} GB ≥ 建议 ${fmt(model.ramGB)} GB，充足`);
  } else if (info.totalRamGB >= minRam) {
    reasons.push(`内存：本机 ${fmt(info.totalRamGB)} GB 低于建议 ${fmt(model.ramGB)} GB，但高于最低线 ${fmt(minRam)} GB（体积×1.3），能跑但紧，长上下文可能吃紧`);
    downgrade("tight");
  } else {
    reasons.push(`内存：本机 ${fmt(info.totalRamGB)} GB 低于最低线 ${fmt(minRam)} GB（模型体积约 ${fmt(model.sizeGB)} GB ×1.3），不建议运行`);
    downgrade("no");
  }

  // 磁盘（只看模型盘剩余是否装得下）
  if (info.freeDiskGB === null) {
    reasons.push(`磁盘：未检测到模型盘剩余空间，请自行确认至少留出约 ${fmt(model.sizeGB)} GB`);
  } else if (info.freeDiskGB < model.sizeGB) {
    reasons.push(`磁盘：模型盘仅剩 ${fmt(info.freeDiskGB)} GB，装不下约 ${fmt(model.sizeGB)} GB 的模型`);
    downgrade("no");
  } else {
    reasons.push(`磁盘：模型盘剩余 ${fmt(info.freeDiskGB)} GB ≥ 模型约 ${fmt(model.sizeGB)} GB，足够`);
  }

  // GPU 与速度预估
  const b = paramsB(model.params);
  const gpuAccel = info.gpuVramGB !== null && info.gpuVramGB >= model.sizeGB;
  let estNote: string;
  if (gpuAccel) {
    reasons.push(`GPU：检测到显存 ${fmt(info.gpuVramGB as number)} GB ≥ 模型约 ${fmt(model.sizeGB)} GB，可 GPU 加速`);
    estNote = `速度预估（经验值）：GPU 加速 ${gpuSpeedRange(b)}，实际随显卡与上下文长度而异`;
  } else {
    const gpuTxt = info.gpuVramGB !== null
      ? `显存 ${fmt(info.gpuVramGB)} GB 小于模型约 ${fmt(model.sizeGB)} GB`
      : "未检测到独立显存（显存目前仅经 nvidia-smi 探测 NVIDIA 独显）";
    reasons.push(`GPU：${gpuTxt}，按 CPU 推理估算`);
    estNote = `速度预估（经验值）：CPU 推理 ${cpuSpeedRange(b)}，实际随 CPU 型号与核数而异`;
  }
  reasons.push(estNote);

  return { level, reasons, estNote };
}

// ---- 语义（embedding）模型适配：口径与聊天侧同构，基准换成估算运行内存 ----
//
// embedding 模型目录没有 ramGB 字段，运行内存按经验公式估算（标经验估算）：
//   estRamGB = 量化体积(GB) × 4 + 0.3GB 基础开销
// （WASM/ONNX 运行时 + 权重展开 + 批量推理缓冲的粗估，不是实测）。
// 判定：内存 ≥ estRamGB 过关；≥ estRamGB×0.7（最低线）但不足为 tight；
// 低于最低线为 no；内存未知封顶 tight。磁盘按体积直比：freeDiskGB 已知且
// 小于体积直接 no，未知只提示。向量维度与速度只写说明行，不参与判定。

/** embedding 估算运行内存（GB，经验值）：量化体积 ×4 + 0.3GB 基础开销。 */
export function embeddingRunRamGB(m: Pick<EmbeddingModelInfo, "approxSizeMB">): number {
  return (m.approxSizeMB / 1024) * 4 + 0.3;
}

export function assessEmbeddingFit(
  info: MachineInfo,
  m: Pick<EmbeddingModelInfo, "approxSizeMB" | "dim" | "speedNote">,
): ModelFit {
  const reasons: string[] = [];
  let level: FitLevel = "good";
  const downgrade = (l: FitLevel) => {
    if (l === "no") level = "no";
    else if (l === "tight" && level === "good") level = "tight";
  };
  const sizeGB = m.approxSizeMB / 1024;
  const estRam = embeddingRunRamGB(m);
  const minRam = estRam * 0.7;
  const estNote = `运行内存估算（经验值）：量化体积约 ${fmt(sizeGB)} GB ×4 + 0.3 GB 基础开销 ≈ ${fmt(estRam)} GB`;

  // 内存
  if (info.totalRamGB === null) {
    reasons.push("内存：未检测到本机内存总量，无法确认是否达到估算运行内存，按保守口径判定");
    downgrade("tight");
  } else if (info.totalRamGB >= estRam) {
    reasons.push(`内存：本机 ${fmt(info.totalRamGB)} GB ≥ 估算运行内存 ${fmt(estRam)} GB，充足`);
  } else if (info.totalRamGB >= minRam) {
    reasons.push(`内存：本机 ${fmt(info.totalRamGB)} GB 低于估算运行内存 ${fmt(estRam)} GB，但高于最低线 ${fmt(minRam)} GB，能跑但紧，批量回填可能较慢`);
    downgrade("tight");
  } else {
    reasons.push(`内存：本机 ${fmt(info.totalRamGB)} GB 低于最低线 ${fmt(minRam)} GB（估算运行内存 ${fmt(estRam)} GB ×0.7），不建议运行`);
    downgrade("no");
  }

  // 磁盘（按量化体积直比）
  if (info.freeDiskGB === null) {
    reasons.push(`磁盘：未检测到剩余空间，请自行确认至少留出约 ${fmt(sizeGB)} GB`);
  } else if (info.freeDiskGB < sizeGB) {
    reasons.push(`磁盘：剩余 ${fmt(info.freeDiskGB)} GB，装不下约 ${fmt(sizeGB)} GB 的模型`);
    downgrade("no");
  } else {
    reasons.push(`磁盘：剩余 ${fmt(info.freeDiskGB)} GB ≥ 模型约 ${fmt(sizeGB)} GB，足够`);
  }

  // 维度/速度只作说明，不参与判定
  reasons.push(`说明：${m.dim} 维向量；速度特点——${m.speedNote}（维度与速度不参与适配判定）`);
  reasons.push(estNote);

  return { level, reasons, estNote };
}
