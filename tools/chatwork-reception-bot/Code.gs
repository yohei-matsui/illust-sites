/**
 * 動画制作 受付Bot + 案件シート
 *
 * 使い方(初回のみ)
 *  1. スプレッドシートの「拡張機能 > Apps Script」にこのファイルを貼り付けて保存
 *  2. 「プロジェクトの設定 > スクリプト プロパティ」に下記を登録
 *       CW_TOKEN    : 事務アカウントのChatwork APIトークン
 *  3. 関数 setupSheet を実行(マスタ・テンプレート・今月タブ・集計・_bot を作る/揃える)
 *  4. 関数 installTrigger を実行(1分おきに poll が動く)
 *
 * 動き
 *  - 依頼テンプレ(「□ 案件名」を含む投稿)を検知 → 10〜15分後に一次返信
 *    (0時〜9時の依頼は 9:00〜9:05 に返信。曜日は問わない)
 *  - 同時に制作グループで森岡さんへ依頼を共有し、案件シートに1行追加
 *  - 事務がToされた投稿は内容で分岐:
 *      修正・確認系      → 依頼者へ定型返信 + 制作グループで森岡さんへ共有
 *      納期・担当の問合せ → 依頼者には返さず、制作グループで森岡さんへメンション
 *      その他            → 「追ってご連絡します」の汎用返信 + 森岡さんへ共有
 *  - 事務へのメンションがない投稿(依頼テンプレ以外)には反応しない
 */

// ===== 設定 =====
const CONFIG = {
  ROOM_CLIENT: '367205288',      // 株式会社TendAi×松井くんチーム
  ROOM_PROD: '407016240',        // 【制作】株式会社TendAi様
  ID_SELF: '11316015',           // 有流悟 理澄 -事務-
  ID_MORIOKA: '10003938',        // 森岡 奈々
  INTERNAL_IDS: ['11316015', '10003938', '7433976', '11286789'], // 事務・森岡・松井・牛嶋
  ASSIGNEES: { '10003938': '森岡', '11286789': '牛嶋', '7433976': '松井' }, // アカウントID → 台帳の担当者名
  ASSIGNERS: ['10003938', '7433976'],  // 割り振りを決められる人(森岡・松井)
  SHARE_MAIL: 'ushikun1130@gmail.com',
  TZ: 'Asia/Tokyo',
  REPLY_MIN_MINUTES: 10,
  REPLY_MAX_MINUTES: 15,
  MORNING_HOUR: 9,
  MORNING_WINDOW_MINUTES: 5,
  SHEET_TEMPLATE: 'テンプレート',   // 月別タブの元(非表示)
  SHEET_MASTER: 'マスタ',
  SHEET_SUMMARY: '集計',
  SHEET_BOT: '_bot',
};

// ===== メッセージ文面 =====
function honorific_(caseName) {
  if (!caseName) return 'このたび';
  return /(さん|様|さま|御中)(（[^）]*）|\([^)]*\))?$/.test(caseName) ? caseName : caseName + 'さま';
}

// 時間帯で挨拶を変える(返信を送る時刻が基準)
function greeting_(when) {
  const h = Number(Utilities.formatDate(when || new Date(), CONFIG.TZ, 'H'));
  if (h >= 5 && h < 11) return 'おはようございます。';
  if (h >= 11 && h < 17) return 'お世話になっております。';
  return 'お疲れさまです。';
}

// 絵文字を7割の確率で付ける
function bow_() { return Math.random() < 0.7 ? '🙇' : ''; }

// 一次返信 5パターン。前回使ったものは避ける
const FIRST_REPLY_PATTERNS = [
  (c) => `${c}のご依頼ありがとうございます。\n納期につきましては、本日〜明日中に追ってご連絡いたします。\n引き続きよろしくお願いいたします`,
  (c) => `${c}のご依頼、承りました。ありがとうございます。\n納期は本日〜明日中にご連絡いたしますので、少々お待ちください。\nよろしくお願いいたします`,
  (c) => `${c}の件、ご依頼ありがとうございます。\n内容を確認のうえ、本日〜明日中に納期をお知らせいたします。\n引き続きよろしくお願いいたします`,
  (c) => `いつもありがとうございます。${c}のご依頼を確認いたしました。\n納期につきましては本日〜明日中に改めてご連絡いたします。\nよろしくお願いいたします`,
  (c) => `${c}のご依頼ありがとうございます。\n担当にて確認し、本日〜明日中に納期をご連絡いたします。\n今しばらくお待ちください`,
];
function pickPattern_() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('LAST_PATTERN') || -1);
  let idx;
  do { idx = Math.floor(Math.random() * FIRST_REPLY_PATTERNS.length); } while (idx === last && FIRST_REPLY_PATTERNS.length > 1);
  props.setProperty('LAST_PATTERN', String(idx));
  return FIRST_REPLY_PATTERNS[idx];
}
function msgFirstReply(toId, toName, caseName) {
  const body = pickPattern_()(honorific_(caseName));
  return `[To:${toId}]${toName}さん\n${greeting_()}\n${body}${bow_()}`;
}
function msgRevisionReply(toId, toName) {
  return `[To:${toId}]${toName}さん\n${greeting_()}\n` +
    '動画のご確認ありがとうございます。\n' +
    `内容を確認のうえ、追ってご連絡いたします${bow_()}`;
}
function msgGenericReply(toId, toName) {
  return `[To:${toId}]${toName}さん\n${greeting_()}\n` +
    'ご連絡ありがとうございます。\n' +
    `内容を確認のうえ、追ってご連絡いたします${bow_()}`;
}
function msgShareGeneric(senderName, link) {
  return `[To:${CONFIG.ID_MORIOKA}]森岡さん\n` +
    `お疲れさまです。${senderName}さんから事務宛にご連絡が届いています。\n` +
    'ご確認をお願いいたします。\n' +
    `メッセージ: ${link}`;
}
function msgShareRequest(req, link, rowNo) {
  return `[To:${CONFIG.ID_MORIOKA}]森岡さん\n` +
    'お疲れさまです。新規のご依頼が届きました。\n' +
    '割り振りと納期のご連絡をお願いいたします。\n\n' +
    `案件名: ${req.caseName || '(記載なし)'}\n` +
    `本数: ${req.count.slice(0, 40)}${req.format ? '(' + req.format + ')' : ''}\n` +
    `希望納期: ${req.due || '記載なし'}\n` +
    `依頼者: ${req.senderName}さん\n` +
    `依頼メッセージ: ${link}\n` +
    `案件シート: ${Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMM')}タブ No.${rowNo}〜`;
}
function msgShareRevision(senderName, link) {
  return `[To:${CONFIG.ID_MORIOKA}]森岡さん\n` +
    `お疲れさまです。${senderName}さんから修正のご依頼が届いています。\n` +
    'ご対応をお願いいたします。\n' +
    `メッセージ: ${link}`;
}
function msgShareInquiry(senderName, link) {
  return `[To:${CONFIG.ID_MORIOKA}]森岡さん\n` +
    `お疲れさまです。${senderName}さんから納期についてお問い合わせが届いています。\n` +
    'ご確認をお願いいたします。\n' +
    `メッセージ: ${link}`;
}

// ===== Chatwork API =====
function cwToken_() {
  const t = PropertiesService.getScriptProperties().getProperty('CW_TOKEN');
  if (!t) throw new Error('スクリプト プロパティ CW_TOKEN が未設定です');
  return t;
}
function cwGet_(path) {
  const res = UrlFetchApp.fetch('https://api.chatwork.com/v2' + path, {
    headers: { 'X-ChatWorkToken': cwToken_() }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 204) return [];
  if (res.getResponseCode() >= 300) throw new Error('Chatwork GET ' + path + ' -> ' + res.getResponseCode() + ' ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function cwPost_(roomId, body) {
  const res = UrlFetchApp.fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: 'post', headers: { 'X-ChatWorkToken': cwToken_() },
    payload: { body: body, self_unread: '0' }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Chatwork POST -> ' + res.getResponseCode() + ' ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function messageLink_(roomId, messageId) {
  return `https://www.chatwork.com/#!rid${roomId}-${messageId}`;
}

// ===== 解析 =====
function stripQuotes_(body) {
  return body.replace(/\[qt\][\s\S]*?\[\/qt\]/g, '').replace(/\[qtmeta[^\]]*\]/g, '');
}
function cleanName_(name) {
  // 「森岡 奈々（9/5対応遅）」「がじゅ@八ッ賀潤一_8/29終日対応できません」→ 表示名のみ
  return name.replace(/[（(].*?[）)]/g, '').replace(/[@＠_※].*$/, '').replace(/\s+\/.*$/, '').trim();
}
function field_(body, label) {
  const m = body.match(new RegExp('□\\s*' + label + '[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*□|$)'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
function isRequest_(body) {
  return /□\s*案件名/.test(body) || /□\s*制作本数/.test(body);
}
function isToSelf_(body) {
  return body.indexOf('[To:' + CONFIG.ID_SELF + ']') >= 0 || body.indexOf('[rp aid=' + CONFIG.ID_SELF) >= 0;
}
function classify_(msg) {
  const body = stripQuotes_(msg.body);
  if (isRequest_(body)) return 'request';          // 依頼テンプレ(メンションの有無を問わず)
  if (!isToSelf_(body)) return null;               // 事務へのメンションがなければ無反応
  if (/修正|直し|変更|差し替え|カット|削除/.test(body)) return 'revision';
  if (/納期|担当|いつ|進捗|状況/.test(body)) return 'inquiry';
  return 'mention';                                // その他の事務宛メンション → 汎用返信+森岡さんへ共有
}
function parseRequest_(msg) {
  const body = stripQuotes_(msg.body);
  return {
    caseName: field_(body, '案件名') || '',
    count: field_(body, '制作本数') || '',
    format: field_(body, '制作フォーマット') || '',
    due: field_(body, 'ご希望納期') || '',
    senderId: String(msg.account.account_id),
    senderName: cleanName_(msg.account.name),
  };
}

// ===== 返信時刻 =====
function replyAt_(sendTime) {
  const sent = new Date(sendTime * 1000);
  const hour = Number(Utilities.formatDate(sent, CONFIG.TZ, 'H'));
  const rand = (min, max) => min + Math.random() * (max - min);
  if (hour >= CONFIG.MORNING_HOUR) {
    // 9:00〜23:59 の依頼: 10〜15分後(0時をまたいでも待たない)
    return new Date(sent.getTime() + rand(CONFIG.REPLY_MIN_MINUTES, CONFIG.REPLY_MAX_MINUTES) * 60000);
  }
  // 0:00〜8:59 の依頼: 当日 9:00〜9:05
  const ymd = Utilities.formatDate(sent, CONFIG.TZ, 'yyyy/MM/dd');
  const base = parseJst_(ymd + ' 09:00:00');
  return new Date(base.getTime() + rand(0, CONFIG.MORNING_WINDOW_MINUTES) * 60000);
}
function ymd_(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy/MM/dd'); }
function parseJst_(s) {
  // 'yyyy/MM/dd HH:mm:ss' を JST として Date に
  const [d, t] = s.split(' ');
  const [y, mo, da] = d.split('/').map(Number);
  const [h, mi, se] = t.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h - 9, mi, se));
}

// ===== 状態(_botシート) =====
// 列: message_id | kind | send_time | reply_at | sender_id | sender_name | payload(json) | status
function botSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CONFIG.SHEET_BOT);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_BOT);
    sh.appendRow(['message_id', 'kind', 'send_time', 'reply_at', 'sender_id', 'sender_name', 'payload', 'status']);
    sh.hideSheet();
  }
  return sh;
}
function lastSeen_() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('LAST_SEEN');
  if (!v) { v = String(Math.floor(Date.now() / 1000)); p.setProperty('LAST_SEEN', v); } // 初回は過去分を無視
  return Number(v);
}
function setLastSeen_(t) { PropertiesService.getScriptProperties().setProperty('LAST_SEEN', String(t)); }

// ===== メイン(1分おき) =====
function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    detect_();
    dispatch_();
    detectAssignments_();
  } finally { lock.releaseLock(); }
}

function detect_() {
  const since = lastSeen_();
  const msgs = cwGet_(`/rooms/${CONFIG.ROOM_CLIENT}/messages?force=1`);
  const bot = botSheet_();
  const known = new Set(bot.getRange(2, 1, Math.max(bot.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0])));
  let maxT = since;
  msgs.forEach(m => {
    if (m.send_time <= since) return;
    maxT = Math.max(maxT, m.send_time);
    if (CONFIG.INTERNAL_IDS.includes(String(m.account.account_id))) {
      // 森岡さんが割り振りなしで納期を連絡した場合は森岡さん対応と判断し、担当者と提出予定日を入れる
      try { applyScheduleByMorioka_(m); } catch (e) { Logger.log('schedule error: ' + e.message); }
      return;
    }
    if (known.has(String(m.message_id))) return;
    const kind = classify_(m);
    if (!kind) return;
    const payload = kind === 'request' ? parseRequest_(m) : { senderId: String(m.account.account_id), senderName: cleanName_(m.account.name) };
    const at = kind === 'inquiry' ? new Date() : replyAt_(m.send_time); // 依頼者へ返信するものは10〜15分後
    bot.appendRow([String(m.message_id), kind, new Date(m.send_time * 1000), at, payload.senderId, payload.senderName, JSON.stringify(payload), 'pending']);
  });
  setLastSeen_(maxT);
}

function dispatch_() {
  const bot = botSheet_();
  const last = bot.getLastRow();
  if (last < 2) return;
  const rows = bot.getRange(2, 1, last - 1, 8).getValues();
  const now = new Date();
  rows.forEach((r, i) => {
    if (r[7] !== 'pending' || new Date(r[3]) > now) return;
    const messageId = String(r[0]), kind = r[1], payload = JSON.parse(r[6]);
    const link = messageLink_(CONFIG.ROOM_CLIENT, messageId);
    try {
      if (kind === 'request') {
        const rowNo = appendCase_(payload, new Date(r[2]), link);
        cwPost_(CONFIG.ROOM_CLIENT, msgFirstReply(payload.senderId, payload.senderName, payload.caseName));
        const shared = cwPost_(CONFIG.ROOM_PROD, msgShareRequest(payload, link, rowNo));
        // 共有メッセージへの返信で担当者を決められるよう、案件との対応を記録
        payload.shareMessageId = String(shared.message_id);
        payload.sheetName = Utilities.formatDate(new Date(r[2]), CONFIG.TZ, 'yyyyMM');
        bot.getRange(i + 2, 7).setValue(JSON.stringify(payload));
      } else if (kind === 'revision') {
        cwPost_(CONFIG.ROOM_CLIENT, msgRevisionReply(payload.senderId, payload.senderName));
        cwPost_(CONFIG.ROOM_PROD, msgShareRevision(payload.senderName, link));
      } else if (kind === 'inquiry') {
        cwPost_(CONFIG.ROOM_PROD, msgShareInquiry(payload.senderName, link));
      } else if (kind === 'mention') {
        cwPost_(CONFIG.ROOM_CLIENT, msgGenericReply(payload.senderId, payload.senderName));
        cwPost_(CONFIG.ROOM_PROD, msgShareGeneric(payload.senderName, link));
      }
      bot.getRange(i + 2, 8).setValue('done');
    } catch (e) {
      bot.getRange(i + 2, 8).setValue('error: ' + e.message);
    }
  });
}

// 月別タブ(YYYYMM)に動画本数ぶんの行を追加し、先頭行のNoを返す
// 列: A No. | B 依頼日 | C 提出予定日 | D 依頼者 | E 案件名 | F 動画名 | G 動画尺 | H 担当者 | I YouTube URL | J 依頼メッセージ | K 備考 | L ステータス
function appendCase_(req, requestedAt, link) {
  const sh = monthSheet_(requestedAt);
  const requestedYmd = ymd_(requestedAt); // 'yyyy/MM/dd' の文字列で書き、シート側で日付として解釈させる
  const n = parseCount_(req.count);
  const colB = sh.getRange(2, 2, sh.getMaxRows() - 1, 1).getValues();
  let row = 2;
  while (row - 2 < colB.length && colB[row - 2][0] !== '') row++;
  if (row + n > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), n + 20);
  const note = [req.due ? '希望納期: ' + req.due.slice(0, 40) : '', req.format ? 'フォーマット: ' + req.format.slice(0, 30) : ''].filter(Boolean).join(' / ');
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([
      requestedYmd, '', req.senderName.replace(/[\s\u3000]/g, ''), req.caseName || '(案件名未記載)', n > 1 ? `動画${i + 1}` : '',
    ]);
  }
  sh.getRange(row, 2, n, 5).setValues(rows);                                   // B..F
  sh.getRange(row, 10, n, 2).setValues(rows.map((_, i) => [i === 0 ? link : '', i === 0 ? note : ''])); // J..K
  sh.getRange(row, 2, n, 1).setNumberFormat('yyyy/mm/dd');
  return row - 1;
}
function parseCount_(text) {
  const m = text && text.match(/(\d+)\s*本/);
  return m ? Math.min(Number(m[1]), 30) : 1;
}
function parseDue_(text, base) {
  const m = text && text.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const y = Number(Utilities.formatDate(base, CONFIG.TZ, 'yyyy'));
  const d = parseJst_(`${y}/${m[1]}/${m[2]} 00:00:00`);
  return d < base ? parseJst_(`${y + 1}/${m[1]}/${m[2]} 00:00:00`) : d;
}
// 依頼日の月のタブを返す(なければテンプレートから複製)
function monthSheet_(date) {
  const ss = SpreadsheetApp.getActive();
  const name = Utilities.formatDate(date, CONFIG.TZ, 'yyyyMM');
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  const tpl = ss.getSheetByName(CONFIG.SHEET_TEMPLATE);
  if (!tpl) throw new Error('テンプレートタブがありません。setupSheet を実行してください');
  sh = tpl.copyTo(ss).setName(name);
  ss.setActiveSheet(sh); ss.moveActiveSheet(1);
  sh.showSheet();
  return sh;
}

// ===== 割り振りの自動反映(制作グループ) =====
// 森岡さん(または松井さん)が制作グループで担当者にToした投稿から、案件名を探して台帳の担当者列を埋める。
//   例1: 「[To:牛嶋] 橋谷のり子さま案件、お願いします」 → 橋谷のり子さんの行の担当者=牛嶋
//   例2: Botの共有メッセージに返信して「牛嶋さんお願いします」 → その案件の担当者=牛嶋
//   例3: 森岡さんが To なしで「成宮さんは私が担当します」 → 担当者=森岡
function detectAssignments_() {
  const props = PropertiesService.getScriptProperties();
  let since = Number(props.getProperty('LAST_SEEN_PROD') || 0);
  if (!since) { since = Math.floor(Date.now() / 1000); props.setProperty('LAST_SEEN_PROD', String(since)); return; }
  const msgs = cwGet_(`/rooms/${CONFIG.ROOM_PROD}/messages?force=1`);
  let maxT = since;
  msgs.forEach(m => {
    if (m.send_time <= since) return;
    maxT = Math.max(maxT, m.send_time);
    try { applyAssignment_(m); } catch (e) { Logger.log('assignment error: ' + e.message); }
  });
  props.setProperty('LAST_SEEN_PROD', String(maxT));
}

function applyAssignment_(m) {
  const senderId = String(m.account.account_id);
  if (!CONFIG.ASSIGNERS.includes(senderId)) return false;
  const body = stripQuotes_(m.body);

  // 担当者: To されている人 → いなければ「私が/こちらで 担当・対応」なら発言者
  let assignee = null;
  const to = body.match(/\[To:(\d+)\]/g) || [];
  for (const t of to) { const id = t.match(/\d+/)[0]; if (CONFIG.ASSIGNEES[id]) { assignee = CONFIG.ASSIGNEES[id]; break; } }
  if (!assignee) {
    for (const [id, name] of Object.entries(CONFIG.ASSIGNEES)) {
      if (id !== senderId && new RegExp(name + '(さん|くん|氏)?').test(body)) { assignee = name; break; }
    }
  }
  if (!assignee && /(私|わたし|こちら|自分)(が|で)?.*(担当|対応|進め|やり)/.test(body)) assignee = CONFIG.ASSIGNEES[senderId];
  if (!assignee) return false;

  // 案件: Botの共有メッセージへの返信なら、その案件。そうでなければ本文中の案件名で照合
  let targets = [];
  const rp = body.match(/\[rp aid=\d+ to=\d+-(\d+)\]/);
  if (rp) {
    const bot = botSheet_();
    const rows = bot.getRange(2, 1, Math.max(bot.getLastRow() - 1, 1), 8).getValues();
    const hit = rows.find(r => { try { return JSON.parse(r[6] || '{}').shareMessageId === rp[1]; } catch (e) { return false; } });
    if (hit) { const p = JSON.parse(hit[6]); targets = findCaseRows_(p.sheetName, p.caseName); }
  }
  if (!targets.length) targets = findCaseRowsByText_(body);
  if (!targets.length) return false;

  targets.forEach(t => {
    const rng = t.sheet.getRange(t.row, 8);
    if (rng.getValue() === '') rng.setValue(assignee);
  });
  Logger.log(`担当者を反映: ${assignee} ← ${targets.length}行`);
  return true;
}

// 案件名の照合用に正規化(敬称・空白・括弧を除く)
function normCase_(s) {
  return String(s || '').replace(/（[^）]*）|\([^)]*\)/g, '').replace(/株式会社|有限会社|案件|さま|さん|様|御中|[\s\u3000・、。！!]/g, '').trim();
}
// 今月と前月のタブから、案件名が一致し担当者が空の行を返す
function findCaseRows_(sheetName, caseName) {
  const ss = SpreadsheetApp.getActive();
  const key = normCase_(caseName);
  const out = [];
  const sheets = [sheetName, prevMonthName_(sheetName)].map(n => ss.getSheetByName(n)).filter(Boolean);
  sheets.forEach(sh => {
    const vals = sh.getRange(2, 2, Math.max(sh.getLastRow() - 1, 1), 7).getValues(); // B..H
    vals.forEach((v, i) => { if (v[0] !== '' && normCase_(v[3]) === key && v[6] === '') out.push({ sheet: sh, row: i + 2 }); });
  });
  return out;
}
// 本文に含まれる案件名(担当者が空の行)を探す
function findCaseRowsByText_(body, includeAssigned) {
  const ss = SpreadsheetApp.getActive();
  const text = normCase_(body);
  const cur = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMM');
  const out = [];
  [cur, prevMonthName_(cur)].map(n => ss.getSheetByName(n)).filter(Boolean).forEach(sh => {
    const vals = sh.getRange(2, 2, Math.max(sh.getLastRow() - 1, 1), 7).getValues();
    vals.forEach((v, i) => {
      const key = normCase_(v[3]);
      if (v[0] !== '' && key.length >= 2 && (includeAssigned || v[6] === '') && text.indexOf(key) >= 0) out.push({ sheet: sh, row: i + 2 });
    });
  });
  return out;
}
function prevMonthName_(yyyymm) {
  const y = Number(yyyymm.slice(0, 4)), mo = Number(yyyymm.slice(4, 6));
  const d = new Date(y, mo - 2, 1);
  return Utilities.formatDate(d, CONFIG.TZ, 'yyyyMM');
}

// 森岡さんの納期連絡(TendAiルーム)→ 未割り振りの該当案件を「森岡」にし、「〜M/D」があれば提出予定日に入れる
function applyScheduleByMorioka_(m) {
  if (String(m.account.account_id) !== CONFIG.ID_MORIOKA) return false;
  const body = stripQuotes_(m.body);
  if (!/初稿スケジュール|[〜～~]\s*\d{1,2}\/\d{1,2}/.test(body)) return false; // 受付返信(「明日中に納期をご連絡」)では反応しない
  const targets = findCaseRowsByText_(body);
  if (!targets.length) return false;
  const due = parseDue_(body.match(/〜\s*(\d{1,2}\/\d{1,2})/) ? body.match(/〜\s*(\d{1,2}\/\d{1,2})/)[1] : '', new Date(m.send_time * 1000));
  targets.forEach(t => {
    t.sheet.getRange(t.row, 8).setValue(CONFIG.ASSIGNEES[CONFIG.ID_MORIOKA]);
    if (due && t.sheet.getRange(t.row, 3).getValue() === '') t.sheet.getRange(t.row, 3).setValue(ymd_(due)).setNumberFormat('yyyy/mm/dd');
  });
  Logger.log(`納期連絡から森岡さん担当を反映: ${targets.length}行`);
  return true;
}

// テスト用: 制作グループとTendAiルームの直近メッセージから割り振り・納期を読み取って反映(投稿なし)
function backfillAssignments() {
  let n = 0;
  cwGet_(`/rooms/${CONFIG.ROOM_PROD}/messages?force=1`).forEach(m => { try { if (applyAssignment_(m)) n++; } catch (e) { Logger.log(e.message); } });
  cwGet_(`/rooms/${CONFIG.ROOM_CLIENT}/messages?force=1`).forEach(m => { try { if (applyScheduleByMorioka_(m)) n++; } catch (e) { Logger.log(e.message); } });
  Logger.log(`${n}件の投稿から担当者・提出予定日を反映しました`);
}

// ===== トリガー =====
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
}

// ===== シート構築 =====
// 列: A No. | B 依頼日 | C 提出予定日 | D 依頼者 | E 案件名 | F 動画名 | G 動画尺 | H 担当者 | I YouTube URL | J 依頼メッセージ | K 備考 | L ステータス
const LAYOUT = {
  headers: ['No.', '依頼日', '提出予定日', '依頼者', '案件名', '動画名（シナリオNo.など）', '動画尺', '担当者', 'YouTube URL', '依頼メッセージ', '備考', 'ステータス'],
  widths: [45, 90, 90, 90, 220, 260, 70, 70, 280, 300, 200, 90],
  fills: ['#D9D9D9', '#DDEBF7', '#E2EFDA', '#DDEBF7', '#DDEBF7', '#E2EFDA', '#E2EFDA', '#FCE4D6', '#E2EFDA', '#DDEBF7', '#E2EFDA', '#D9D9D9'],
  rows: 300,
};

function setupSheet() {
  const ss = SpreadsheetApp.getActive();

  // --- マスタ ---
  let ms = ss.getSheetByName(CONFIG.SHEET_MASTER) || ss.insertSheet(CONFIG.SHEET_MASTER);
  ms.clear();
  ms.getRange('A1').setValue('担当者').setFontWeight('bold');
  ms.getRange('A2:A4').setValues([['森岡'], ['牛嶋'], ['松井']]).setFontColor('#0000FF');
  ms.getRange('C1').setValue('動画尺').setFontWeight('bold');
  const lens = ['〜15秒', '〜30秒', '〜45秒', '〜60秒', '〜90秒', '〜120秒', '〜150秒', '〜180秒', '〜270秒', '〜300秒'];
  ms.getRange(2, 3, lens.length, 1).setValues(lens.map(x => [x])).setFontColor('#0000FF');
  ms.getRange('A7').setValue('青字は編集可。担当者・動画尺は月別タブのプルダウンに反映されます。').setFontColor('#808080');
  ms.setColumnWidths(1, 3, 110);

  // --- テンプレート(月別タブの元) ---
  let tpl = ss.getSheetByName(CONFIG.SHEET_TEMPLATE) || ss.insertSheet(CONFIG.SHEET_TEMPLATE);
  tpl.clear(); tpl.clearConditionalFormatRules();
  applyLayout_(tpl);
  tpl.hideSheet();

  // 今月のタブを用意(既にあれば数式・書式だけ揃え直す。入力済みデータは消さない)
  const cur = monthSheet_(new Date());
  if (cur.getLastRow() > 0) applyLayout_(cur, /*keepData*/ true);

  setupSummary_();
  botSheet_();
  const s1 = ss.getSheetByName('シート1');
  if (s1 && s1.getLastRow() === 0 && s1.getLastColumn() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
}

// 既存の月別タブに数式・入力規則・条件付き書式を再適用する(手動実行用)
function applyLayoutToActiveSheet() {
  applyLayout_(SpreadsheetApp.getActiveSheet(), true);
}

function applyLayout_(sh, keepData) {
  const ss = SpreadsheetApp.getActive();
  const ms = ss.getSheetByName(CONFIG.SHEET_MASTER);
  const { headers, widths, fills, rows: ROWS } = LAYOUT;
  const NC = headers.length;
  if (sh.getMaxRows() < ROWS + 2) sh.insertRowsAfter(sh.getMaxRows(), ROWS + 2 - sh.getMaxRows());
  if (sh.getMaxColumns() < NC) sh.insertColumnsAfter(sh.getMaxColumns(), NC - sh.getMaxColumns());

  sh.getRange(1, 1, 1, NC).setValues([headers]).setFontWeight('bold').setVerticalAlignment('middle').setWrap(true);
  headers.forEach((_, i) => { sh.setColumnWidth(i + 1, widths[i]); sh.getRange(1, i + 1).setBackground(fills[i]); });
  sh.getRange(1, 3).setNote('担当者が初稿の提出予定日を入れます。中止の場合は「中止」と入力。');
  sh.getRange(1, 11).setNote('Botは依頼文の希望納期とフォーマットをここに入れます。');
  sh.getRange(1, 12).setNote('自動判定: YouTube URLあり→納品済 / 担当者あり→制作中 / それ以外→未割り振り。提出予定日に「中止」で中止。');

  const fNo = [], fSt = [];
  for (let r = 2; r <= ROWS + 1; r++) {
    fNo.push([`=IF(B${r}="","",ROW()-1)`]);
    fSt.push([`=IF(B${r}="","",IF(C${r}="中止","中止",IF(I${r}<>"","納品済",IF(H${r}<>"","制作中","未割り振り"))))`]);
  }
  sh.getRange(2, 1, ROWS, 1).setFormulas(fNo).setBackground('#F3F3F3');
  sh.getRange(2, 12, ROWS, 1).setFormulas(fSt).setBackground('#F3F3F3');
  sh.getRange(2, 2, ROWS, 2).setNumberFormat('yyyy/mm/dd');

  const dv = (rng) => SpreadsheetApp.newDataValidation().requireValueInRange(rng, true).setAllowInvalid(true).build();
  sh.getRange(2, 8, ROWS, 1).setDataValidation(dv(ms.getRange('A2:A20')));
  sh.getRange(2, 7, ROWS, 1).setDataValidation(dv(ms.getRange('C2:C20')));

  sh.clearConditionalFormatRules();
  const body = sh.getRange(2, 1, ROWS, NC);
  sh.setConditionalFormatRules([
    // 提出予定日を過ぎてURL未入力 → 行を薄赤
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=AND($B2<>"",$I2="",ISNUMBER($C2),$C2<TODAY())`).setBackground('#F8CBAD').setRanges([body]).build(),
    // 担当者が空 → 担当者セルを黄色
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=AND($B2<>"",$H2="")`).setBackground('#FFF2CC').setRanges([sh.getRange(2, 8, ROWS, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('納品済').setBackground('#C6E0B4').setRanges([sh.getRange(2, 12, ROWS, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('中止').setBackground('#D9D9D9').setFontColor('#808080').setRanges([sh.getRange(2, 12, ROWS, 1)]).build(),
  ]);
  sh.setFrozenRows(1); sh.setFrozenColumns(5);
  if (!keepData) {
    sh.getRange(ROWS + 3, 1).setValue('凡例: 青=事務(Bot)が起票 / 橙=森岡さんが記入 / 緑=担当者が記入 / 灰=自動。行は依頼日の月のタブに入ります。').setFontColor('#808080');
  }
}

// 集計タブだけ作り直す(手動実行用)
function setupSummary() { setupSummary_(); }

// 集計: 月別タブの本数とステータス内訳
function setupSummary_() {
  const ss = SpreadsheetApp.getActive();
  let sm = ss.getSheetByName(CONFIG.SHEET_SUMMARY) || ss.insertSheet(CONFIG.SHEET_SUMMARY);
  sm.clear();
  sm.getRange('A1:F1').setValues([['月(タブ名)', '本数', '未割り振り', '制作中', '納品済', '中止']]).setFontWeight('bold').setBackground('#EFEFEF');
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const r = i + 2;
    const rng = (col) => `INDIRECT("'"&A${r}&"'!${col}2:${col}301")`;
    const exists = `NOT(ISERROR(INDIRECT("'"&A${r}&"'!A1")))`;
    const cnt = (v) => `=IF(A${r}="","",IF(${exists},COUNTIF(${rng('L')},"${v}"),""))`;
    rows.push([
      `=IF(A${r}="","",IF(${exists},COUNTA(${rng('B')}),"タブなし"))`,
      cnt('未割り振り'), cnt('制作中'), cnt('納品済'), cnt('中止'),
    ]);
  }
  sm.getRange(2, 2, rows.length, 5).setFormulas(rows);
  const names = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    names.push([Utilities.formatDate(d, CONFIG.TZ, 'yyyyMM')]);
  }
  sm.getRange(2, 1, names.length, 1).setNumberFormat('@').setValues(names).setFontColor('#0000FF');
  sm.getRange('H1').setValue('A列のタブ名は編集可(青字)。存在しない月は「タブなし」と表示されます。').setFontColor('#808080');
  sm.setColumnWidths(1, 6, 100);
}

// ===== テスト用: 今月の過去依頼をChatworkに投稿せずシートに流し込む =====
function backfillThisMonth() {
  const month = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMM');
  const msgs = cwGet_(`/rooms/${CONFIG.ROOM_CLIENT}/messages?force=1`);
  let n = 0;
  msgs.forEach(m => {
    if (CONFIG.INTERNAL_IDS.includes(String(m.account.account_id))) return;
    if (classify_(m) !== 'request') return;
    const sent = new Date(m.send_time * 1000);
    if (Utilities.formatDate(sent, CONFIG.TZ, 'yyyyMM') !== month) return;
    appendCase_(parseRequest_(m), sent, messageLink_(CONFIG.ROOM_CLIENT, m.message_id));
    n++;
  });
  Logger.log(`${month}: ${n}件の依頼を起票しました(Chatworkへの投稿なし)`);
}
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// ===== 手動テスト用 =====
function previewReplies() {
  FIRST_REPLY_PATTERNS.forEach((p, i) => Logger.log(`--- パターン${i + 1}\n[To:xxx]立田 紗穂里さん\n${greeting_()}\n${p(honorific_('橋谷のり子さん'))}🙇`));
}
function testParse() {
  const msgs = cwGet_(`/rooms/${CONFIG.ROOM_CLIENT}/messages?force=1`);
  msgs.forEach(m => {
    const k = classify_(m);
    if (k) Logger.log(`${k} | ${cleanName_(m.account.name)} | ${JSON.stringify(k === 'request' ? parseRequest_(m) : {})} | replyAt=${replyAt_(m.send_time)}`);
  });
}
