/**
 * 生成ルール定義
 * ============================================================
 * このファイルを編集すると、どんなプロンプトを通す/弾くかを自分で決められます。
 * 判定ロジック本体は lib/policy.js にあります。
 *
 * ルールの書き方:
 *   { id, label, message, enabled, any: [...] }
 *     → any のいずれかの語が含まれたらブロック
 *   { id, label, message, enabled, all: [[...], [...]] }
 *     → 各グループから最低1語ずつ含まれたらブロック(組み合わせ判定)
 *   語は文字列(部分一致・大文字小文字無視・全角半角正規化済み)か正規表現。
 *
 * legal 配下は日本法上どのみち公開できないもの。削除しないでください。
 * custom 配下は完全に自分の判断で有効/無効・追加・削除して構いません。
 */

const MINOR_TERMS = [
  "loli", "lolita", "ロリ", "shota", "ショタ",
  "child", "children", "kid", "kids", "toddler", "infant", "baby",
  "underage", "minor", "preteen", "teen", "teenager", "schoolgirl", "schoolboy",
  "未成年", "幼女", "幼児", "園児", "小学生", "中学生", "高校生", "女子高生", "JK", "JC", "JS",
  "少女", "少年", "子供", "こども", "子ども", "児童", /\b1[0-7]\s*(years?|yo|歳|才)\b/i, /\b[1-9]\s*(years?|yo|歳|才)\b/i,
];

// 未成年語との組み合わせ判定にのみ使用(単体では弾かない)
const SEXUAL_TERMS = [
  "nude", "naked", "nsfw", "sex", "sexual", "porn", "hentai", "erotic", "explicit",
  "genital", "genitals", "penis", "vagina", "pussy", "nipple", "nipples", "breasts", "topless", "lingerie", "bikini",
  "裸", "全裸", "半裸", "ヌード", "性交", "性的", "エロ", "陰部", "乳首", "おっぱい", "巨乳", "下着", "水着", "セックス", "R18", "R-18", "18禁",
];

export default {
  /* ---------- 法律上の禁止(削除しない) ---------- */
  legal: [
    {
      id: "csam",
      label: "未成年の性的描写",
      message: "未成年を性的に描く内容は生成できません。",
      enabled: true,
      all: [MINOR_TERMS, SEXUAL_TERMS],
    },
  ],

  /* ---------- 自分で決めるルール(自由に編集) ---------- */
  // 既定では何も制限しません。必要になったら下の例のように追加してください。
  // 例:
  //   {
  //     id: "real-person",
  //     label: "特定の実在人物",
  //     message: "実在人物の生成は許可されていません。",
  //     enabled: true,
  //     any: ["山田太郎", "taro yamada"],
  //   },
  custom: [],

  /* ---------- 数値上限 ---------- */
  limits: {
    maxPromptLength: 1000,
    minSize: 256,
    maxSize: 1536,   // 幅・高さの上限(px)。GPUメモリと生成時間に直結します
    maxSteps: 50,
    // 参照画像つき編集
    edit: {
      maxImages: 3,
      maxImageBytes: 2.5 * 1024 * 1024, // ブラウザ側で長辺 1024px に縮小して送ります
      defaultSteps: 40,
      defaultCfg: 4.0,
    },
  },

  /* ---------- プロンプト加工 ---------- */
  // 全プロンプトの末尾に自動で付け足す文字列(画風の統一など)。不要なら空文字。
  promptSuffix: "",
};
