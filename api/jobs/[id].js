import { json, checkAccess, callWorker } from "../../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET のみ" });
  if (!checkAccess(req)) return json(res, 401, { error: "アクセスキーが違います" });

  const id = String(req.query?.id ?? "");
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return json(res, 400, { error: "不正なジョブID" });

  try {
    const data = await callWorker(`/jobs/${encodeURIComponent(id)}`);
    return json(res, 200, data);
  } catch (e) {
    return json(res, 502, { status: "failed", error: e.message });
  }
}
