/**
 * プロンプト判定ロジック。ルール本体は policy/policy.js を編集してください。
 */
import policy from "../policy/policy.js";

function normalize(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase();
}

function matchTerm(text, term) {
  if (term instanceof RegExp) return term.test(text);
  const t = normalize(term);
  return t.length > 0 && text.includes(t);
}

function ruleHits(text, rule) {
  if (rule.enabled === false) return false;
  if (Array.isArray(rule.any) && rule.any.length > 0) {
    if (rule.any.some((term) => matchTerm(text, term))) return true;
  }
  if (Array.isArray(rule.all) && rule.all.length > 0) {
    if (rule.all.every((group) => group.some((term) => matchTerm(text, term)))) return true;
  }
  return false;
}

/**
 * @returns {{ ok: true, prompt: string } | { ok: false, ruleId: string, label: string, message: string }}
 */
export function checkPrompt(rawPrompt) {
  const prompt = String(rawPrompt ?? "").trim();
  const { limits } = policy;

  if (prompt.length === 0) {
    return { ok: false, ruleId: "empty", label: "空のプロンプト", message: "プロンプトを入力してください。" };
  }
  if (prompt.length > limits.maxPromptLength) {
    return {
      ok: false,
      ruleId: "too-long",
      label: "プロンプトが長すぎます",
      message: `プロンプトは ${limits.maxPromptLength} 文字以内にしてください。`,
    };
  }

  const text = normalize(prompt);
  for (const rule of [...policy.legal, ...policy.custom]) {
    if (ruleHits(text, rule)) {
      return { ok: false, ruleId: rule.id, label: rule.label, message: rule.message };
    }
  }

  const suffix = policy.promptSuffix ? ` ${policy.promptSuffix}` : "";
  return { ok: true, prompt: prompt + suffix };
}

/** 幅・高さ・ステップ数を上限内に丸め、16の倍数に揃える */
export function clampParams({ width, height, steps, seed }) {
  const { limits } = policy;
  const snap = (v, fallback) => {
    const n = Number.isFinite(Number(v)) ? Number(v) : fallback;
    const clamped = Math.min(limits.maxSize, Math.max(limits.minSize, n));
    return Math.round(clamped / 16) * 16;
  };
  const stepsNum = Number(steps);
  const seedNum = Number(seed);
  return {
    width: snap(width, 1024),
    height: snap(height, 1024),
    steps: Number.isInteger(stepsNum) && stepsNum > 0 ? Math.min(limits.maxSteps, stepsNum) : null,
    seed: Number.isInteger(seedNum) && seedNum >= 0 ? seedNum : null,
  };
}

export function describePolicy() {
  return {
    legal: policy.legal.map(({ id, label, enabled }) => ({ id, label, enabled: enabled !== false })),
    custom: policy.custom.map(({ id, label, enabled }) => ({ id, label, enabled: enabled !== false })),
    limits: policy.limits,
  };
}
