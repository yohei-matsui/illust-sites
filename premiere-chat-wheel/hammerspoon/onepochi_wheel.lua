-- ワンポチくん - ホイール -  (Hammerspoon 側)
--
-- 役割:
--   1. 修飾キー(既定: ⌘)の素早い連打を検知する
--   2. マウスの真上に 8 方向のホイールを描く
--   3. マウスを振った方向のスロットをハイライトし、クリックで
--      そのスロットに登録されたショートカットキーを Premiere Pro に送る
--   4. Premiere の UXP パネル(設定画面)と WebSocket でつながり、
--      設定の受け取り・保存・ON/OFF を行う
--
-- 設定ファイル: ~/.hammerspoon/onepochi_wheel.json (パネルから保存すると更新される)
--
-- init.lua に次の 1 行を追加して使います:
--   require("onepochi_wheel")

local M = {}

local PORT = 47811
local CONFIG_PATH = os.getenv("HOME") .. "/.hammerspoon/onepochi_wheel.json"
local PREMIERE_BUNDLE = "com.adobe.PremierePro"
-- 8 方向: 上から時計回り
local DIRS = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" }

local function defaultConfig()
  return {
    version = 1,
    enabled = true,
    trigger = { modifier = "cmd", taps = 2, interval = 0.35 },
    wheel = { radius = 120, deadZone = 30 },
    slots = {
      { label = "編集点を追加", mods = { "cmd" }, key = "k" },
      { label = "マーカーを追加", mods = {}, key = "m" },
      { label = "次の編集点へ", mods = {}, key = "down" },
      { label = "リップル削除", mods = { "shift" }, key = "forwarddelete" },
      { label = "保存", mods = { "cmd" }, key = "s" },
      { label = "取り消し", mods = { "cmd" }, key = "z" },
      { label = "前の編集点へ", mods = {}, key = "up" },
      { label = "再生 / 停止", mods = {}, key = "space" },
    },
  }
end

local config = defaultConfig()

-- ---------- 設定の読み書き ----------
local function normalize(c)
  local d = defaultConfig()
  c = c or {}
  local out = {
    version = 1,
    enabled = (c.enabled ~= false),
    trigger = {
      modifier = (c.trigger and c.trigger.modifier) or d.trigger.modifier,
      taps = (c.trigger and tonumber(c.trigger.taps)) or d.trigger.taps,
      interval = (c.trigger and tonumber(c.trigger.interval)) or d.trigger.interval,
    },
    wheel = {
      radius = (c.wheel and tonumber(c.wheel.radius)) or d.wheel.radius,
      deadZone = (c.wheel and tonumber(c.wheel.deadZone)) or d.wheel.deadZone,
    },
    slots = {},
  }
  for i = 1, 8 do
    local s = (type(c.slots) == "table" and c.slots[i]) or {}
    out.slots[i] = {
      label = type(s.label) == "string" and s.label or "",
      mods = type(s.mods) == "table" and s.mods or {},
      key = type(s.key) == "string" and s.key or "",
    }
  end
  return out
end

local function loadConfig()
  local ok, data = pcall(hs.json.read, CONFIG_PATH)
  if ok and type(data) == "table" then
    config = normalize(data)
  else
    config = defaultConfig()
  end
end

local function saveConfig()
  -- prettyprint = true, replace = true
  hs.json.write(config, CONFIG_PATH, true, true)
end

-- ---------- Premiere 判定 ----------
local function premiereIsFront()
  local app = hs.application.frontmostApplication()
  if not app then return false end
  local bid = app:bundleID() or ""
  local name = app:name() or ""
  return bid:find(PREMIERE_BUNDLE, 1, true) ~= nil or name:find("Premiere", 1, true) ~= nil
end

-- ---------- ホイール ----------
local wheel = {
  canvas = nil,
  center = nil,
  selected = nil,
  moveTap = nil,
  clickTap = nil,
  keyTap = nil,
}

local COLOR_BG = { red = 0.08, green = 0.08, blue = 0.09, alpha = 0.72 }
local COLOR_SECTOR = { red = 0.20, green = 0.20, blue = 0.22, alpha = 0.85 }
local COLOR_SECTOR_HI = { red = 0.20, green = 0.50, blue = 0.95, alpha = 0.95 }
local COLOR_SECTOR_EMPTY = { red = 0.15, green = 0.15, blue = 0.16, alpha = 0.6 }
local COLOR_LINE = { white = 1, alpha = 0.18 }
local COLOR_TEXT = { white = 1, alpha = 0.95 }
local COLOR_TEXT_DIM = { white = 1, alpha = 0.35 }

local function slotHasKey(i)
  local s = config.slots[i]
  return s and s.key ~= nil and s.key ~= ""
end

local function sectorFromPoint(px, py)
  local dx = px - wheel.center.x
  local dy = py - wheel.center.y
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < config.wheel.deadZone then return nil end
  -- 0° = 上、時計回り(画面座標は y が下向き)
  local ang = math.deg(math.atan(dx, -dy))
  if ang < 0 then ang = ang + 360 end
  return math.floor(((ang + 22.5) % 360) / 45) + 1
end

local function buildCanvas()
  local R = config.wheel.radius
  local pad = 24
  local size = R * 2 + pad * 2
  local c = size / 2 -- キャンバス内の中心

  local cv = hs.canvas.new({ x = wheel.center.x - c, y = wheel.center.y - c, w = size, h = size })
  cv:level(hs.canvas.windowLevels.overlay)
  cv:behavior({ "canJoinAllSpaces", "stationary", "ignoresCycle" })

  -- 背景
  cv:appendElements({
    type = "circle",
    center = { x = c, y = c },
    radius = R + 10,
    action = "fill",
    fillColor = COLOR_BG,
  })

  -- 8 つの扇形。hs.canvas の角度は 0° = 右(3 時方向)、時計回りなので -90° ずらす
  for i = 1, 8 do
    local mid = (i - 1) * 45 - 90
    cv:appendElements({
      id = "sec" .. i,
      type = "arc",
      center = { x = c, y = c },
      radius = R,
      startAngle = mid - 22.5,
      endAngle = mid + 22.5,
      arcRadii = true,
      action = "strokeAndFill",
      fillColor = slotHasKey(i) and COLOR_SECTOR or COLOR_SECTOR_EMPTY,
      strokeColor = COLOR_LINE,
      strokeWidth = 1,
    })
  end

  -- 中央(キャンセル)
  cv:appendElements({
    type = "circle",
    center = { x = c, y = c },
    radius = config.wheel.deadZone,
    action = "strokeAndFill",
    fillColor = { red = 0.05, green = 0.05, blue = 0.06, alpha = 0.9 },
    strokeColor = COLOR_LINE,
    strokeWidth = 1,
  })

  -- ラベル
  local labelR = config.wheel.deadZone + (R - config.wheel.deadZone) * 0.58
  local w = math.max(72, R * 0.9)
  for i = 1, 8 do
    local a = math.rad((i - 1) * 45)
    local px = c + math.sin(a) * labelR
    local py = c - math.cos(a) * labelR
    local s = config.slots[i]
    local text = slotHasKey(i) and (s.label ~= "" and s.label or s.key) or ""
    cv:appendElements({
      id = "lbl" .. i,
      type = "text",
      text = text,
      frame = { x = px - w / 2, y = py - 10, w = w, h = 20 },
      textSize = 12,
      textColor = slotHasKey(i) and COLOR_TEXT or COLOR_TEXT_DIM,
      textAlignment = "center",
    })
  end

  return cv
end

-- 扇形はキャンバスの 2〜9 番目の要素(1 番目は背景円)
local function sectorElementIndex(i) return i + 1 end

local function highlight(i)
  if wheel.selected == i then return end
  if wheel.selected then
    wheel.canvas[sectorElementIndex(wheel.selected)].fillColor =
      slotHasKey(wheel.selected) and COLOR_SECTOR or COLOR_SECTOR_EMPTY
  end
  if i then
    wheel.canvas[sectorElementIndex(i)].fillColor = slotHasKey(i) and COLOR_SECTOR_HI or COLOR_SECTOR_EMPTY
  end
  wheel.selected = i
end

local function hideWheel()
  if wheel.moveTap then wheel.moveTap:stop(); wheel.moveTap = nil end
  if wheel.clickTap then wheel.clickTap:stop(); wheel.clickTap = nil end
  if wheel.keyTap then wheel.keyTap:stop(); wheel.keyTap = nil end
  if wheel.canvas then wheel.canvas:delete(0.08); wheel.canvas = nil end
  wheel.selected = nil
  wheel.center = nil
end

local function fireSlot(i)
  local s = config.slots[i]
  if not s or s.key == "" then return end
  -- 修飾キーが物理的に離れてから送る(連打直後は ⌘ が残っていることがある)
  hs.timer.doAfter(0.03, function()
    local ok, err = pcall(hs.eventtap.keyStroke, s.mods or {}, s.key, 0)
    if not ok then
      hs.alert.show("ワンポチくん: キー送信に失敗 (" .. tostring(s.key) .. ")")
      print("onepochi_wheel keyStroke error: " .. tostring(err))
    end
  end)
end

function M.showWheel()
  if wheel.canvas then hideWheel() end
  local pos = hs.mouse.absolutePosition()
  wheel.center = { x = pos.x, y = pos.y }
  wheel.canvas = buildCanvas()
  wheel.canvas:show(0.06)

  local t = hs.eventtap.event.types
  wheel.moveTap = hs.eventtap.new({ t.mouseMoved, t.leftMouseDragged }, function(e)
    local p = e:location()
    highlight(sectorFromPoint(p.x, p.y))
    return false
  end):start()

  -- クリックで発動。ホイール表示中のクリックは Premiere に渡さない
  wheel.clickTap = hs.eventtap.new({ t.leftMouseDown, t.leftMouseUp, t.rightMouseDown, t.rightMouseUp }, function(e)
    local et = e:getType()
    if et == t.leftMouseUp or et == t.rightMouseUp then return true end
    local p = e:location()
    local sel = sectorFromPoint(p.x, p.y)
    hideWheel()
    if et == t.leftMouseDown and sel then fireSlot(sel) end
    return true
  end):start()

  -- Esc でキャンセル。その他のキーはそのまま Premiere へ
  wheel.keyTap = hs.eventtap.new({ t.keyDown }, function(e)
    if e:getKeyCode() == hs.keycodes.map.escape then
      hideWheel()
      return true
    end
    return false
  end):start()
end

-- ---------- 連打検知 ----------
local tap = {
  modDown = false,
  dirty = false, -- 押している間に他のキーを押した
  count = 0,
  lastUp = 0,
}

local function otherFlagsPressed(flags, modName)
  for k, v in pairs(flags) do
    if v and k ~= modName then return true end
  end
  return false
end

local flagsTap = hs.eventtap.new({ hs.eventtap.event.types.flagsChanged }, function(e)
  if not config.enabled then return false end
  local modName = config.trigger.modifier
  local flags = e:getFlags()
  local isDown = flags[modName] == true
  local now = hs.timer.secondsSinceEpoch()

  if isDown and not tap.modDown then
    tap.modDown = true
    tap.dirty = otherFlagsPressed(flags, modName)
    if now - tap.lastUp > config.trigger.interval then tap.count = 0 end
  elseif (not isDown) and tap.modDown then
    tap.modDown = false
    if tap.dirty or otherFlagsPressed(flags, modName) then
      tap.count = 0
      tap.lastUp = 0
      return false
    end
    tap.count = tap.count + 1
    tap.lastUp = now
    if tap.count >= (config.trigger.taps or 2) then
      tap.count = 0
      tap.lastUp = 0
      if wheel.canvas then
        hideWheel() -- もう一度連打でキャンセル
      elseif premiereIsFront() then
        M.showWheel()
      end
    end
  end
  return false
end)

-- 修飾キーを押している間に別のキーを押したら(⌘K など)連打とみなさない
local keyTapGlobal = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
  if tap.modDown then tap.dirty = true end
  tap.count = 0
  return false
end)

-- ---------- パネルとの WebSocket ----------
local server = nil

local function sendToPanel(tbl)
  if server then
    local ok = pcall(function() server:send(hs.json.encode(tbl)) end)
    if not ok then print("onepochi_wheel: send failed") end
  end
end

local function handleMessage(raw)
  local ok, msg = pcall(hs.json.decode, raw)
  if not ok or type(msg) ~= "table" then return hs.json.encode({ type = "error", text = "bad json" }) end

  if msg.type == "hello" then
    -- パネル起動時: Hammerspoon 側の設定を正とし、パネルに返す
    return hs.json.encode({ type = "config", config = config })
  elseif msg.type == "getConfig" then
    return hs.json.encode({ type = "config", config = config })
  elseif msg.type == "config" then
    config = normalize(msg.config)
    saveConfig()
    hs.alert.show("ワンポチくん: 設定を反映しました", 1)
    return hs.json.encode({ type = "log", text = "Hammerspoon に保存しました (" .. CONFIG_PATH .. ")" })
  elseif msg.type == "setEnabled" then
    config.enabled = (msg.enabled == true)
    saveConfig()
    if not config.enabled and wheel.canvas then hideWheel() end
    hs.alert.show("ワンポチくん: " .. (config.enabled and "ON" or "OFF"), 0.8)
    return hs.json.encode({ type = "status", enabled = config.enabled })
  elseif msg.type == "ping" then
    return hs.json.encode({ type = "status", enabled = config.enabled })
  end
  return hs.json.encode({ type = "error", text = "unknown type" })
end

local function startServer()
  server = hs.httpserver.new(false, false)
  server:setInterface("localhost")
  server:setPort(PORT)
  server:setCallback(function(method, path, headers, body)
    return "onepochi-wheel " .. (config.enabled and "on" or "off"), 200, { ["Content-Type"] = "text/plain" }
  end)
  server:websocket("/ws", handleMessage)
  server:start()
end

-- ---------- 公開 API ----------
function M.setEnabled(v)
  config.enabled = v and true or false
  saveConfig()
  if not config.enabled then hideWheel() end
  sendToPanel({ type = "status", enabled = config.enabled })
end

function M.toggle()
  M.setEnabled(not config.enabled)
  hs.alert.show("ワンポチくん: " .. (config.enabled and "ON" or "OFF"), 0.8)
end

function M.reload()
  loadConfig()
  sendToPanel({ type = "config", config = config })
end

function M.start()
  loadConfig()
  startServer()
  flagsTap:start()
  keyTapGlobal:start()
  print(string.format("onepochi_wheel: started (port %d, %s)", PORT, config.enabled and "on" or "off"))
end

function M.stop()
  hideWheel()
  flagsTap:stop()
  keyTapGlobal:stop()
  if server then server:stop(); server = nil end
end

M.start()
return M
