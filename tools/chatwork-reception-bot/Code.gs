/**
 * 動画制作 受付Bot + 案件シート
 *
 * 使い方(初回のみ)
 *  1. スプレッドシートの「拡張機能 > Apps Script」にこのファイルを貼り付けて保存
 *  2. 「プロジェクトの設定 > スクリプト プロパティ」に下記を登録
 *       CW_TOKEN    : 事務アカウントのChatwork APIトークン
 *  3. 関数 setupSheet を実行(マスタ・テンプレート・今月タブ・集計・_bot を作る)
 *  4. 関数 installTrigger を実行(1分おきに poll が動く)
 *
 * 動き
 *  - 依頼テンプレ(「□ 案件名」を含む投稿)を検知 → 10〜15分後に一次返信
 *    (0時〜9時の依頼は 9:00〜9:05 に返信。曜日は問わない)
 *  - 同時に制作グループで森岡さんへ依頼を共有し、案件シートに1行追加
 *  - 事務がToされた投稿のうち、修正・確認系は依頼者へ定型返信、
 *    納期・担当の問い合わせは制作グループで森岡さんへメンション
 *  - それ以外の投稿には反応しない
 */

// ===== 設定 =====
const CONFIG = {
  ROOM_CLIENT: '367205288',      // 株式会社TendAi×松井くんチーム
  ROOM_PROD: '407016240',        // 【制作】株式会社TendAi様
  ID_SELF: '11316015',           // 有流悟 理澄 -事務-
  ID_MORIOKA: '10003938',        // 森岡 奈々
  INTERNAL_IDS: ['11316015', '10003938', '7433976', '11286789'], // 事務・森岡・松井・牛嶋
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
  return /(さん|様|さま|御中)$/.test(caseName) ? caseName : caseName + 'さま';
}
function msgFirstReply(toId, toName, caseName) {
  return `[To:${toId}]${toName}さん\n` +
    'お世話になっております。\n' +
    `${honorific_(caseName)}のご依頼ありがとうございます。\n` +
    '納期につきましては、本日〜明日中に追ってご連絡いたします。\n' +
    '引き続きよろしくお願いいたします🙇';
}
function msgRevisionReply(toId, toName) {
  return `[To:${toId}]${toName}さん\n` +
    'お世話になっております。\n' +
    '動画のご確認ありがとうございます。\n' +
    '内容を確認のうえ、追ってご連絡いたします🙇';
}
function msgShareRequest(req, link, rowNo) {
  return `[To:${CONFIG.ID_MORIOKA}]森岡さん\n` +
    'お疲れさまです。新規のご依頼が届きました。\n' +
    '割り振りと納期のご連絡をお願いいたします。\n\n' +
    `案件名: ${req.caseName || '(記載なし)'}\n` +
    `本数: ${req.count}${req.format ? '(' + req.format + ')' : ''}\n` +
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
  if (isRequest_(body)) return 'request';
  if (!isToSelf_(body)) return null;
  if (/修正|直し|変更|差し替え|カット|削除/.test(body)) return 'revision';
  if (/納期|担当|いつ|進捗|状況/.test(body)) return 'inquiry';
  return null;
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
    if (CONFIG.INTERNAL_IDS.includes(String(m.account.account_id))) return;
    if (known.has(String(m.message_id))) return;
    const kind = classify_(m);
    if (!kind) return;
    const payload = kind === 'request' ? parseRequest_(m) : { senderId: String(m.account.account_id), senderName: cleanName_(m.account.name) };
    const at = kind === 'request' || kind === 'revision' ? replyAt_(m.send_time) : new Date();
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
        cwPost_(CONFIG.ROOM_PROD, msgShareRequest(payload, link, rowNo));
      } else if (kind === 'revision') {
        cwPost_(CONFIG.ROOM_CLIENT, msgRevisionReply(payload.senderId, payload.senderName));
        cwPost_(CONFIG.ROOM_PROD, msgShareRevision(payload.senderName, link));
      } else if (kind === 'inquiry') {
        cwPost_(CONFIG.ROOM_PROD, msgShareInquiry(payload.senderName, link));
      }
      bot.getRange(i + 2, 8).setValue('done');
    } catch (e) {
      bot.getRange(i + 2, 8).setValue('error: ' + e.message);
    }
  });
}

// 月別タブ(YYYYMM)に動画本数ぶんの行を追加し、先頭行のNoを返す
function appendCase_(req, requestedAt, link) {
  const sh = monthSheet_(requestedAt);
  const n = parseCount_(req.count);
  const dueDate = parseDue_(req.due, requestedAt);
  const genre = /差し替え/.test(req.caseName + req.count) ? '差し替え' : '';
  const colB = sh.getRange(2, 2, sh.getMaxRows() - 1, 1).getValues();
  let row = 2;
  while (row - 2 < colB.length && colB[row - 2][0] !== '') row++;
  if (row + n > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), n + 20);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([
      requestedAt, '', req.senderName, req.caseName || '(案件名未記載)', n > 1 ? `動画${i + 1}` : '',
      genre, '', /*料金は数式*/ '', /*URL*/ '', i === 0 ? link : '',
      /*担当者*/ '', dueDate || req.due, /*修正回数*/ '', /*備考*/ i === 0 && req.format ? req.format : '',
    ]);
  }
  // B..O のうち I(料金) と P(ステータス) は数式列なので飛ばして書く
  const vals = rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]]);          // B..H
  sh.getRange(row, 2, n, 7).setValues(vals);
  sh.getRange(row, 10, n, 2).setValues(rows.map(r => [r[8], r[9]]));               // J..K
  sh.getRange(row, 12, n, 3).setValues(rows.map(r => [r[10], r[11], r[12]]));      // L..N
  sh.getRange(row, 15, n, 1).setValues(rows.map(r => [r[13]]));                    // O 備考
  sh.getRange(row, 2, n, 1).setNumberFormat('yyyy/mm/dd');
  if (dueDate) sh.getRange(row, 13, n, 1).setNumberFormat('yyyy/mm/dd');
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

// ===== トリガー =====
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
}

// ===== シート構築(参考台帳ベース) =====
// 列: A No. | B 依頼日 | C 提出日 | D 依頼者 | E 案件名 | F 動画名 | G ジャンル | H 動画尺 | I 料金 | J YouTube URL
//     K 依頼メッセージ | L 担当者 | M 納期 | N 修正回数 | O 備考 | P ステータス
function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const ROWS = 300;

  // --- マスタ ---
  let ms = ss.getSheetByName(CONFIG.SHEET_MASTER) || ss.insertSheet(CONFIG.SHEET_MASTER);
  ms.clear();
  ms.getRange('A1').setValue('担当者').setFontWeight('bold');
  ms.getRange('A2:A4').setValues([['森岡'], ['牛嶋'], ['松井']]).setFontColor('#0000FF');
  ms.getRange('C1').setValue('ジャンル').setFontWeight('bold');
  ms.getRange('C2:C5').setValues([['属人'], ['非属人'], ['差し替え'], ['AI']]).setFontColor('#0000FF');
  ms.getRange('E1').setValue('動画尺').setFontWeight('bold');
  const lens = ['〜15秒', '〜30秒', '〜45秒', '〜60秒', '〜90秒', '〜120秒', '〜150秒', '〜180秒', '〜270秒', '〜300秒'];
  ms.getRange(2, 5, lens.length, 1).setValues(lens.map(x => [x])).setFontColor('#0000FF');
  // 料金表(過去6か月の実績から。行=動画尺、列=ジャンル)
  ms.getRange('G1').setValue('料金表(円) 行=動画尺 / 列=ジャンル ※青字は編集可').setFontWeight('bold');
  ms.getRange('G2:K2').setValues([['動画尺', '属人', '非属人', '差し替え', 'AI']]).setFontWeight('bold');
  const price = [
    ['〜15秒', 3500, 4500, 2000, ''],
    ['〜30秒', 3500, 4500, 4000, ''],
    ['〜45秒', 3500, 4500, 6000, ''],
    ['〜60秒', 3500, 4500, '', 9000],
    ['〜90秒', 4500, 5500, '', 10000],
    ['〜120秒', 5500, 6500, '', ''],
    ['〜150秒', 6500, 7500, '', ''],
    ['〜180秒', '', '', '', ''],
    ['〜270秒', 10500, '', '', ''],
    ['〜300秒', 11500, '', '', ''],
  ];
  ms.getRange(3, 7, price.length, 5).setValues(price);
  ms.getRange(3, 8, price.length, 4).setFontColor('#0000FF').setNumberFormat('#,##0');
  ms.getRange('G14').setValue('差し替えで動画尺が空欄のときの料金').setFontWeight('bold');
  ms.getRange('H14').setValue(2000).setFontColor('#0000FF').setNumberFormat('#,##0');
  ms.getRange('G16').setValue('※ 料金表は 202602〜202607 タブの実績から起こした値です。空欄の組み合わせは料金が自動計算されないので手入力してください。').setFontColor('#808080');
  ms.setColumnWidths(1, 11, 100); ms.setColumnWidth(7, 90);

  // --- テンプレート(月別タブの元) ---
  let tpl = ss.getSheetByName(CONFIG.SHEET_TEMPLATE) || ss.insertSheet(CONFIG.SHEET_TEMPLATE);
  tpl.clear(); tpl.clearConditionalFormatRules();
  const headers = ['No.', '依頼日', '提出日', '依頼者', '案件名', '動画名（シナリオNo.など）', 'ジャンル', '動画尺', '料金', 'YouTube URL', '依頼メッセージ', '担当者', '納期', '修正回数', '備考', 'ステータス'];
  const widths = [45, 90, 90, 90, 220, 260, 80, 70, 70, 280, 300, 70, 90, 60, 200, 90];
  if (tpl.getMaxRows() < ROWS + 2) tpl.insertRowsAfter(tpl.getMaxRows(), ROWS + 2 - tpl.getMaxRows());
  if (tpl.getMaxColumns() < headers.length) tpl.insertColumnsAfter(tpl.getMaxColumns(), headers.length - tpl.getMaxColumns());
  tpl.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#EFEFEF').setVerticalAlignment('middle').setWrap(true);
  widths.forEach((w, i) => tpl.setColumnWidth(i + 1, w));
  // 記入者の色分け(ヘッダーのみ)
  tpl.getRange(1, 2, 1, 5).setBackground('#DDEBF7');   // B〜F 事務(Bot)が起票。F動画名は担当者が補完
  tpl.getRange(1, 11, 1, 1).setBackground('#DDEBF7');  // K
  tpl.getRange(1, 13, 1, 1).setBackground('#DDEBF7');  // M 納期(希望納期をBotが仮入力→森岡さんが確定)
  tpl.getRange(1, 12, 1, 1).setBackground('#FCE4D6');  // L 担当者 = 森岡さん
  [3, 6, 7, 8, 10, 14, 15].forEach(c => tpl.getRange(1, c).setBackground('#E2EFDA')); // 担当者
  [1, 9, 16].forEach(c => tpl.getRange(1, c).setBackground('#D9D9D9'));           // 自動
  tpl.getRange(1, 9).setNote('ジャンル×動画尺からマスタの料金表で自動計算。例外は数値を直接上書きしてください。');
  tpl.getRange(1, 16).setNote('自動判定: 提出日あり→納品済 / 担当者あり→制作中 / それ以外→未割り振り。提出日に「中止」と入力すると中止。');
  tpl.getRange(1, 13).setNote('Botは依頼文の希望納期を仮入力します。森岡さんが確定納期に書き換えてください。');

  const fNo = [], fPrice = [], fSt = [];
  for (let r = 2; r <= ROWS + 1; r++) {
    fNo.push([`=IF(B${r}="","",ROW()-1)`]);
    fPrice.push([`=IF(OR(B${r}="",G${r}=""),"",IF(AND(G${r}="差し替え",H${r}=""),マスタ!$H$14,IFERROR(INDEX(マスタ!$H$3:$K$12,MATCH(H${r},マスタ!$G$3:$G$12,0),MATCH(G${r},マスタ!$H$2:$K$2,0)),"")))`]);
    fSt.push([`=IF(B${r}="","",IF(C${r}="中止","中止",IF(C${r}<>"","納品済",IF(L${r}<>"","制作中","未割り振り"))))`]);
  }
  tpl.getRange(2, 1, ROWS, 1).setFormulas(fNo);
  tpl.getRange(2, 9, ROWS, 1).setFormulas(fPrice).setNumberFormat('#,##0');
  tpl.getRange(2, 16, ROWS, 1).setFormulas(fSt);
  tpl.getRange(2, 2, ROWS, 2).setNumberFormat('yyyy/mm/dd');
  tpl.getRange(2, 13, ROWS, 1).setNumberFormat('yyyy/mm/dd');
  // 合計(ヘッダー右側)
  tpl.getRange(1, 18).setValue('料金合計').setFontWeight('bold');
  tpl.getRange(2, 18).setFormula(`=SUM(I2:I${ROWS + 1})`).setNumberFormat('#,##0');
  tpl.getRange(1, 19).setValue('本数').setFontWeight('bold');
  tpl.getRange(2, 19).setFormula(`=COUNTA(B2:B${ROWS + 1})`);
  tpl.setColumnWidth(17, 20);

  // 入力規則
  const dv = (rng) => SpreadsheetApp.newDataValidation().requireValueInRange(rng, true).setAllowInvalid(true).build();
  tpl.getRange(2, 12, ROWS, 1).setDataValidation(dv(ms.getRange('A2:A20')));
  tpl.getRange(2, 7, ROWS, 1).setDataValidation(dv(ms.getRange('C2:C20')));
  tpl.getRange(2, 8, ROWS, 1).setDataValidation(dv(ms.getRange('E2:E20')));

  // 条件付き書式
  const body = tpl.getRange(2, 1, ROWS, headers.length);
  const rules = [
    // 納期を過ぎて未提出 → 行を薄赤
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=AND($B2<>"",$C2="",$M2<>"",ISNUMBER($M2),$M2<TODAY())`).setBackground('#F8CBAD').setRanges([body]).build(),
    // 未割り振り → 担当者セルを黄色
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=AND($B2<>"",$L2="")`).setBackground('#FFF2CC').setRanges([tpl.getRange(2, 12, ROWS, 1)]).build(),
    // 納品済 → ステータスを緑
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('納品済').setBackground('#C6E0B4').setRanges([tpl.getRange(2, 16, ROWS, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('中止').setBackground('#D9D9D9').setFontColor('#808080').setRanges([tpl.getRange(2, 16, ROWS, 1)]).build(),
  ];
  tpl.setConditionalFormatRules(rules);
  tpl.setFrozenRows(1); tpl.setFrozenColumns(5);
  tpl.getRange(ROWS + 3, 1).setValue('凡例: 青=事務(Bot)が起票 / 橙=森岡さんが記入 / 緑=担当者が記入 / 灰=自動。行は依頼日の月のタブに入ります。請求は提出日基準なので、月をまたいだ行は提出月のタブへ移してください。').setFontColor('#808080');
  tpl.hideSheet();

  // 今月のタブを用意
  monthSheet_(new Date());
  // 集計タブ
  setupSummary_();
  botSheet_();
}

// 集計: 月別タブの料金合計・本数を一覧
function setupSummary_() {
  const ss = SpreadsheetApp.getActive();
  let sm = ss.getSheetByName(CONFIG.SHEET_SUMMARY) || ss.insertSheet(CONFIG.SHEET_SUMMARY);
  sm.clear();
  sm.getRange('A1:E1').setValues([['月(タブ名)', '本数', '料金合計', '未割り振り', '納品済']]).setFontWeight('bold').setBackground('#EFEFEF');
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const r = i + 2;
    rows.push([
      `=IF(A${r}="","",IFERROR(COUNTA(INDIRECT(A${r}&"!B2:B301")),"タブなし"))`,
      `=IF(A${r}="","",IFERROR(SUM(INDIRECT(A${r}&"!I2:I301")),""))`,
      `=IF(A${r}="","",IFERROR(COUNTIF(INDIRECT(A${r}&"!P2:P301"),"未割り振り"),""))`,
      `=IF(A${r}="","",IFERROR(COUNTIF(INDIRECT(A${r}&"!P2:P301"),"納品済"),""))`,
    ]);
  }
  sm.getRange(2, 2, rows.length, 4).setFormulas(rows);
  sm.getRange(2, 3, rows.length, 1).setNumberFormat('#,##0');
  // 今月から過去24か月ぶんのタブ名を入れる
  const names = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    names.push([Utilities.formatDate(d, CONFIG.TZ, 'yyyyMM')]);
  }
  sm.getRange(2, 1, names.length, 1).setValues(names).setFontColor('#0000FF');
  sm.getRange('G1').setValue('A列のタブ名は編集可(青字)。存在しない月は「タブなし」と表示されます。').setFontColor('#808080');
  sm.setColumnWidths(1, 5, 110);
}
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// ===== 手動テスト用 =====
function testParse() {
  const msgs = cwGet_(`/rooms/${CONFIG.ROOM_CLIENT}/messages?force=1`);
  msgs.forEach(m => {
    const k = classify_(m);
    if (k) Logger.log(`${k} | ${cleanName_(m.account.name)} | ${JSON.stringify(k === 'request' ? parseRequest_(m) : {})} | replyAt=${replyAt_(m.send_time)}`);
  });
}
