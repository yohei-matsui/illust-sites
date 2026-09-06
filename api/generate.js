import { checkPrompt, clampParams } from "../lib/policy.js";
import { json, checkAccess, callWorker, readJsonBody } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST のみ" });
  if (!checkAccess(req)) return json(res, 401, { error: "アクセスキーが違います" });

  const body = readJsonBody(req);
  const verdict = checkPrompt(body.prompt);
  if (!verdict.ok) {
    return json(res, 422, { blocked: true, ruleId: verdict.ruleId, label: verdict.label, error: verdict.message });
  }

  const params = clampParams(body);
  try {
    const data = await callWorker("/generate", {
      method: "POST",
      body: { prompt: verdict.prompt, ...params },
    });
    return json(res, 202, { jobId: data.job_id, params });
  } catch (e) {
    return json(res, e.status && e.status >= 400 && e.status < 500 ? 502 : 500, { error: e.message });
  }
}
