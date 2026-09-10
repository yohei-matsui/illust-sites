/*
 * ワンポチくん - ホイール -  (Premiere Pro UXP パネル)
 *
 * このパネルは「設定画面」です。
 *   - 8 方向それぞれに「表示名」と「ショートカットキー」を登録する
 *   - 呼び出し方法(⌘ を素早く 2 回 など)を設定する
 *   - ON / OFF を切り替える
 *
 * 実際にキー入力を監視してホイールを描き、選ばれたショートカットを Premiere に
 * 送るのは macOS 側の Hammerspoon スクリプト (hammerspoon/onepochi_wheel.lua) です。
 * パネルと Hammerspoon は localhost の WebSocket でつながります。
 * (UXP プラグインは Premiere からキーボードショートカットを受け取れないため)
 */

const WS_URL = "ws://127.0.0.1:47811/ws";
const STORAGE_KEY = "onepochi.wheel.config";

// 0 = 上、時計回り
const DIRS = [
  { id: "N", ja: "上", arrow: "↑", row: 0, col: 1 },
  { id: "NE", ja: "右上", arrow: "↗", row: 0, col: 2 },
  { id: "E", ja: "右", arrow: "→", row: 1, col: 2 },
  { id: "SE", ja: "右下", arrow: "↘", row: 2, col: 2 },
  { id: "S", ja: "下", arrow: "↓", row: 2, col: 1 },
  { id: "SW", ja: "左下", arrow: "↙", row: 2, col: 0 },
  { id: "W", ja: "左", arrow: "←", row: 1, col: 0 },
  { id: "NW", ja: "左上", arrow: "↖", row: 0, col: 0 },
];

const MOD_SYMBOL = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", fn: "fn" };
const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"];

// Premiere Pro (macOS 既定) を元にした初期割り当て。すべて変更可能。
function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    trigger: { modifier: "cmd", taps: 2, interval: 0.35 },
    wheel: { radius: 120, deadZone: 30 },
    slots: [
      { label: "編集点を追加", mods: ["cmd"], key: "k" },
      { label: "マーカーを追加", mods: [], key: "m" },
      { label: "次の編集点へ", mods: [], key: "down" },
      { label: "リップル削除", mods: ["shift"], key: "forwarddelete" },
      { label: "保存", mods: ["cmd"], key: "s" },
      { label: "取り消し", mods: ["cmd"], key: "z" },
      { label: "前の編集点へ", mods: [], key: "up" },
      { label: "再生 / 停止", mods: [], key: "space" },
    ],
  };
}

let config = defaultConfig();
let selectedSlot = 0;
let recording = false;
let ws = null;
let wsConnected = false;
let reconnectTimer = null;

// ---------- ユーティリティ ----------
const $ = (id) => document.getElementById(id);

function log(msg) {
  const el = $("log");
  if (el) el.textContent = msg;
  console.log("[onepochi]", msg);
}

function keyToText(slot) {
  if (!slot || !slot.key) return "未設定";
  const mods = MOD_ORDER.filter((m) => (slot.mods || []).includes(m)).map((m) => MOD_SYMBOL[m]);
  return mods.join("") + (mods.length ? " " : "") + slot.key;
}

// ブラウザの KeyboardEvent.key → Hammerspoon (hs.keycodes.map) のキー名
function eventToHsKey(e) {
  const special = {
    Enter: "return",
    Backspace: "delete",
    Delete: "forwarddelete",
    Escape: "escape",
    Tab: "tab",
    " ": "space",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    CapsLock: "capslock",
  };
  if (special[e.key]) return special[e.key];
  if (/^F\d{1,2}$/.test(e.key)) return e.key.toLowerCase();
  // 修飾キー単体は無視
  if (["Shift", "Meta", "Alt", "Control", "Fn"].includes(e.key)) return null;
  // 文字キーは物理キー (code) を優先: Shift 付きでも "k" のまま登録できる
  const codeMap = {
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  };
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (e.code && /^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (e.code && /^Numpad\d$/.test(e.code)) return "pad" + e.code.slice(6);
  if (e.code && codeMap[e.code]) return codeMap[e.code];
  if (e.key.length === 1) return e.key.toLowerCase();
  return null;
}

// ---------- 描画 ----------
function renderGrid() {
  const grid = $("wheel-grid");
  grid.innerHTML = "";
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push({ r, c });
  cells.forEach(({ r, c }) => {
    const div = document.createElement("div");
    if (r === 1 && c === 1) {
      div.className = "cell center";
      div.innerHTML = `<span class="dir">◎</span><span class="lbl">キャンセル</span>`;
      grid.appendChild(div);
      return;
    }
    const idx = DIRS.findIndex((d) => d.row === r && d.col === c);
    const d = DIRS[idx];
    const slot = config.slots[idx] || {};
    const empty = !slot.key;
    div.className = "cell" + (idx === selectedSlot ? " selected" : "") + (empty ? " empty" : "");
    div.innerHTML =
      `<span class="dir">${d.arrow}</span>` +
      `<span class="lbl">${escapeHtml(empty ? "(空)" : slot.label || "(名前なし)")}</span>` +
      `<span class="key">${escapeHtml(empty ? "" : keyToText(slot))}</span>`;
    div.addEventListener("click", () => {
      selectedSlot = idx;
      stopRecording();
      renderGrid();
      renderSlotEditor();
    });
    grid.appendChild(div);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderSlotEditor() {
  const d = DIRS[selectedSlot];
  const slot = config.slots[selectedSlot];
  $("slot-title").textContent = `方向: ${d.arrow} ${d.ja}`;
  $("slot-label").value = slot.label || "";
  $("slot-key").value = slot.key || "";
  document.querySelectorAll("input.mod").forEach((cb) => {
    cb.checked = (slot.mods || []).includes(cb.dataset.mod);
  });
  $("slot-keys").textContent = recording ? "キーを押してください…" : keyToText(slot);
  $("slot-keys").className = "keys" + (recording ? " recording" : "");
}

function renderGlobal() {
  $("enabled").checked = !!config.enabled;
  $("enabled-state").textContent = config.enabled ? "ON" : "OFF";
  $("enabled-state").className = "badge" + (config.enabled ? " on" : "");
  $("trigger-mod").value = config.trigger.modifier;
  $("trigger-taps").value = String(config.trigger.taps);
  $("trigger-interval").value = config.trigger.interval;
  $("wheel-radius").value = config.wheel.radius;
  $("wheel-deadzone").value = config.wheel.deadZone;
}

function renderAll() {
  renderGlobal();
  renderGrid();
  renderSlotEditor();
}

function renderConn() {
  const el = $("conn");
  el.textContent = wsConnected ? "Hammerspoon 接続中" : "Hammerspoon 未接続";
  el.className = "conn " + (wsConnected ? "conn-on" : "conn-off");
}

// ---------- 入力の取り込み ----------
function readFormIntoConfig() {
  config.enabled = $("enabled").checked;
  config.trigger.modifier = $("trigger-mod").value;
  config.trigger.taps = parseInt($("trigger-taps").value, 10) || 2;
  config.trigger.interval = clamp(parseFloat($("trigger-interval").value) || 0.35, 0.15, 1);
  config.wheel.radius = clamp(parseInt($("wheel-radius").value, 10) || 120, 60, 300);
  config.wheel.deadZone = clamp(parseInt($("wheel-deadzone").value, 10) || 30, 10, 100);
  readSlotEditor();
}

function readSlotEditor() {
  const slot = config.slots[selectedSlot];
  slot.label = $("slot-label").value.trim();
  slot.key = $("slot-key").value.trim().toLowerCase();
  slot.mods = Array.from(document.querySelectorAll("input.mod"))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.mod);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------- ショートカット記録 ----------
function startRecording() {
  recording = true;
  renderSlotEditor();
  log("キーを押してください(Esc で中止)");
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  renderSlotEditor();
}

function onKeyDown(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopRecording();
    log("記録を中止しました");
    return;
  }
  const key = eventToHsKey(e);
  if (!key) return; // 修飾キーのみ
  const slot = config.slots[selectedSlot];
  slot.key = key;
  slot.mods = [];
  if (e.metaKey) slot.mods.push("cmd");
  if (e.shiftKey) slot.mods.push("shift");
  if (e.altKey) slot.mods.push("alt");
  if (e.ctrlKey) slot.mods.push("ctrl");
  recording = false;
  renderSlotEditor();
  renderGrid();
  log(`記録: ${keyToText(slot)}`);
}

// ---------- 保存 / 通信 ----------
function persistLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (_) {
    /* localStorage が使えない環境では無視 */
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) config = normalize(JSON.parse(raw));
  } catch (_) {
    config = defaultConfig();
  }
}

// 欠けたフィールドを初期値で埋める
function normalize(c) {
  const d = defaultConfig();
  const out = Object.assign({}, d, c || {});
  out.trigger = Object.assign({}, d.trigger, (c && c.trigger) || {});
  out.wheel = Object.assign({}, d.wheel, (c && c.wheel) || {});
  const slots = Array.isArray(c && c.slots) ? c.slots : [];
  out.slots = d.slots.map((ds, i) => {
    const s = slots[i] || {};
    return {
      label: typeof s.label === "string" ? s.label : "",
      mods: Array.isArray(s.mods) ? s.mods : [],
      key: typeof s.key === "string" ? s.key : "",
    };
  });
  return out;
}

function send(obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function saveAll() {
  stopRecording();
  readFormIntoConfig();
  persistLocal();
  renderAll();
  if (send({ type: "config", config })) {
    log("保存して Hammerspoon に送りました");
  } else {
    log("保存しました(Hammerspoon 未接続。接続後にもう一度「保存」を押してください)");
  }
}

function connect() {
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    wsConnected = true;
    renderConn();
    // 接続時は Hammerspoon 側の設定を正として受け取る
    send({ type: "hello" });
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type === "config" && msg.config) {
      config = normalize(msg.config);
      persistLocal();
      renderAll();
      log("Hammerspoon の設定を読み込みました");
    } else if (msg.type === "status") {
      if (typeof msg.enabled === "boolean") {
        config.enabled = msg.enabled;
        renderGlobal();
      }
    } else if (msg.type === "log" && msg.text) {
      log(String(msg.text));
    }
  };
  ws.onclose = () => {
    wsConnected = false;
    renderConn();
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose で再接続 */
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// ---------- 初期化 ----------
function init() {
  loadLocal();
  renderAll();
  renderConn();

  $("enabled").addEventListener("change", () => {
    config.enabled = $("enabled").checked;
    persistLocal();
    renderGlobal();
    if (send({ type: "setEnabled", enabled: config.enabled })) {
      log(config.enabled ? "ホイール ON" : "ホイール OFF");
    } else {
      log("Hammerspoon 未接続のため、接続後に反映されます");
    }
  });

  ["trigger-mod", "trigger-taps", "trigger-interval", "wheel-radius", "wheel-deadzone"].forEach((id) => {
    $(id).addEventListener("change", () => {
      readFormIntoConfig();
      persistLocal();
    });
  });

  ["slot-label", "slot-key"].forEach((id) => {
    $(id).addEventListener("input", () => {
      readSlotEditor();
      renderGrid();
    });
  });
  document.querySelectorAll("input.mod").forEach((cb) =>
    cb.addEventListener("change", () => {
      readSlotEditor();
      renderGrid();
      $("slot-keys").textContent = keyToText(config.slots[selectedSlot]);
    })
  );

  $("slot-record").addEventListener("click", () => (recording ? stopRecording() : startRecording()));
  $("slot-clear").addEventListener("click", () => {
    config.slots[selectedSlot] = { label: "", mods: [], key: "" };
    stopRecording();
    renderGrid();
    renderSlotEditor();
  });

  $("save").addEventListener("click", saveAll);
  $("reload").addEventListener("click", () => {
    if (!send({ type: "getConfig" })) log("Hammerspoon 未接続です");
  });
  $("reset").addEventListener("click", () => {
    config = defaultConfig();
    selectedSlot = 0;
    persistLocal();
    renderAll();
    log("初期設定に戻しました(「保存」で Hammerspoon に反映)");
  });

  document.addEventListener("keydown", onKeyDown, true);

  connect();
}

// UXP パネルのライフサイクル登録
try {
  const { entrypoints } = require("uxp");
  entrypoints.setup({
    panels: {
      onepochiWheel: {
        show() {},
        hide() {},
      },
    },
  });
} catch (err) {
  console.log("entrypoints.setup failed:", err);
}

document.addEventListener("DOMContentLoaded", init);
