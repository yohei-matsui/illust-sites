/** Vercel 関数の共通処理(認証・ワーカー呼び出し) */

export function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** SITE_ACCESS_KEY を設定している場合は x-access-key ヘッダで照合する */
export function checkAccess(req) {
  const required = process.env.SITE_ACCESS_KEY;
  if (!required) return true;
  const given = req.headers["x-access-key"];
  return typeof given === "string" && given.length === required.length && given === required;
}

export function workerConfig() {
  const url = (process.env.WORKER_URL || "").replace(/\/+$/, "");
  const token = process.env.WORKER_TOKEN || "";
  if (!url || !token) {
    throw new Error("WORKER_URL / WORKER_TOKEN が設定されていません(Vercel の環境変数を確認してください)");
  }
  return { url, token };
}

export async function callWorker(path, { method = "GET", body } = {}) {
  const { url, token } = workerConfig();
  const r = await fetch(url + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { detail: text.slice(0, 500) };
  }
  if (!r.ok) {
    const err = new Error(data.detail || data.error || `worker error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length > 0) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}
