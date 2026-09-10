# ワンポチくん - ホイール -

FPS ゲームの「チャットホイール」のように、**修飾キー(既定: ⌘)を素早く 2 回押す → マウスの真上に 8 方向ホイールが出る → マウスを振って方向を選ぶ → クリックで、その方向に登録したショートカットキーを Premiere Pro に送る** ツールです。

```
⌘ ⌘ (素早く 2 回)
   │
   ▼
┌───────────────┐   マウスを振る      クリック
│  ↖   ↑   ↗   │  ───────────▶  方向ハイライト ───▶  登録した
│  ←   ◎   →   │                                     ショートカット
│  ↙   ↓   ↘   │   中央クリック / Esc / もう一度 ⌘⌘ = キャンセル   を送信
└───────────────┘
```

## 構成(なぜ 2 つに分かれているか)

| 部品 | 場所 | 役割 |
| --- | --- | --- |
| **Premiere Pro UXP パネル** | `plugin/` | 設定画面。8 方向の割り当て(表示名・ショートカットキーの記録)、呼び出し方法、ON/OFF |
| **Hammerspoon スクリプト** | `hammerspoon/onepochi_wheel.lua` | ⌘ 連打の検知、マウス位置へのホイール描画、方向判定、キー送信 |

2 つは `ws://127.0.0.1:47811/ws` の WebSocket でつながり、パネルで「保存」すると Hammerspoon 側の `~/.hammerspoon/onepochi_wheel.json` に書き込まれます。

分けている理由は Premiere 側の制約です(2026 年 9 月時点):

- Premiere Pro 2026 は旧方式の CEP 拡張を読み込まず、プラグインは UXP 一択。
- UXP プラグインには Premiere のキーボードショートカットを割り当てられない(Adobe スタッフが 2026 年 4 月に「予定なし」と回答)。パネル外のキー入力やマウス位置も取れない。
- Premiere の API からメニューコマンドを実行する手段はない。

そのため「OS 全体のキーとマウスを見る」部分を Hammerspoon(macOS の無料自動化ツール)が担当し、Premiere 側は設定 UI に徹しています。**ホイール本体は Hammerspoon だけでも動きます**(パネルは設定を楽にするためのものです)。

## セットアップ(macOS)

### 1. Hammerspoon

1. [Hammerspoon](https://www.hammerspoon.org/) をインストールして起動し、アクセシビリティ権限を許可する。
2. `hammerspoon/onepochi_wheel.lua` を `~/.hammerspoon/` にコピーする。
3. `~/.hammerspoon/init.lua` に次の行を追加する(無ければ作る)。

   ```lua
   require("onepochi_wheel")
   ```

4. メニューバーの Hammerspoon アイコンから **Reload Config**。

この時点で、Premiere Pro が最前面のときに ⌘ を素早く 2 回押すとホイールが出ます(初期割り当て入り)。

任意: ON/OFF を Hammerspoon 側のホットキーでも切り替えたい場合は `init.lua` に追加します。

```lua
local wheel = require("onepochi_wheel")
hs.hotkey.bind({ "ctrl", "alt" }, "w", wheel.toggle)
```

### 2. Premiere Pro パネル(設定画面)

1. [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/) を入れる(Creative Cloud アプリの「アプリ」→「ベータ版」等から)。
2. UDT で **Add Plugin** → `plugin/manifest.json` を選ぶ → **Load**。
3. Premiere Pro の「ウィンドウ」→「UXP プラグイン」→「ワンポチくん - ホイール -」を開く。

Hammerspoon が動いていれば、パネル右上が「Hammerspoon 接続中」になります。

## 使い方

- **ホイールを有効にする**: ON/OFF。OFF のときは ⌘ 連打に反応しません(即時反映)。
- **呼び出し方法**: 連打するキー(⌘ / ⌥ / ⌃ / ⇧ / fn)、回数(2 or 3)、判定間隔(秒)。
- **8 方向の割り当て**: 3×3 のマスで方向を選び、表示名とショートカットキーを登録。
  - 「記録」を押してからキーを押すと自動で入ります。
  - ⌘K のように Premiere が先に消費するキーは記録できないことがあるので、その場合は修飾キーのチェックとキー名(`k` など)を手入力してください。
- **保存して Hammerspoon に反映**: 設定を送信し、`~/.hammerspoon/onepochi_wheel.json` に保存します。

### 初期割り当て(Premiere Pro macOS 既定のショートカット)

| 方向 | 名前 | 送るキー |
| --- | --- | --- |
| ↑ | 編集点を追加 | ⌘K |
| ↗ | マーカーを追加 | M |
| → | 次の編集点へ | ↓ |
| ↘ | リップル削除 | ⇧ + forward delete |
| ↓ | 保存 | ⌘S |
| ↙ | 取り消し | ⌘Z |
| ← | 前の編集点へ | ↑ |
| ↖ | 再生 / 停止 | Space |

Premiere 側でショートカットを変えている場合は、パネルで合わせて登録してください。

## 設定ファイルの形式

`~/.hammerspoon/onepochi_wheel.json`(パネルからでも手編集でも可。手編集後は Hammerspoon の Reload Config)。

```json
{
  "version": 1,
  "enabled": true,
  "trigger": { "modifier": "cmd", "taps": 2, "interval": 0.35 },
  "wheel": { "radius": 120, "deadZone": 30 },
  "slots": [
    { "label": "編集点を追加", "mods": ["cmd"], "key": "k" },
    ...
  ]
}
```

`slots` は上から時計回りに 8 つ(N, NE, E, SE, S, SW, W, NW)。`mods` は `cmd` / `shift` / `alt` / `ctrl` / `fn`、`key` は Hammerspoon の `hs.keycodes.map` の名前(`a`〜`z`, `0`〜`9`, `f1`〜, `return`, `space`, `delete`, `forwarddelete`, `left` など)。

## 既知の制約・注意

- **macOS 専用**です。Windows では Hammerspoon の代わりに AutoHotkey で同じ役割(⌘→Ctrl などの連打検知、オーバーレイ描画、WebSocket サーバー)を書けば、パネルはそのまま使えます。
- ⌘ を押している間に別のキーを押した場合(⌘C など)は連打と見なしません。
- ホイールが出ている間のクリックは Premiere に渡しません(誤操作防止)。
- ホイールを出せるのは Premiere Pro が最前面のときだけです。
- パネルの「記録」は、Premiere が先に取るキーの組み合わせだと反応しないことがあります(手入力で対応)。
- UXP パネルが WebSocket を使うため、`manifest.json` の `network` 権限は `all` にしています。接続先はコード内で `127.0.0.1` 固定です。

## ファイル

```
premiere-chat-wheel/
├── README.md
├── plugin/                 # Premiere Pro UXP パネル
│   ├── manifest.json
│   ├── index.html
│   ├── index.js
│   └── styles.css
└── hammerspoon/
    └── onepochi_wheel.lua  # 連打検知・ホイール描画・キー送信・WebSocket サーバー
```
