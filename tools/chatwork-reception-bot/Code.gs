/**
 * 動画制作 受付Bot + 案件シート
 *
 * 使い方(初回のみ)
 *  1. スプレッドシートの「拡張機能 > Apps Script」にこのファイルを貼り付けて保存
 *  2. 「プロジェクトの設定 > スクリプト プロパティ」に下記を登録
 *       CW_TOKEN    : 事務アカウントのChatwork APIトークン
 *  3. 関数 setupSheet を実行(案件シート・マスタ・_bot シートを作る)
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
  SHEET_MAIN: '案件シート',
  SHEET_MASTER: 'マスタ',
  SHEET_BOT: '_bot',
  HEADER_ROW: 5,
  GANTT_DAYS: 60,
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
    `案件シート: 行No.${rowNo}`;
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
  const m = body.match(new RegExp('□\\s*' + label + '[^\\n]*\\n([^\\n□]*)'));
  return m ? m[1].trim() : '';
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
  const has = (re) => re.test(body) ? '○' : '×';
  return {
    caseName: field_(body, '案件名') || '',
    count: field_(body, '制作本数') || '',
    format: field_(body, '制作フォーマット') || '',
    due: field_(body, 'ご希望納期') || '',
    senderId: String(msg.account.account_id),
    senderName: cleanName_(msg.account.name),
    voice: has(/音声|ナレーション|AI生成|女性の声|男性の声|本人の声/),
    lp: /https?:\/\//.test(field_(body, 'デザイン参考情報')) ? '○' : '×',
    shared: has(new RegExp(CONFIG.SHARE_MAIL.replace('.', '\\.') + '|共有済')),
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

// 案件シートに1行追加して行Noを返す
function appendCase_(req, requestedAt, link) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_MAIN);
  const H = CONFIG.HEADER_ROW;
  const colB = sh.getRange(H + 1, 2, sh.getMaxRows() - H, 1).getValues();
  let row = H + 1;
  while (row - H - 1 < colB.length && colB[row - H - 1][0] !== '') row++;
  const dueDate = parseDue_(req.due, requestedAt);
  sh.getRange(row, 2, 1, 10).setValues([[
    requestedAt, req.senderName, req.caseName, req.count, req.format,
    dueDate || req.due, link, req.voice, req.lp, req.shared,
  ]]);
  sh.getRange(row, 2).setNumberFormat('m/d');
  if (dueDate) sh.getRange(row, 7).setNumberFormat('m/d');
  return row - H;
}
function parseDue_(text, base) {
  const m = text && text.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const y = Number(Utilities.formatDate(base, CONFIG.TZ, 'yyyy'));
  const d = parseJst_(`${y}/${m[1]}/${m[2]} 00:00:00`);
  return d < base ? parseJst_(`${y + 1}/${m[1]}/${m[2]} 00:00:00`) : d;
}

// ===== トリガー =====
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
}

// ===== 案件シート構築 =====
function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const H = CONFIG.HEADER_ROW;
  const FILL = { jimu: '#DDEBF7', mori: '#FCE4D6', tanto: '#E2EFDA', auto: '#EDEDED', head: '#404040', input: '#FFFF00' };

  // --- マスタ ---
  let ms = ss.getSheetByName(CONFIG.SHEET_MASTER) || ss.insertSheet(CONFIG.SHEET_MASTER);
  ms.clear();
  ms.getRange('A1').setValue('担当者').setFontWeight('bold');
  ms.getRange('A2:A4').setValues([['森岡'], ['牛嶋'], ['松井']]).setFontColor('#0000FF');
  ms.getRange('C1').setValue('フォーマット').setFontWeight('bold');
  ms.getRange('C2:C6').setValues([['縦型'], ['長方形'], ['正方形'], ['縦型+正方形'], ['横型→縦型']]).setFontColor('#0000FF');
  ms.getRange('E1').setValue('ステータス(自動判定の順)').setFontWeight('bold');
  ms.getRange('E2:E7').setValues([['未割り振り'], ['割り振り済'], ['制作中'], ['確認待ち'], ['完了'], ['中止']]);
  ms.getRange('G1').setValue('標準納期(本数→営業日)').setFontWeight('bold');
  ms.getRange('G2:H2').setValues([['本数まで', '営業日']]).setFontWeight('bold');
  ms.getRange('G3:H6').setValues([[2, 3], [4, 5], [6, 7], [10, 10]]).setFontColor('#0000FF');
  ms.getRange('G8').setValue('※ 標準納期は仮の値です。森岡さんの実績に合わせて書き換えてください。').setFontColor('#808080');
  ms.getRange('A6').setValue('青字は編集可。担当者・フォーマットは案件シートのプルダウンに反映されます。').setFontColor('#808080');
  ms.setColumnWidths(1, 8, 110);

  // --- 案件シート ---
  let ws = ss.getSheetByName(CONFIG.SHEET_MAIN);
  if (!ws) { ws = ss.getSheets()[0]; ws.setName(CONFIG.SHEET_MAIN); }
  ws.clear(); ws.clearConditionalFormatRules();
  const cols = [
    ['No', 40, 'auto'], ['依頼日', 70, 'jimu'], ['依頼者', 90, 'jimu'], ['案件名', 160, 'jimu'], ['本数', 45, 'jimu'],
    ['フォーマット', 90, 'jimu'], ['希望納期', 80, 'jimu'], ['依頼リンク', 110, 'jimu'],
    ['音声指定', 60, 'jimu'], ['LP', 45, 'jimu'], ['素材共有', 60, 'jimu'],
    ['担当者', 70, 'mori'],
    ['納期回答日', 75, 'tanto'], ['初稿予定日', 75, 'tanto'], ['初稿納品日', 75, 'tanto'], ['修正回数', 55, 'tanto'],
    ['最終修正稿日', 85, 'tanto'], ['完了日', 70, 'tanto'], ['備考', 150, 'tanto'],
    ['ステータス', 85, 'auto'], ['初稿まで(日)', 70, 'auto'], ['予定超過', 60, 'auto'],
  ];
  const NCOL = cols.length, GS = NCOL + 1, ND = CONFIG.GANTT_DAYS, FIRST = H + 1, LAST = H + 60;
  const totalCols = GS + ND - 1;
  if (ws.getMaxColumns() < totalCols) ws.insertColumnsAfter(ws.getMaxColumns(), totalCols - ws.getMaxColumns());
  if (ws.getMaxRows() < LAST + 3) ws.insertRowsAfter(ws.getMaxRows(), LAST + 3 - ws.getMaxRows());

  ws.getRange('A1').setValue('動画制作 案件シート').setFontSize(14).setFontWeight('bold');
  ws.getRange('A2').setValue('凡例:').setFontWeight('bold');
  [['B2', '事務が記入(依頼受付時・Botが自動入力)', FILL.jimu], ['D2', '森岡さんが記入(割り振り)', FILL.mori],
   ['F2', '担当者が記入(納期〜完了)', FILL.tanto], ['H2', '自動(触らない)', FILL.auto]]
    .forEach(([a, t, c]) => ws.getRange(a).setValue(t).setBackground(c).setFontSize(9));
  ws.getRange('J2').setValue('ガント表示の開始日 →').setFontWeight('bold').setFontSize(9).setHorizontalAlignment('right');
  ws.getRange('K2').setValue(new Date()).setNumberFormat('yyyy/m/d').setBackground(FILL.input).setFontColor('#0000FF')
    .setNote('この日付を変えるとガント列の日付が動きます(60日分)。');
  ws.getRange('A3').setValue('ガント列: 依頼日〜完了日(未完了は今日まで)を塗り、初稿予定日を濃い青、初稿納品日を赤、希望納期を赤枠で表示。土日はグレー。').setFontColor('#808080').setFontSize(9);
  ws.getRange(H - 2, 1).setValue('ガント凡例:').setFontWeight('bold').setFontSize(9);
  [[2, '依頼〜完了', '#9DC3E6', '#000000'], [4, '初稿予定日', '#2E75B6', '#FFFFFF'], [6, '初稿納品日', '#C00000', '#FFFFFF'], [8, '希望納期(枠)', '#FFFFFF', '#000000'], [10, '土日', '#EDEDED', '#000000']]
    .forEach(([c, t, bg, fg]) => { const r = ws.getRange(H - 2, c).setValue(t).setBackground(bg).setFontColor(fg).setFontSize(9); if (t.startsWith('希望')) r.setBorder(true, true, true, true, false, false, '#C00000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM); });

  cols.forEach(([h, w, g], i) => {
    ws.getRange(H, i + 1).setValue(h).setFontColor('#FFFFFF').setBackground(FILL.head).setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
    ws.getRange(H - 1, i + 1).setBackground(FILL[g]);
    ws.setColumnWidth(i + 1, w);
  });
  ws.getRange(H - 1, 2).setValue('事務').setFontSize(9).setFontWeight('bold');
  ws.getRange(H - 1, 12).setValue('森岡').setFontSize(9).setFontWeight('bold');
  ws.getRange(H - 1, 13).setValue('担当者').setFontSize(9).setFontWeight('bold');
  ws.getRange(H - 1, 20).setValue('自動').setFontSize(9).setFontWeight('bold');
  ws.setRowHeight(H, 34);
  ws.getRange(H, 18).setNote('中止の場合は「中止」と入力するとステータスが中止になります。');
  ws.getRange(H, 9).setNote('依頼文に音声の指定があれば○(Botが判定)。');
  ws.getRange(H, 10).setNote('参考LPのURLがあれば○(Botが判定)。');
  ws.getRange(H, 11).setNote('素材が ' + CONFIG.SHARE_MAIL + ' に共有済みなら○(Botが判定)。');
  ws.getRange(H, 16).setNote('修正稿を出した回数。初稿のみで完了なら0。');

  // ガント見出し
  const gHead = [], gMonth = [];
  for (let d = 0; d < ND; d++) { gHead.push(`=$K$2+${d}`); gMonth.push(`=${colLetter_(GS + d)}${H}`); }
  ws.getRange(H, GS, 1, ND).setFormulas([gHead]).setNumberFormat('d').setFontColor('#FFFFFF').setBackground(FILL.head).setFontSize(8).setHorizontalAlignment('center');
  ws.getRange(H - 1, GS, 1, ND).setFormulas([gMonth]).setNumberFormat('m/d').setFontColor('#808080').setFontSize(7).setHorizontalAlignment('center');
  ws.getRange(H - 2, GS).setValue('ガントチャート(日付は開始日から自動)').setFontWeight('bold').setFontSize(9);
  for (let d = 0; d < ND; d++) ws.setColumnWidth(GS + d, 22);

  // 自動列の数式
  const fNo = [], fSt = [], fDays = [], fOver = [];
  for (let r = FIRST; r <= LAST; r++) {
    fNo.push([`=IF(B${r}="","",ROW()-${H})`]);
    fSt.push([`=IF(B${r}="","",IF(R${r}="中止","中止",IF(R${r}<>"","完了",IF(O${r}<>"","確認待ち",IF(M${r}<>"","制作中",IF(L${r}<>"","割り振り済","未割り振り"))))))`]);
    fDays.push([`=IF(OR(B${r}="",O${r}=""),"",O${r}-B${r})`]);
    fOver.push([`=IF(OR(N${r}="",O${r}=""),"",IF(O${r}>N${r},"超過",""))`]);
  }
  ws.getRange(FIRST, 1, LAST - FIRST + 1, 1).setFormulas(fNo);
  ws.getRange(FIRST, 20, LAST - FIRST + 1, 1).setFormulas(fSt);
  ws.getRange(FIRST, 21, LAST - FIRST + 1, 1).setFormulas(fDays);
  ws.getRange(FIRST, 22, LAST - FIRST + 1, 1).setFormulas(fOver);
  [1, 20, 21, 22].forEach(c => ws.getRange(FIRST, c, LAST - FIRST + 1, 1).setBackground(FILL.auto));
  [2, 7, 13, 14, 15, 17, 18].forEach(c => ws.getRange(FIRST, c, LAST - FIRST + 1, 1).setNumberFormat('m/d'));
  ws.getRange(FIRST, 1, LAST - FIRST + 1, totalCols).setBorder(true, true, true, true, true, true, '#BFBFBF', SpreadsheetApp.BorderStyle.SOLID);

  // 入力規則
  ws.getRange(FIRST, 12, LAST - FIRST + 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(ms.getRange('A2:A20'), true).setAllowInvalid(true).build());
  ws.getRange(FIRST, 6, LAST - FIRST + 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(ms.getRange('C2:C20'), true).setAllowInvalid(true).build());
  ws.getRange(FIRST, 9, LAST - FIRST + 1, 3).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['○', '×'], true).setAllowInvalid(true).build());

  // 条件付き書式(ガント)
  const GL = colLetter_(GS), GE = colLetter_(GS + ND - 1);
  const grange = ws.getRange(`${GL}${FIRST}:${GE}${LAST}`);
  const D = `${GL}$${H}`;
  const rule = (f, bg) => SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setBackground(bg).setRanges([grange]).build();
  const rules = [
    rule(`=AND($B${FIRST}<>"",${D}=$O${FIRST})`, '#C00000'),
    rule(`=AND($B${FIRST}<>"",${D}=$N${FIRST})`, '#2E75B6'),
    rule(`=AND($B${FIRST}<>"",${D}>=$B${FIRST},${D}<=IF($R${FIRST}="中止",$B${FIRST},IF($R${FIRST}<>"",$R${FIRST},TODAY())))`, '#9DC3E6'),
    rule(`=WEEKDAY(${D},2)>=6`, '#EDEDED'),
  ];
  // 希望納期の赤枠(背景は残す)
  rules.splice(2, 0, SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=AND($B${FIRST}<>"",${D}=$G${FIRST})`).setBackground('#F4B183').setRanges([grange]).build());
  const srange = ws.getRange(`T${FIRST}:T${LAST}`), orange = ws.getRange(`V${FIRST}:V${LAST}`);
  [['未割り振り', '#F8CBAD'], ['確認待ち', '#FFE699'], ['完了', '#C6E0B4']].forEach(([t, c]) =>
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(t).setBackground(c).setRanges([srange]).build()));
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('超過').setBackground('#F8CBAD').setRanges([orange]).build());
  ws.setConditionalFormatRules(rules);

  ws.setFrozenRows(H); ws.setFrozenColumns(4);
  ws.getRange(FIRST, 1, LAST - FIRST + 1, NCOL).setFontSize(10);
  botSheet_();
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
