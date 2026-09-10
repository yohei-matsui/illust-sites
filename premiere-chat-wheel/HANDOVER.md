# 引き継ぎ書: ワンポチくん - ホイール - を「ポチッとショートカット」に統合する

作成日: 2026-09-10
作成セッション: 「Prプラグイン- ホイール -」(illust-sites ブランチ `claude/zealous-babbage-pivj2f`)
宛先: 「ポチッとショートカット」をフォークしてホイールを組み込む次のセッション

---

## 1. ゴール(決定事項)

FPS のチャットホイールのように、**8 方向のホイールから「登録したショートカットキー」を 1 つ選んで Premiere Pro に送る**機能を、
既存の CEP 拡張「デモver ワンポチくん-ポチッとショートカット-」に **6 枚目のボード(ホイールボード)として追加する**。

- 名称: **ワンポチくん - ホイール -**
- 送るのは「登録したショートカットキー」。Premiere の API 操作(マーカー追加など)は使わない。
- 呼び出し方は 2 段階:
  - **標準(プラグイン単体)**: ホイールボードをフローティングで置き、扇形をクリックして発動。
  - **オプション(Hammerspoon 併用)**: 修飾キー(既定 ⌘)を素早く 2 回押す → マウスの真上にホイール → 振って → クリック。
- 設定(8 方向の割り当て、ON/OFF)は既存の設定パネル側に統合し、二重管理しない。

ユーザーはこの方針を承認済み(2026-09-10)。

---

## 2. なぜこの構成か(調査で分かったこと)

### 2-1. Premiere 拡張の制約(2026-09 時点)
| 論点 | 結論 | 根拠 |
| --- | --- | --- |
| UXP プラグインに Premiere からショートカットを割り当てる | **不可**。Adobe スタッフが 2026-04 に「予定なし」と回答 | [Creative Cloud Developer Forums](https://forums.creativeclouddeveloper.com/t/uxp-possible-keyboard-shortcuts-to-uxp-plugin-command-entry-points/11847) |
| UXP からキー入力を Premiere に送る | **不可**(Node が無い) | UXP マニフェスト仕様 |
| Premiere API からメニューコマンドを実行 | **不可**(`app.executeCommand` 相当は無い) | ppro-scripting.docsforadobe.dev |
| パネルの外で押されたキー(⌘⌘)を検知 | CEP / UXP とも**不可** | CEP は `registerKeyEventsInterest` でパネルにフォーカスがある時だけ |
| パネルをマウス位置に出す | CEP / UXP とも**不可** | パネル位置は API で操作できない |
| CEP が Premiere 2026 で動くか | **動く**(ポチッとショートカット自体が CEP 製で稼働中、Host `[22.0,99.9]`) | ユーザー環境の実績。※ GitHub の一部 issue には「2026 で CEP が読み込まれない」報告があるが、ユーザー環境では読み込まれている。Adobe は CEP をいずれ廃止と明言しているので時期は要注視 |

### 2-2. ポチッとショートカットが解いていること(そのまま流用する)
- **キー送信**: CEP を `--enable-nodejs` で動かし、Node の `child_process.spawn("osascript")` で System Events にキーを送る。
  → `client/src/lib/premiere.ts` の `sendKeySequence(steps, cb)`
- **フォーカス問題**: CEP パネルをクリックすると OS のフォーカスが Premiere 本体から外れ、単一キーが届かない。
  対策として AppleScript 1 回の中で「①タイムライン(T)に割り当てた **Cmd 入り**ショートカット → ②本命キー」を連続送信する。
  Cmd 入りは keyEquivalent として扱われフォーカス無関係に届き、①でタイムラインがフォーカスを取り戻した直後に②が通る。
  → `client/src/BoardPanel.tsx` の `triggerPanel()`
- **ショートカットの自動取得**: Premiere の `.kys` を直接パース。アクティブなプリセットは Prefs の `<FE.Prefs.Shortcuts.Filename>` で特定。
  → `premiere.ts` の `findActiveKysFile()` / `parseKYS()` / `loadKYSMap()` / `findShortcutForCommand()`
- **データ**: `PanelConfig { id, label, icon, shortcut?: "cmd+shift+k" 形式, extensionId?, color? }` を
  拡張ルート直下 `data/board-N.json` に保存。500ms ポーリング(`watchPanels`)で他パネルの変更を反映。
  → `client/src/shared.ts`
- **初回セットアップ条件**: アクセシビリティ許可 + 「タイムライン(T)」に Cmd 入りショートカットを割り当ててプリセット保存。
  未設定なら設定パネル上部に案内バナー(`App.tsx` の SetupState)。

### 2-3. 今回のセッションで作った試作(参考実装)
illust-sites リポジトリ `premiere-chat-wheel/` に、UXP パネル + Hammerspoon の 2 部構成で試作済み。
CEP 統合後はこの試作の **UXP パネル(`plugin/`)は不要**になる。**Hammerspoon スクリプト(`hammerspoon/onepochi_wheel.lua`)はオプション経路として流用**する。

| ファイル | 中身 | 統合後の扱い |
| --- | --- | --- |
| `plugin/index.html` / `index.js` / `styles.css` / `manifest.json` | UXP 版設定パネル(3×3 マスで方向選択、キー記録、ON/OFF、WebSocket で Hammerspoon と同期) | 廃止。UI の考え方(3×3 マス、記録ボタン)だけ設定パネルに移植 |
| `hammerspoon/onepochi_wheel.lua` | ⌘ 連打検知、`hs.canvas` でマウス位置に 8 扇形描画、方向判定、`hs.eventtap.keyStroke` で送信、`hs.httpserver` の WebSocket サーバー(port 47811) | オプション経路として流用。設定の受け渡しは WebSocket ではなく **`data/board-wheel.json` を直接読む**方式に変える(§4-5) |
| `README.md` | UXP + Hammerspoon 構成の説明 | CEP 版に書き直す |
| プレビュー(Artifact) | https://claude.ai/code/artifact/b5aea56e-1fd9-4510-b9c9-744a31911af8 | ホイールの見た目(半径 120px、無効範囲 30px、配色、ラベル位置)の基準として参照 |

ホイールの幾何・配色(Lua と プレビューで共通):
- 8 方向は **上から時計回り** `N, NE, E, SE, S, SW, W, NW`(index 0〜7)。
- 方向判定: 中心からの角度 `atan2(dx, -dy)`(0°=上、時計回り)、`floor(((deg + 22.5) % 360) / 45)`。中心から `deadZone` 以内はキャンセル。
- 半径 120px、無効範囲 30px、ラベル半径 `deadZone + (R - deadZone) * 0.58`。
- 色: 背景 `rgba(20,20,23,.72)`、扇形 `rgba(51,51,56,.85)`、選択中 `rgba(51,128,242,.95)`、未登録 `rgba(38,38,41,.6)`、線 `rgba(255,255,255,.18)`。
- 初期割り当て(Premiere macOS 既定): ↑ 編集点を追加 ⌘K / ↗ マーカー M / → 次の編集点 ↓ / ↘ リップル削除 ⇧+forwarddelete / ↓ 保存 ⌘S / ↙ 取り消し ⌘Z / ← 前の編集点 ↑ / ↖ 再生停止 Space。
  ※ 統合後は既存の `.kys` 自動取得に合わせ、初期値はコマンド名(`uif.*`)ベースにするのが望ましい(§5 未決)。

---

## 3. フォーク元のソースについて

ユーザーから **`wanpochisourcebundle.txt`**(ソース一式を 1 ファイルに連結したもの、約 4,800 行)を受領済み。
先頭のヘッダーに構成・仕組み・復元手順が書かれている。要点:

```
<root>/panel-launcher/         CEP 拡張本体
  CSXS/manifest.xml            拡張 6 本(設定 panel + board1〜5)。Host PPRO [22.0,99.9]、CSXS 11
  host/index.jsx               ほぼ空(プローブのみ)。キー送信は ExtendScript を使わない
  client/                      Vite + React 18 + TypeScript
    index.html / settings.html / board1〜5.html   各パネルの入口(board は <script>window.BOARD_ID = N</script>)
    src/main.tsx               設定パネル起動
    src/boardMain.tsx          ボード起動。.kys の単一キーを registerKeyEventsInterest で横取り登録
    src/App.tsx                設定パネル UI(行テーブル、修飾キー切替、プリセット、セットアップ案内)
    src/BoardPanel.tsx         ボード UI。triggerPanel() がキー送信の本体
    src/shared.ts              PanelConfig、data/ 読み書き、watch、isValidShortcut
    src/lib/premiere.ts        .kys パース、osascript 送信、CSInterface ブリッジ
    src/index.css, *.module.css
    vite.config.ts             rollup input に main + board1〜5 を列挙。alias "cep-ui-kit" → ../../cep-ui-kit/src
  install.sh                   npm build → ~/Library/Application Support/Adobe/CEP/extensions/com.panel-launcher.plugin へ配置。data/ を退避・復元
  package.sh / installer/      配布用
<root>/cep-ui-kit/src/         テーマ、効果音、マスコット(PochiPump / PochiMascot)、ThemeSettings
```

バンドルに**含まれていないもの**: `client/package-lock.json`(npm install で再生成)、`client/public/CSInterface.js`(Adobe CEP-Resources から取得)、
画像・フォント・効果音のバイナリ(ホイール実装には不要。無くてもビルドが通るよう import を任意化するか、ダミーを置く)。

---

## 4. 実装計画(ホイールボード)

### 4-1. 拡張の追加
- `CSXS/manifest.xml`: `<Extension Id="com.panel-launcher.wheel" Version="1.0.0"/>` を追加。
  `DispatchInfo` は board1 と同じ(`--enable-nodejs`, `--mixed-context`)。`<Menu>ワンポチくん - ホイール -</Menu>`。
  サイズは正方形寄り(例: 320×340、MinSize 240×260)。`AutoVisible` は false(設定パネルから `requestOpenExtension` で開く)。
- `client/wheel.html`: board1.html をコピーし `window.BOARD_ID = "wheel"`(または 6)。デバッグ用の `__raw` 表示は外してよい。
- `vite.config.ts`: `rollupOptions.input.wheel` を追加。

### 4-2. データ
- `shared.ts` に `WheelSlot { dir: "N"|"NE"|…, label, icon?, shortcut? }` と
  `WheelConfig { enabled: boolean, slots: WheelSlot[8], radius?: number, deadZone?: number }` を追加。
  保存先 `data/board-wheel.json`。`loadWheel()/saveWheel()/watchWheel()` は `loadPanels` 系と同じ作り(500ms ポーリング)。
- `shortcut` の文字列形式は既存と同じ `"cmd+shift+k"`(修飾キーは `cmd/ctrl/opt/shift`、キーは `premiere.ts` の `KEY_CODES` にある名前)。
  → **Hammerspoon 側は `opt`→`alt` の読み替えが必要**(hs は `alt`)。`forwarddelete` は `KEY_CODES` に無いので追加する(macOS 仮想キーコード 117)。

### 4-3. ホイールボード UI(`client/src/WheelPanel.tsx`、入口 `wheelMain.tsx`)
- SVG(または canvas)で 8 扇形 + 中央円を描く。幾何・配色は §2-3。
- 発動は **mousedown** で判定し `e.preventDefault()`(既存 `handleMouseDown` と同じ理由: ボタンにフォーカスを移さない)。
- 発動処理は `BoardPanel.tsx` の `triggerPanel()` をそのまま使えるよう、**`triggerPanel` を `lib/trigger.ts` に切り出して両方から呼ぶ**。
  中身: `.kys` を再読込 → `findTimelineActivateKey()` → Cmd 入りタイムラインキーが無く本命も Cmd 無しなら案内 → `sendKeySequence([tlKey, real])`。
- ホバーで扇形ハイライト、発動時は既存の `flash()` 相当のフィードバックと `PochiPump` の running 表示を流用。
- `enabled: false` のときは扇形をグレーアウトしてクリック無効。
- キー横取り(`boardMain.tsx` の `registerKeyEventsInterest` 登録)はホイールでも同じ問題が起きるので、`wheelMain.tsx` でも同じ初期化を行う(共通関数化推奨)。

### 4-4. 設定パネル(`App.tsx`)
- 「ホイール」セクション(またはタブ)を追加。試作 UXP パネルの UI を移植:
  - ON/OFF トグル。
  - 3×3 マス(中央は「キャンセル」)で方向を選択 → 選択中の方向の「表示名」「ショートカット」を編集。
  - ショートカット編集は既存の行テーブルと同じ部品(修飾キーのトグル + キー入力欄)。
  - 「Hammerspoon 連携」欄: 呼び出しキー(cmd/opt/ctrl/shift/fn)、回数(2/3)、判定間隔(秒)、半径、無効範囲。これも `board-wheel.json` に保存。
- プリセット(`PANEL_PRESETS`)と同様に、コマンド名から `.kys` で自動割り当てできる「ホイール初期プリセット」を用意すると親切。

### 4-5. Hammerspoon(オプション経路)
- `hammerspoon/onepochi_wheel.lua` を CEP リポジトリ側に移し、**設定ファイルを `data/board-wheel.json` に変更**する。
  パス: `~/Library/Application Support/Adobe/CEP/extensions/com.panel-launcher.plugin/data/board-wheel.json`。
  Lua 側で `opt`→`alt` 変換、`shortcut` 文字列の分解(`"cmd+k"` → mods + key)を追加。
- WebSocket サーバー・`hello/config/setEnabled` プロトコルは不要になるので削除(またはそのまま残しても害はない)。
- ファイル変更検知は `hs.pathwatcher.new(dir, fn)` で `data/` を監視すれば即時反映できる。
- Hammerspoon 経路では Premiere が実フォーカスを持っているので、**タイムライン Cmd キーの前置きは不要**。`sendKeySequence` 相当は `hs.eventtap.keyStroke(mods, key)` 1 回。
- 導入手順(README に転記): Hammerspoon をインストール → アクセシビリティ許可 → `~/.hammerspoon/onepochi_wheel.lua` にコピー → `init.lua` に `require("onepochi_wheel")` → Reload Config。

### 4-6. install.sh / 配布
- `data/` の退避・復元は既存のまま(`board-wheel.json` も同じフォルダなので自動的に守られる)。
- Hammerspoon スクリプトは拡張フォルダにコピーしても Premiere は使わないので、`installer/` の案内に「任意」として同梱。

---

## 5. 未決事項(フォーク後に決める)
1. ホイールボードの `BOARD_ID` を文字列 `"wheel"` にするか数値 `6` にするか(`loadPanels(boardId: number)` の型に影響)。
2. 初期割り当てを「キー固定」にするか「コマンド名 → `.kys` 自動取得」にするか(既存プリセットと同じ後者を推奨)。
3. 扇形ラベルにアイコン(絵文字)を出すか、文字だけにするか。
4. Hammerspoon 経路の ON/OFF を設定パネルの ON/OFF と共通にするか、別にするか(共通推奨)。
5. Windows 対応(AutoHotkey 版の Hammerspoon 相当)。現状 macOS 専用で進める。

---

## 6. 注意点(既知の落とし穴)
- **CEP の ExtendScript グローバルは全拡張で共有**される。ホスト側に関数を足すなら接頭辞必須(`host/.prefix-map.json`)。ホイールはホスト側不要。
- **`.kys` はプリセットを保存しないと書き出されない**。「タイムライン(T)」の Cmd 入り割り当ても保存が必要。
- ダークモードで `backdrop-filter` を使わない(CEP の古い Chromium で滲む。`index.css` の `--glass-blur: none`)。
- `pbcopy` への stdin は Shift-JIS 化けするので、クリップボードは osascript の `set the clipboard to` を使う。
- `install.sh` は `data/` を退避・復元する。しないとボード設定が消える(実際に踏んだ、とのこと)。
- ホイール発動時のクリックはボードと同じく mousedown で `preventDefault` しないとフォーカスが奪われ、Cmd 無しキーが届かない。

---

## 7. 次セッションの最初の手順
1. ポチッとショートカットをフォーク(または `wanpochisourcebundle.txt` の復元手順どおりに展開)し、`bash panel-launcher/install.sh` でビルドが通ることを確認。
2. §4-1〜4-3 でホイールボードを追加し、既存ボードと同じ経路で ⌘K が飛ぶところまで確認。
3. §4-4 の設定 UI を追加。
4. §4-5 で Hammerspoon 経路を `data/board-wheel.json` 読み取りに切り替え、⌘⌘ → マウス位置 → クリックで同じキーが飛ぶことを確認。
5. README とインストーラー案内を更新。

参考: 試作コード(illust-sites `premiere-chat-wheel/`)の `hammerspoon/onepochi_wheel.lua` と `plugin/index.js` は、それぞれ Lua 側・設定 UI 側の実装をほぼそのまま移植できる。
