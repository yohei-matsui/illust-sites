import { checkPrompt } from "../lib/policy.js";
import { json, checkAccess, callWorker, readJsonBody } from "../lib/http.js";
import policy from "../policy/policy.js";

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** 参照画像つき編集: 1枚目=体・構図を保つ側、2枚目=顔・人物の参照 */
export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST のみ" });
  if (!checkAccess(req)) return json(res, 401, { error: "アクセスキーが違います" });

  const body = readJsonBody(req);
  const verdict = checkPrompt(body.prompt);
  if (!verdict.ok) {
    return json(res, 422, { blocked: true, ruleId: verdict.ruleId, label: verdict.label, error: verdict.message });
  }

  const images = Array.isArray(body.images) ? body.images : [];
  const { edit } = policy.limits;
  if (images.length < 1 || images.length > edit.maxImages) {
    return json(res, 400, { error: `画像は 1〜${edit.maxImages} 枚必要です` });
  }
  for (const img of images) {
    if (typeof img !== "string" || !DATA_URL.test(img)) {
      return json(res, 400, { error: "画像は PNG / JPEG / WebP の data URL で送ってください" });
    }
    if (img.length > edit.maxImageBytes * 4 / 3 + 64) {
      return json(res, 413, { error: "画像が大きすぎます。長辺 1024px 程度に縮小してください" });
    }
  }

  const stepsNum = Number(body.steps);
  const cfgNum = Number(body.cfg);
  const seedNum = Number(body.seed);
  const params = {
    prompt: verdict.prompt,
    images,
    negative_prompt: typeof body.negativePrompt === "string" ? body.negativePrompt.slice(0, 500) : " ",
    steps: Number.isInteger(stepsNum) && stepsNum > 0 ? Math.min(policy.limits.maxSteps, stepsNum) : edit.defaultSteps,
    cfg: Number.isFinite(cfgNum) ? Math.min(10, Math.max(1, cfgNum)) : edit.defaultCfg,
    seed: Number.isInteger(seedNum) && seedNum >= 0 ? seedNum : null,
  };

  try {
    const data = await callWorker("/edit", { method: "POST", body: params });
    return json(res, 202, { jobId: data.job_id, params: { steps: params.steps, cfg: params.cfg, seed: params.seed } });
  } catch (e) {
    return json(res, e.status && e.status >= 400 && e.status < 500 ? 502 : 500, { error: e.message });
  }
}
