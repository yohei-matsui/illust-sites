# illust-sites

動画編集者向けイラストサイト20選(`index.html`)と、**自前ホストのオープンウェイトモデルによる AI イラスト生成ページ**(`generate.html`)。

生成ルールは外部サービスの規約に縛られず、`policy/policy.js` で自分で決めます。

## 構成

```
ブラウザ (generate.html)
   │  /api/generate  … プロンプトをルール判定 → ワーカーへ非同期投入
   │  /api/jobs/:id  … 生成状況をポーリング
   ▼
Vercel 関数 (api/, lib/, policy/)   ← ルール判定はここ。API キーはブラウザに出ない
   │  Bearer WORKER_TOKEN
   ▼
Modal GPU ワーカー (worker/modal_app.py)   ← FLUX.1-schnell 等を diffusers で実行。モデレーションなし
```

- 生成が終わるまで HTTP を待たずジョブ ID で追う設計なので、GPU のコールドスタート(初回 1〜2 分)でもタイムアウトしません。
- GPU は生成が無いとき自動停止するため、使った分だけの課金です(L40S でおおよそ 1 枚 数円)。

## セットアップ

### 1. Modal(GPU ワーカー)

```bash
pip install modal
modal token new                       # ブラウザでログイン
python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # WORKER_TOKEN を作る
modal secret create illust-gen WORKER_TOKEN=<上の値>
modal deploy worker/modal_app.py
```

デプロイ後に表示される `https://<workspace>--illust-gen-web.modal.run` が `WORKER_URL` です。
`curl https://.../health` で `{"ok": true, ...}` が返れば動いています。

### 2. Vercel

Project Settings → Environment Variables に `.env.example` の 3 つを設定して再デプロイ。
`SITE_ACCESS_KEY` を設定すると、生成ページでキー入力が必要になります(URL を知られても GPU 代を使われないように)。

### 3. 動作確認

`/generate.html` を開いてプロンプトを入れて「生成する」。初回は GPU 起動 + モデル読み込みで 1〜2 分、2 回目以降は数秒です。

## 生成ルールを変える

`policy/policy.js` を編集してデプロイするだけです。

| セクション | 内容 |
|---|---|
| `legal` | 日本法上どのみち公開できないもの(未成年の性的描写)。削除しない |
| `custom` | 自分で決めるルール。`enabled: false` で無効化、語を追加・削除、ルール自体を追加できる |
| `limits` | 最大サイズ・ステップ数・プロンプト長 |
| `promptSuffix` | 全プロンプトに自動で付ける文字列(画風の統一など) |

判定はキーワード(部分一致、全角半角・大文字小文字を無視)と、`all` による組み合わせ判定です。
ルールをローカルで確認するには:

```bash
npm test
```

## モデルを変える

Modal の Secret `illust-gen` に `MODEL_ID` を追加して `modal deploy` し直すだけです。

| モデル | ライセンス | メモ |
|---|---|---|
| `black-forest-labs/FLUX.1-schnell`(既定) | Apache-2.0 | 4 ステップで高速。HF トークン不要 |
| `black-forest-labs/FLUX.1-dev` | 非商用ライセンス | 品質が高い。販売しない用途なら可。HF でライセンス同意し `HF_TOKEN` も Secret に追加 |
| その他 diffusers 形式のモデル | 各モデルによる | `DiffusionPipeline` で読める形式なら同じ手順 |

大きいモデルに変える場合は `worker/modal_app.py` の `GPU`(既定 `L40S`、48GB)も見直してください。

## 自分でルールを決められる範囲

ワーカー側にモデレーションは無いので、次の 4 つの内側であれば自由です。

- **法律**: 児童ポルノ、名誉毀損、わいせつ物頒布(刑法175条)、著作権・パブリシティ権
- **モデルのライセンス**: 上の表を参照
- **ホスティングの規約**: Vercel / Modal / GitHub
- (販売する場合は決済事業者の規約。現状は非販売なので該当なし)

## ローカル開発

```bash
npm i -g vercel
vercel dev        # .env.local に WORKER_URL / WORKER_TOKEN を書いておく
```
