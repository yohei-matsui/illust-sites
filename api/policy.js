import { describePolicy } from "../lib/policy.js";
import { json, checkAccess } from "../lib/http.js";

/** 現在有効なルール一覧(画面表示用)。ワーカー未設定でも動きます */
export default function handler(req, res) {
  if (!checkAccess(req)) return json(res, 401, { error: "アクセスキーが違います" });
  return json(res, 200, { ...describePolicy(), accessKeyRequired: Boolean(process.env.SITE_ACCESS_KEY) });
}
