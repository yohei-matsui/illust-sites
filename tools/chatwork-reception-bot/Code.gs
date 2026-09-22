/**
 * 動画制作 受付Bot + 案件シート
 *
 * 使い方(初回のみ)
 *  1. スプレッドシートの「拡張機能 > Apps Script」にこのファイルを貼り付けて保存
 *  2. 「プロジェクトの設定 > スクリプト プロパティ」に下記を登録
 *       CW_TOKEN    : 事務アカウントのChatwork APIトークン
 *  3. 関数 setupSheet を実行(マスタ・テンプレート・今月タブ・集計・_bot を作る/揃える)
 *  4. 関数 installTrigger を実行(CONFIG.POLL_MINUTES おきに poll が動く。既定は5分)
 *  5. 本番投入の直前に resetCursors を実行(古い投稿にさかのぼって反応しないようにする)
 *  6. 一次返信は初期状態ではOFF(台帳起票と担当者反映だけ動く)。開始するときに startReplies を実行。
 *     止めるときは stopReplies。状態はスクリプトプロパティ BOT_REPLIES(on/off)
 *  7. 提出予定日のリマインドも初期状態ではOFF。開始は startReminders、停止は stopReminders。
 *     状態はスクリプトプロパティ BOT_REMINDERS(on/off)
 *
 * 動き
 *  - 依頼テンプレ(「□ 案件名」を含む投稿)を検知 → 10〜15分後に一次返信
 *    (0時〜9時の依頼は 9:00〜9:20 に返信。曜日は問わない)
 *    ポーリングが5分おきなので、実際の投稿は最大5分ずれます
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
  ID_SELF: '11316015',           // 受付アカウント(相宮 美桜。旧「有流悟 理澄 -事務-」と同一)
  ID_MORIOKA: '10003938',        // 森岡 奈々
  INTERNAL_IDS: ['11316015', '10003938', '7433976', '11286789'], // 相宮(受付)・森岡・松井・牛嶋
  ASSIGNEES: { '10003938': '森岡', '11286789': '牛嶋', '7433976': '松井' }, // アカウントID → 台帳の担当者名
  ASSIGNERS: ['10003938', '7433976'],  // 割り振りを決められる人(森岡・松井)
  SHARE_MAIL: 'ushikun1130@gmail.com',
  TZ: 'Asia/Tokyo',
  REPLY_MIN_MINUTES: 10,
  REPLY_MAX_MINUTES: 15,
  MORNING_HOUR: 9,
  MORNING_WINDOW_MINUTES: 20,  // 朝の返信を9:00〜9:20に散らす(5分おきのポーリングで同時投稿にならないように)
  POLL_MINUTES: 5,             // トリガーの間隔(分)。変更したら installTrigger を実行し直す
  REMIND_HOUR: 12,             // 提出予定日のリマインドを送る時刻(正午)
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
// 初稿スケジュールの連絡(依頼者向け) 3パターン
const SCHEDULE_PATTERNS = [
  'ご依頼いただいた件のスケジュールについてです。\n下記日時でいかがでしょうか？\nご確認よろしくお願いいたします',
  'ご依頼いただいた件の初稿スケジュールです。\n下記日時で進めさせていただければと思います。\nご確認よろしくお願いいたします',
  'お待たせいたしました。ご依頼いただいた件のスケジュールです。\n下記日時でいかがでしょうか？\nご確認のほどよろしくお願いいたします',
];
function pickSchedulePattern_() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('LAST_SCHEDULE_PATTERN') || -1);
  let idx;
  do { idx = Math.floor(Math.random() * SCHEDULE_PATTERNS.length); } while (idx === last && SCHEDULE_PATTERNS.length > 1);
  props.setProperty('LAST_SCHEDULE_PATTERN', String(idx));
  return SCHEDULE_PATTERNS[idx];
}
function msgSchedule(p) {
  return `[rp aid=${p.clientSenderId} to=${CONFIG.ROOM_CLIENT}-${p.clientMessageId}]${p.clientSenderName}さん\n` +
    `${greeting_()}\n` +
    `${pickSchedulePattern_()}${bow_()}\n` +
    `[info][title]${p.requestedMD}ご依頼　${p.caseName || 'ご依頼の件'}${p.count ? '　' + p.count : ''}[/title]\n` +
    `〜${p.dueMD}\n[/info]`;
}
function msgScheduleAmbiguous(reporterName, link) {
  return `[To:${CONFIG.ID_MORIOKA}]森岡さん\n` +
    `お疲れさまです。${reporterName}さんのご報告に日付が複数あり、先方提出日を判断できませんでした。\n` +
    '恐れ入りますが、先方への連絡をお願いいたします。\n' +
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
    `案件シート: ${Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMM')}タブ No.${rowNo}〜\n\n` +
    'この投稿への返信で、担当の方から「先方提出日」をご報告ください(例: 9/14)。\n' +
    'そのまま依頼者へ初稿スケジュールとしてお伝えします。';
}
function msgShareRevision(senderName, link) {
  return `[To:${CONFIG.ID_MORIOKA}]森岡さん\n` +
    `お疲れさまです。${senderName}さんから修正のご依頼が届いています。\n` +
    'ご対応をお願いいたします。\n' +
    `メッセージ: ${link}\n\n` +
    'この投稿への返信で、担当の方から「先方提出日」をご報告ください(例: 9/27)。\n' +
    'そのまま依頼者へスケジュールとしてお伝えします。';
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
// 依頼テンプレかどうか。「製作本数」など表記ゆれがあり、案件名の欄がないこともある。
// □見出しが2つ以上あり、本数・台本・素材・フォーマットのいずれかが含まれていれば依頼とみなす。
function isRequest_(body) {
  if (/□\s*案件名/.test(body)) return true;
  if (/□\s*[制製]作本数/.test(body)) return true;
  const heads = (body.match(/□\s*[^\n]{1,20}/g) || []).length;
  return heads >= 2 && /□\s*([制製]作)?(本数|フォーマット|台本|素材)/.test(body);
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
  if (isAcknowledgement_(body)) return null;       // 「承知しました」などの相槌は無反応
  return 'mention';                                // その他の事務宛メンション → 汎用返信+森岡さんへ共有
}

// 相槌だけの短い返信か(宛名・タグを除いた本文で判断)。
// 「承知しました！よろしくお願いします。」のように相槌が連なる場合も拾う。
const ACK_PHRASES = [
  '承知いたしました', '承知しました', 'かしこまりました', '了解いたしました', '了解しました', '了解です',
  'ありがとうございました', 'ありがとうございます', 'ありがとうござます', 'ありがとうございす',
  'よろしくお願いいたします', 'よろしくお願いします', 'よろしくお願い致します', 'お願いいたします', 'お願いします',
  '確認いたします', '確認します', '拝見します', '大丈夫です', '助かります', 'はい', 'OK', 'ok',
];
function isAcknowledgement_(body) {
  let text = body.replace(/\[[^\]]*\]/g, ' ')          // Chatworkのタグを除く
    .split('\n').map(x => x.trim())
    .filter(x => x && !/(さん|様)$/.test(x))            // 宛名の行を除く
    .join(' ').trim();
  if (!text) return true;
  if (text.length > 40) return false;
  text = text.replace(/\([A-Za-z^;:'`\-\s]{1,12}\)/g, ' ');   // (bow) (sweat) などの顔文字
  ACK_PHRASES.forEach(w => { text = text.split(w).join(''); });
  // 残りが記号・絵文字・空白だけなら相槌とみなす
  return !/[0-9A-Za-z぀-ヿ一-鿿]/.test(text);
}

function parseRequest_(msg) {
  const r = parseRequestBody_(stripQuotes_(msg.body));
  r.senderId = String(msg.account.account_id);
  r.senderName = cleanName_(msg.account.name);
  return r;
}
function parseRequestBody_(body) {
  return {
    caseName: field_(body, '案件名') || '',
    count: field_(body, '[制製]作本数') || field_(body, '本数') || '',
    format: field_(body, '制作フォーマット') || '',
    due: field_(body, 'ご希望納期') || '',
  };
}

// 修正依頼に案件名がないことが多いため、手がかりから補う。
//  1) □案件名 / □制作本数 が書かれていればそれを使う
//  2) 本文に元の依頼メッセージのリンクがあれば、その依頼の案件名を引き継ぐ
//  3) それでも決まらなければ、台帳の案件名が本文に出てくるか照合する
function enrichRevision_(payload, body, bot) {
  const p = parseRequestBody_(body);
  if (p.caseName) payload.caseName = p.caseName;
  if (p.count) payload.count = p.count;
  if (payload.caseName) return;

  const link = body.match(/rid\d+-(\d+)/);
  if (link) {
    const last = bot.getLastRow();
    if (last >= 2) {
      bot.getRange(2, 1, last - 1, 7).getValues().forEach(r => {
        if (payload.caseName || String(r[0]) !== link[1]) return;
        try {
          const prev = JSON.parse(r[6] || '{}');
          if (prev.caseName) payload.caseName = prev.caseName;
          if (!payload.count && prev.count) payload.count = prev.count;
        } catch (e) {}
      });
    }
  }
  if (payload.caseName) return;

  try {
    const rows = findCaseRowsByText_(body, true);
    if (rows.length) {
      const v = rows[0].sheet.getRange(rows[0].row, 5).getValue();
      if (v) payload.caseName = String(v);
    }
  } catch (e) { Logger.log('案件名の照合に失敗: ' + e.message); }
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
  // 0:00〜8:59 の依頼: 当日 9:00〜9:20
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
    detectSubmissions_();
    detectDeliveries_();
    remindDue_();
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
    let payload;
    if (kind === 'request') {
      payload = parseRequest_(m);
    } else {
      payload = { senderId: String(m.account.account_id), senderName: cleanName_(m.account.name) };
      if (kind === 'revision') enrichRevision_(payload, stripQuotes_(m.body), bot);
    }
    const at = kind === 'inquiry' ? new Date() : replyAt_(m.send_time); // 依頼者へ返信するものは10〜15分後
    bot.appendRow([String(m.message_id), kind, new Date(m.send_time * 1000), at, payload.senderId, payload.senderName, JSON.stringify(payload), 'pending']);
  });
  setLastSeen_(maxT);
}

// 返信のON/OFF(スクリプトプロパティ BOT_REPLIES)。初期値はOFF。
function repliesEnabled_() { return PropertiesService.getScriptProperties().getProperty('BOT_REPLIES') === 'on'; }
// いまBotがどう動いているかを1回で確認する
function showStatus() {
  const props = PropertiesService.getScriptProperties();
  const fmt = (k) => {
    const v = props.getProperty(k);
    return v ? Utilities.formatDate(new Date(Number(v) * 1000), CONFIG.TZ, 'yyyy/MM/dd HH:mm') : '(未設定)';
  };
  const out = ['=== Bot の状態 ' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM/dd HH:mm') + ' ==='];

  out.push('[返信] 一次返信: ' + (repliesEnabled_() ? 'ON(依頼者へ投稿します)' : 'OFF(台帳更新のみ)'));
  out.push('[返信] 提出日リマインド: ' + (remindersEnabled_() ? 'ON' : 'OFF'));

  const trg = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'poll');
  out.push('[起動] poll のトリガー: ' + (trg.length ? `${trg.length}件 登録済み(設定は${CONFIG.POLL_MINUTES}分おき)` : '未登録(installTrigger を実行してください)'));

  out.push('[既読] TendAiルーム(依頼): ' + fmt('LAST_SEEN'));
  out.push('[既読] 制作グループ(割り振り): ' + fmt('LAST_SEEN_PROD'));
  out.push('[既読] 制作グループ(提出): ' + fmt('LAST_SEEN_SUBMIT'));
  out.push('[既読] TendAiルーム(納品): ' + fmt('LAST_SEEN_DELIVERY'));
  out.push('[既読] 最後にリマインドした日: ' + (props.getProperty('LAST_REMIND_DATE') || '(まだ送っていません)'));

  const bot = botSheet_();
  const last = bot.getLastRow();
  let pending = 0, err = 0;
  if (last >= 2) {
    bot.getRange(2, 8, last - 1, 1).getValues().forEach(r => {
      if (r[0] === 'pending') pending++;
      if (String(r[0]).indexOf('error') === 0) err++;
    });
  }
  out.push(`[予約] 未送信 ${pending}件 / エラー ${err}件 / 履歴 ${Math.max(last - 1, 0)}件`);

  const name = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMM');
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) out.push(`[台帳] ${name}タブ: 未作成`);
  else {
    // 数式と凡例が入っているぶんを除き、依頼日(B列)が埋まっている行だけ数える
    const last = sh.getLastRow();
    const rows = last >= 2 ? sh.getRange(2, 2, last - 1, 1).getValues().filter(r => r[0] !== '').length : 0;
    let done = 0;
    if (last >= 2) sh.getRange(2, 12, last - 1, 1).getValues().forEach(r => { if (r[0] === '納品済') done++; });
    out.push(`[台帳] ${name}タブ: ${rows}本(うち納品済 ${done}本)`);
  }
  out.push('[動画尺] YouTube Data API: ' + (typeof YouTube === 'undefined' ? '未有効' : '有効'));

  Logger.log(out.join('\n'));
}

// 本番投入の直前に実行する。既読位置を「いま」に揃え、未処理の予約を破棄する。
// これをしないと、前回Botが動いたとき以降の古い依頼に今さら返信してしまう可能性がある。
function resetCursors() {
  const props = PropertiesService.getScriptProperties();
  const now = String(Math.floor(Date.now() / 1000));
  ['LAST_SEEN', 'LAST_SEEN_PROD', 'LAST_SEEN_SUBMIT', 'LAST_SEEN_DELIVERY'].forEach(k => props.setProperty(k, now));
  props.deleteProperty('LAST_REMIND_DATE');
  const bot = botSheet_();
  const last = bot.getLastRow();
  let n = 0;
  if (last >= 2) {
    const st = bot.getRange(2, 8, last - 1, 1).getValues();
    st.forEach((r, i) => { if (r[0] === 'pending') { bot.getRange(i + 2, 8).setValue('skipped(reset)'); n++; } });
  }
  Logger.log(`既読位置を現在時刻に揃えました。未処理の予約${n}件を破棄しました。\n以降に届く投稿から処理します。`);
}

function startReplies() { PropertiesService.getScriptProperties().setProperty('BOT_REPLIES', 'on'); Logger.log('一次返信を開始しました(BOT_REPLIES=on)。以後の依頼から返信します'); }
function stopReplies()  { PropertiesService.getScriptProperties().setProperty('BOT_REPLIES', 'off'); Logger.log('一次返信を停止しました(BOT_REPLIES=off)。台帳への起票と担当者の反映は続きます'); }

function dispatch_() {
  const bot = botSheet_();
  const enabled = repliesEnabled_();
  const last = bot.getLastRow();
  if (last < 2) return;
  const rows = bot.getRange(2, 1, last - 1, 8).getValues();
  const now = new Date();
  rows.forEach((r, i) => {
    if (r[7] !== 'pending' || new Date(r[3]) > now) return;
    const messageId = String(r[0]), kind = r[1], payload = JSON.parse(r[6]);
    const link = messageLink_(CONFIG.ROOM_CLIENT, messageId);
    try {
      if (!enabled) {
        // 返信OFF中: 依頼だけ台帳に起票し、Chatworkには何も投稿しない。ONにしても過去分をさかのぼって返信はしない
        if (kind === 'request') appendCase_(payload, new Date(r[2]), link);
        bot.getRange(i + 2, 8).setValue('skipped(replies off)'); // scheduleは台帳反映済み、投稿のみ見送り
        return;
      }
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
        const shared = cwPost_(CONFIG.ROOM_PROD, msgShareRevision(payload.senderName, link));
        // 新規依頼と同じく、この共有メッセージへの返信で先方提出日を報告できるようにする
        payload.shareMessageId = String(shared.message_id);
        payload.sheetName = Utilities.formatDate(new Date(r[2]), CONFIG.TZ, 'yyyyMM');
        payload.isRevision = true;
        bot.getRange(i + 2, 7).setValue(JSON.stringify(payload));
      } else if (kind === 'inquiry') {
        cwPost_(CONFIG.ROOM_PROD, msgShareInquiry(payload.senderName, link));
      } else if (kind === 'mention') {
        cwPost_(CONFIG.ROOM_CLIENT, msgGenericReply(payload.senderId, payload.senderName));
        cwPost_(CONFIG.ROOM_PROD, msgShareGeneric(payload.senderName, link));
      } else if (kind === 'schedule') {
        cwPost_(CONFIG.ROOM_CLIENT, msgSchedule(payload));
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

// ===== 提出の検知(制作グループ) =====
// 担当者の「(F)初稿提出 / (F)修正稿提出」を読み取り、台帳のYouTube URLを常に最新に保つ。
// 修正稿が出るたびに上書きするので、シートのURLは必ず最新版を指す。
// 動画尺は YouTube Data API v3(拡張サービス)で実尺を取得し、マスタの区分に切り上げて入れる。
//
// 対応する書式(牛嶋さんの実際の投稿):
//   (F)初稿提出        (F)修正稿提出
//   □橋谷のり子さん     □坂本桃太郎さん
//   ① 年齢・今さら不安   初心者・未経験軸
//   https://youtube.com/shorts/xxxx
//   □動画データ         □ プロマネ / □ 動画データ
//   https://gigafile...
function detectSubmissions_() {
  // detectAssignments_ と同じ取得結果を使い回せないため、ここでは専用の既読位置を持つ
  const props = PropertiesService.getScriptProperties();
  let since = Number(props.getProperty('LAST_SEEN_SUBMIT') || 0);
  if (!since) { since = Math.floor(Date.now() / 1000); props.setProperty('LAST_SEEN_SUBMIT', String(since)); return; }
  const msgs = cwGet_(`/rooms/${CONFIG.ROOM_PROD}/messages?force=1`);
  let maxT = since;
  msgs.forEach(m => {
    if (m.send_time <= since) return;
    maxT = Math.max(maxT, m.send_time);
    try { applySubmission_(m); } catch (e) { Logger.log('submission error: ' + e.message); }
  });
  props.setProperty('LAST_SEEN_SUBMIT', String(maxT));
}

function applySubmission_(m) {
  const sub = parseSubmission_(stripQuotes_(m.body));
  if (!sub) return false;
  const t = findRowForSubmission_(sub, new Date(m.send_time * 1000));
  if (!t) { Logger.log(`提出検知: 台帳に該当行なし(${sub.caseName} / ${sub.title})`); return false; }

  t.sheet.getRange(t.row, 9).setValue(sub.url);              // I: YouTube URL を常に最新へ
  if (sub.title && t.sheet.getRange(t.row, 6).getValue() !== sub.title) {
    t.sheet.getRange(t.row, 6).setValue(sub.title);          // F: 動画名を実際のタイトルに合わせる
  }
  const len = videoLengthTier_(sub.url);
  if (len) t.sheet.getRange(t.row, 7).setValue(len);         // G: 動画尺(区分)

  Logger.log(`提出検知: ${sub.kind} ${sub.caseName} / ${sub.title} -> ${t.sheetName}行${t.row}${len ? ' 尺' + len : ''}`);
  return true;
}

// 提出メッセージを解析する。提出でなければ null
function parseSubmission_(body) {
  const kind = body.match(/\(F\)\s*(初稿|修正稿|再修正稿)\s*提出/);
  if (!kind) return null;
  const url = body.match(/https?:\/\/(?:youtube\.com\/shorts\/|youtu\.be\/|www\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{6,})/);
  if (!url) return null;
  const lines = body.split('\n').map(x => x.trim()).filter(x => x !== '');
  let caseName = '', title = '', seenCase = false;
  for (const line of lines) {
    if (/\(F\)/.test(line)) continue;
    if (/^□/.test(line)) {
      const v = line.replace(/^□\s*/, '').trim();
      if (!seenCase) {
        // 「□LIA起業塾 縦型＿１」のように案件名とタイトルが同じ行のことがある
        const sp = v.split(/[\s　]+/);
        caseName = sp[0];
        if (sp.length > 1) title = sp.slice(1).join(' ');
        seenCase = true;
      }
      continue;                                   // □動画データ / □プロマネ は読み飛ばす
    }
    if (/^https?:\/\//.test(line)) continue;
    if (seenCase && !title) title = line;         // 案件名とURLの間の行がタイトル
  }
  if (!caseName) return null;
  title = title.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').replace(/^\d+[\.\)、]\s*/, '').trim();
  return { kind: kind[1], caseName: caseName, title: title, url: url[0], videoId: url[1] };
}

// 提出に対応する台帳の行を探す。見つからなければ、その案件の未提出行に割り当てる
function findRowForSubmission_(sub, when) {
  const ss = SpreadsheetApp.getActive();
  const cur = Utilities.formatDate(when, CONFIG.TZ, 'yyyyMM');
  const key = normCase_(sub.caseName);
  const titleKey = normCase_(sub.title);
  const sheets = [cur, prevMonthName_(cur)].map(n => ({ name: n, sh: ss.getSheetByName(n) })).filter(x => x.sh);

  let placeholder = null;
  for (const { name, sh } of sheets) {
    const lastRow = sh.getLastRow();
    if (lastRow < 2) continue;
    const vals = sh.getRange(2, 2, lastRow - 1, 8).getValues();   // B..I
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v[0] === '') continue;
      if (normCase_(v[3]) !== key) continue;                      // E 案件名が一致するか
      const vname = String(v[4] || '');
      // 1) 動画名が提出のタイトルと一致(修正稿はここで同じ行に戻る)
      if (titleKey && normCase_(vname) === titleKey) return { sheet: sh, row: i + 2, sheetName: name };
      // 2) 動画名が未設定(空欄または「動画1」などの仮の値)でURL未入力の行を、割り当て先として控えておく
      if (!placeholder && v[7] === '' && (vname === '' || /^動画\d*$/.test(vname))) {
        placeholder = { sheet: sh, row: i + 2, sheetName: name };
      }
    }
  }
  return placeholder;
}

// YouTubeの実尺を取得し、マスタの動画尺区分に切り上げる。取得できなければ空文字
function videoLengthTier_(url) {
  const sec = youtubeDurationSec_(url);
  if (!sec) return '';
  const ms = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_MASTER);
  if (!ms) return '';
  const tiers = ms.getRange(2, 3, 30, 1).getValues()
    .map(r => String(r[0] || ''))
    .filter(x => /\d/.test(x))
    .map(x => ({ label: x, sec: Number(x.replace(/[^\d]/g, '')) }))
    .sort((a, b) => a.sec - b.sec);
  for (const t of tiers) if (sec <= t.sec) return t.label;
  return tiers.length ? tiers[tiers.length - 1].label : '';
}

// 動画の尺(秒)を取得する。取れなければ 0
// 主経路は YouTube Data API v3(拡張サービス)。スプレッドシート所有者の権限で読むため、
// 限定公開の動画でも確実に取得できる。videos.list は1本あたり1単位で、無料枠は1日10,000単位。
//   有効化: エディタ左メニュー「サービス」→ YouTube Data API v3 を追加(識別子は YouTube のまま)
// 予備として内部API(InnerTube)も試すが、限定公開では弾かれることが多く当てにはできない。
function youtubeDurationSec_(url) {
  const m = url.match(/(?:shorts\/|youtu\.be\/|v=)([A-Za-z0-9_-]{6,})/);
  if (!m) return 0;
  return dataApiDurationSec_(m[1]) || innertubeDurationSec_(m[1]);
}

function innertubeDurationSec_(videoId) {
  try {
    const res = UrlFetchApp.fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'ja', gl: 'JP' } },
        videoId: videoId,
      }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code >= 300) { Logger.log(`動画尺の取得に失敗(InnerTube HTTP ${code})`); return 0; }
    const d = JSON.parse(res.getContentText());
    const sec = Number(((d.videoDetails || {}).lengthSeconds) || 0);
    if (!sec) Logger.log(`動画尺が取れず(InnerTube status=${((d.playabilityStatus || {}).status) || '不明'})`);
    return sec > 0 ? sec : 0;
  } catch (e) {
    Logger.log('動画尺の取得に失敗(InnerTube): ' + e.message);
    return 0;
  }
}

// 主経路。拡張サービス「YouTube Data API v3」が有効なときだけ動く
function dataApiDurationSec_(videoId) {
  try {
    if (typeof YouTube === 'undefined') {
      Logger.log('動画尺: YouTube Data API v3 が未有効です(エディタ左「サービス」から追加してください)');
      return 0;
    }
    const res = YouTube.Videos.list('contentDetails', { id: videoId });
    if (!res || !res.items || !res.items.length) return 0;
    const p = String(res.items[0].contentDetails.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!p) return 0;
    return Math.ceil((Number(p[1] || 0) * 3600) + (Number(p[2] || 0) * 60) + Number(p[3] || 0));
  } catch (e) {
    Logger.log('動画尺の取得に失敗(Data API): ' + e.message);
    return 0;
  }
}

// 診断用: 動画尺が入らないときに、どこで失敗しているかを1回で確かめる
function diagnoseVideoLength(url) {
  const u = url || 'https://youtube.com/shorts/YstsoLETxuE';
  const id = (u.match(/(?:shorts\/|youtu\.be\/|v=)([A-Za-z0-9_-]{6,})/) || [])[1];
  const out = ['診断対象: ' + u, 'videoId: ' + (id || '(抽出できず)')];

  // 1) InnerTube
  try {
    const res = UrlFetchApp.fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'ja', gl: 'JP' } }, videoId: id }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    out.push(`[1] InnerTube HTTP ${code} / 応答 ${body.length}バイト`);
    if (code < 300) {
      const d = JSON.parse(body);
      out.push(`    playabilityStatus: ${((d.playabilityStatus || {}).status) || '(なし)'}`);
      out.push(`    lengthSeconds: ${((d.videoDetails || {}).lengthSeconds) || '(なし)'}`);
      out.push(`    title: ${((d.videoDetails || {}).title) || '(なし)'}`);
    } else {
      out.push('    応答の冒頭: ' + body.slice(0, 200).replace(/\n/g, ' '));
    }
  } catch (e) { out.push('[1] InnerTube 例外: ' + e.message); }

  // 2) YouTube Data API(拡張サービス)
  if (typeof YouTube === 'undefined') {
    out.push('[2] YouTube Data API: 拡張サービスが未有効(エディタ左「サービス」から YouTube Data API v3 を追加すると使えます)');
  } else {
    try {
      const r = YouTube.Videos.list('contentDetails', { id: id });
      out.push(`[2] YouTube Data API: ${r && r.items && r.items.length ? r.items[0].contentDetails.duration : '該当なし'}`);
    } catch (e) { out.push('[2] YouTube Data API 例外: ' + e.message); }
  }

  // 3) マスタの動画尺一覧
  const ms = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_MASTER);
  if (!ms) out.push('[3] マスタシートが見つかりません');
  else {
    const t = ms.getRange(2, 3, 30, 1).getValues().map(x => String(x[0] || '')).filter(x => /\d/.test(x));
    out.push(`[3] マスタの動画尺(C列): ${t.length ? t.join(' / ') : '(空。C列に「〜60秒」などを入れてください)'}`);
  }

  out.push(`[4] 最終結果: 実尺 ${youtubeDurationSec_(u)}秒 / 区分 ${videoLengthTier_(u) || '(なし)'}`);
  Logger.log(out.join('\n'));
}

// テスト用: URLを渡すと尺と区分をログに出す
function testVideoLength(url) {
  const u = url || 'https://youtube.com/shorts/YstsoLETxuE';
  Logger.log(`${u}\n  実尺: ${youtubeDurationSec_(u)}秒  区分: ${videoLengthTier_(u) || '(取得できず)'}`);
}

// テスト用: 制作グループの過去の提出を台帳に反映する(投稿なし)
function backfillSubmissions() {
  let n = 0;
  cwGet_(`/rooms/${CONFIG.ROOM_PROD}/messages?force=1`).forEach(m => {
    try { if (applySubmission_(m)) n++; } catch (e) { Logger.log(e.message); }
  });
  Logger.log(`${n}件の提出を台帳に反映しました`);
}

// ===== 客先納品の検知(TendAiルーム) =====
// 「初稿ご確認のお願い / 修正稿ご確認のお願い」を読み取り、台帳のURLと動画尺を更新する。
// 森岡さんのように制作グループを通さず直接納品する場合も、これで台帳が最新になる。
// 制作グループの提出検知と両方が動いた場合は、後から処理されたほう(時系列で新しいほう)が残る。
function detectDeliveries_() {
  const props = PropertiesService.getScriptProperties();
  let since = Number(props.getProperty('LAST_SEEN_DELIVERY') || 0);
  if (!since) { since = Math.floor(Date.now() / 1000); props.setProperty('LAST_SEEN_DELIVERY', String(since)); return; }
  const msgs = cwGet_(`/rooms/${CONFIG.ROOM_CLIENT}/messages?force=1`);
  let maxT = since;
  msgs.forEach(m => {
    if (m.send_time <= since) return;
    maxT = Math.max(maxT, m.send_time);
    try { applyDelivery_(m); } catch (e) { Logger.log('delivery error: ' + e.message); }
  });
  props.setProperty('LAST_SEEN_DELIVERY', String(maxT));
}

function applyDelivery_(m) {
  if (!CONFIG.INTERNAL_IDS.includes(String(m.account.account_id))) return false;  // 社内からの納品のみ
  const d = parseDelivery_(stripQuotes_(m.body));
  if (!d) return false;
  const when = new Date(m.send_time * 1000);
  let n = 0;
  d.items.forEach(item => {
    const t = findRowForSubmission_({ caseName: d.caseName, title: item.title }, when);
    if (!t) { Logger.log(`納品検知: 該当行なし(${d.caseName} / ${item.title || '(タイトルなし)'})`); return; }
    t.sheet.getRange(t.row, 9).setValue(item.url);
    if (item.title && t.sheet.getRange(t.row, 6).getValue() !== item.title) t.sheet.getRange(t.row, 6).setValue(item.title);
    const len = videoLengthTier_(item.url);
    if (len) t.sheet.getRange(t.row, 7).setValue(len);
    n++;
  });
  if (n) Logger.log(`納品検知: ${d.kind} ${d.caseName} ${n}本を更新`);
  return n > 0;
}

// Chatworkの装飾タグを外す(改行は残す)
function stripTags_(body) {
  return body.replace(/\[(?:hr|info|\/info|code|\/code|title|\/title|dtext:[^\]]*|preview[^\]]*|download:[^\]]*|\/download)\]/g, '\n')
             .replace(/\[[^\]\n]{0,80}\]/g, '');
}

// 納品メッセージを解析する。納品でなければ null
//   [code]修正稿ご確認のお願い / 8/14ご依頼　ACTION4さま[/code]
//   01｜無償活動を…        ← タイトル
//   https://youtube.com/shorts/xxxx
function parseDelivery_(body) {
  const kind = body.match(/(初稿|修正稿|再修正稿)ご確認のお願い/);
  if (!kind) return null;
  const text = stripTags_(body);
  const cm = text.match(/\d{1,2}\s*[\/月]\s*\d{1,2}[^\n]*?ご依頼[\s　]*([^\n]+)/);
  if (!cm) return null;
  const caseName = cm[1].trim();

  const lines = text.split('\n').map(x => x.trim());
  const YT = /https?:\/\/(?:www\.)?(?:youtube\.com\/shorts\/|youtu\.be\/|youtube\.com\/watch\?v=)[A-Za-z0-9_?=&.\-]+/;
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const um = lines[i].match(YT);
    if (!um) continue;
    let title = '';
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {           // 直前の数行からタイトルを探す
      const c = lines[j];
      if (c === '' || YT.test(c)) continue;
      if (isBoilerplate_(c)) break;                            // 挨拶・定型文はタイトルにしない
      title = c; break;
    }
    title = title.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').replace(/^\d+[\.\)、｜|]\s*/, '').trim();
    items.push({ title: title, url: um[0].split('?')[0] });
  }
  if (!items.length) return null;
  return { kind: kind[1], caseName: caseName, items: items };
}

function isBoilerplate_(line) {
  if (line.length > 60) return true;
  return /お世話になっ|よろしくお願い|ご確認のほど|お待たせ|上記の件|ありがとうござ|となります|いたします|ご依頼|ご確認のお願い/.test(line);
}

// テスト用: TendAiルームの過去の納品を台帳に反映する(投稿なし)
function backfillDeliveries() {
  let n = 0;
  cwGet_(`/rooms/${CONFIG.ROOM_CLIENT}/messages?force=1`).forEach(m => {
    try { if (applyDelivery_(m)) n++; } catch (e) { Logger.log(e.message); }
  });
  Logger.log(`${n}通の納品メッセージを台帳に反映しました`);
}

// ===== 提出予定日のリマインド(制作グループ) =====
// 毎日 正午 に、担当者ごとにToを分けて制作グループへ投稿する。
// 「本日が先方提出日」と「明日が先方提出日」の案件を、担当者本人にだけ知らせる。
// YouTube URL が入っている行(納品済)と、担当者が空の行は対象外。
// リマインドは BOT_REMINDERS(on/off)で切り替える。初期値はOFF。
function remindersEnabled_() { return PropertiesService.getScriptProperties().getProperty('BOT_REMINDERS') === 'on'; }
function startReminders() { PropertiesService.getScriptProperties().setProperty('BOT_REMINDERS', 'on'); Logger.log('提出日リマインドを開始しました(BOT_REMINDERS=on)'); }
function stopReminders()  { PropertiesService.getScriptProperties().setProperty('BOT_REMINDERS', 'off'); Logger.log('提出日リマインドを停止しました(BOT_REMINDERS=off)'); }

function remindDue_() {
  if (!remindersEnabled_()) return;
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const today = ymd_(now);
  if (props.getProperty('LAST_REMIND_DATE') === today) return;              // 今日はもう送った
  if (Number(Utilities.formatDate(now, CONFIG.TZ, 'H')) < CONFIG.REMIND_HOUR) return; // 正午前
  props.setProperty('LAST_REMIND_DATE', today);                            // 先に記録して二重送信を防ぐ
  const msgs = buildReminders_(now);
  let sent = 0;
  Object.keys(msgs).forEach(id => {
    try { cwPost_(CONFIG.ROOM_PROD, msgs[id]); sent++; }
    catch (e) { Logger.log(`リマインド送信に失敗(${CONFIG.ASSIGNEES[id]}): ${e.message}`); }
  });
  Logger.log(`提出日リマインド: ${sent}/${Object.keys(msgs).length}名へ送信`);
}

// 担当者のアカウントID別に、リマインド文面を組み立てる
function buildReminders_(now) {
  const ss = SpreadsheetApp.getActive();
  const today = ymd_(now);
  const tomorrow = ymd_(new Date(now.getTime() + 86400000));
  const byId = {};   // accountId -> {today:[], tomorrow:[]}
  const nameToId = {};
  Object.keys(CONFIG.ASSIGNEES).forEach(id => { nameToId[CONFIG.ASSIGNEES[id]] = id; });

  const cur = Utilities.formatDate(now, CONFIG.TZ, 'yyyyMM');
  [cur, prevMonthName_(cur)].map(n => ss.getSheetByName(n)).filter(Boolean).forEach(sh => {
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return;
    const vals = sh.getRange(2, 2, lastRow - 1, 8).getValues();  // B..I
    vals.forEach(v => {
      const [reqDate, due, , caseName, , , assignee, url] = v;   // B,C,D,E,F,G,H,I
      if (reqDate === '' || url !== '' || assignee === '') return;
      if (!(due instanceof Date)) return;                        // 「中止」や空欄は対象外
      const d = ymd_(due);
      const when = d === today ? 'today' : (d === tomorrow ? 'tomorrow' : null);
      if (!when) return;
      const id = nameToId[assignee];
      if (!id) return;                                           // マスタ外の担当者名は対象外
      if (!byId[id]) byId[id] = { today: {}, tomorrow: {} };
      const key = caseName || '(案件名未記載)';
      byId[id][when][key] = (byId[id][when][key] || 0) + 1;
    });
  });

  const out = {};
  Object.keys(byId).forEach(id => {
    const g = byId[id];
    const lines = [];
    const list = (obj) => Object.keys(obj).map(k => `・${k} ${obj[k]}本`).join('\n');
    if (Object.keys(g.today).length) lines.push('【本日が先方提出日】\n' + list(g.today));
    if (Object.keys(g.tomorrow).length) lines.push('【明日が先方提出日】\n' + list(g.tomorrow));
    if (!lines.length) return;
    out[id] = `[To:${id}]${CONFIG.ASSIGNEES[id]}さん\nお疲れさまです。\n` +
      lines.join('\n\n') + '\n\n' +
      `提出済みでしたら、この投稿は読み飛ばしてください${bow_()}`;
  });
  return out;
}

// テスト用: いま送るとどうなるかをログに出す(投稿しない)
function previewReminders() {
  const msgs = buildReminders_(new Date());
  const ids = Object.keys(msgs);
  if (!ids.length) { Logger.log('対象の案件はありません'); return; }
  ids.forEach(id => Logger.log('---\n' + msgs[id]));
}

// ===== 担当者からの期日報告(制作グループ) =====
// Botの共有メッセージへの返信に日付が1つあれば、それを「先方提出日」として扱う。
// 返信した人が担当者になり、台帳に担当者と提出予定日を入れたうえで、依頼者へ初稿スケジュールを送る。
// 日付が複数あるときは判断せず、森岡さんにメンションして人に任せる。
function applyScheduleReport_(m) {
  const reporterId = String(m.account.account_id);
  const assignee = CONFIG.ASSIGNEES[reporterId];
  if (!assignee) return false;                     // 社内の担当者以外は対象外
  const body = stripQuotes_(m.body);
  const rp = body.match(/\[rp aid=\d+ to=\d+-(\d+)\]/);
  if (!rp) return false;                           // 共有メッセージへの返信でなければ対象外

  const bot = botSheet_();
  const last = bot.getLastRow();
  if (last < 2) return false;
  const rows = bot.getRange(2, 1, last - 1, 8).getValues();
  let hit = null;
  rows.forEach(r => {
    try { if (JSON.parse(r[6] || '{}').shareMessageId === rp[1]) hit = r; } catch (e) {}
  });
  if (!hit) return false;                          // 共有メッセージ以外への返信
  const p = JSON.parse(hit[6]);
  if (p.scheduleReported) return true;             // 報告済み(二重処理を防ぐ)

  const sent = new Date(m.send_time * 1000);
  const dates = findDates_(body, sent);
  if (!dates.length) return false;                 // 日付がなければ割り振り検知に回す
  const link = messageLink_(CONFIG.ROOM_PROD, m.message_id);
  if (dates.length > 1) {                          // 複数あると先方提出日を特定できない
    if (repliesEnabled_()) cwPost_(CONFIG.ROOM_PROD, msgScheduleAmbiguous(assignee, link));
    Logger.log('期日報告: 日付が複数のため森岡さんへ引き継ぎ');
    return true;
  }

  // 台帳に担当者と先方提出予定日を反映
  const due = dates[0];
  findCaseRows_(p.sheetName, p.caseName).forEach(t => {
    if (t.sheet.getRange(t.row, 8).getValue() === '') t.sheet.getRange(t.row, 8).setValue(assignee);
    if (t.sheet.getRange(t.row, 3).getValue() === '') t.sheet.getRange(t.row, 3).setValue(ymd_(due)).setNumberFormat('yyyy/mm/dd');
  });

  // 依頼者への初稿スケジュール連絡を予約
  const requested = new Date(hit[2]);
  bot.appendRow([String(m.message_id), 'schedule', sent, replyAt_(m.send_time), reporterId, assignee,
    JSON.stringify({
      clientMessageId: String(hit[0]), clientSenderId: p.senderId, clientSenderName: p.senderName,
      caseName: p.caseName, count: p.count, requestedMD: md_(requested), dueMD: md_(due), reporter: assignee,
    }), 'pending']);
  p.scheduleReported = true;
  rows.forEach((r, i) => { if (r[0] === hit[0]) bot.getRange(i + 2, 7).setValue(JSON.stringify(p)); });
  Logger.log(`期日報告: ${p.caseName} 担当${assignee} 先方提出${md_(due)}`);
  return true;
}

// 本文から日付(M/D・M月D日)を拾う。過去の日付は翌年として扱う
function findDates_(body, base) {
  const out = [], seen = {};
  const re = /(\d{1,2})\s*[\/月]\s*(\d{1,2})日?/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    const mo = Number(mm[1]), da = Number(mm[2]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
    const key = mo + '/' + da;
    if (seen[key]) continue;
    seen[key] = true;
    const y = Number(Utilities.formatDate(base, CONFIG.TZ, 'yyyy'));
    let d = parseJst_(`${y}/${mo}/${da} 00:00:00`);
    if (d.getTime() < base.getTime() - 86400000 * 30) d = parseJst_(`${y + 1}/${mo}/${da} 00:00:00`);
    out.push(d);
  }
  return out;
}
function md_(d) { return Number(Utilities.formatDate(d, CONFIG.TZ, 'M')) + '/' + Number(Utilities.formatDate(d, CONFIG.TZ, 'd')); }

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
    try {
      // 共有メッセージへの返信で先方提出日が報告されていれば、それを優先して処理する
      if (!applyScheduleReport_(m)) applyAssignment_(m);
    } catch (e) { Logger.log('assignment error: ' + e.message); }
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
  const targets = findCaseRowsByText_(body, /*includeAssigned*/ true); // 担当者が入っていても提出予定日は埋める
  if (!targets.length) return false;
  const dm = body.match(/[〜～~]\s*(\d{1,2}\/\d{1,2})/);
  const due = parseDue_(dm ? dm[1] : '', new Date(m.send_time * 1000));
  targets.forEach(t => {
    if (t.sheet.getRange(t.row, 8).getValue() === '') t.sheet.getRange(t.row, 8).setValue(CONFIG.ASSIGNEES[CONFIG.ID_MORIOKA]); // 未割り振りなら森岡さん
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
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(CONFIG.POLL_MINUTES).create();
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
