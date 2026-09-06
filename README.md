# illust-sites

動画編集者向けイラストサイト20選(`index.html`)と、**自前ホストのオープンウェイトモデルによる AI 画像生成・編集ページ**(写真調・イラスト調どちらも)(`generate.html`)。

- テキストから生成: Z-Image-Turbo(Apache-2.0、6B、8 ステップ)
- 参照画像で編集(顔の入れ替え、人物の差し替えなど): Qwen-Image-Edit-2509(最大 3 枚の参照画像)

生成ルールは外部サービスの規約に縛られず、`policy/policy.js` で自分で決めます。

## 構成

```
ブラウザ (generate.html)
   │  /api/generate  … プロンプトをルール判定 → ワーカーへ非同期投入
   │  /api/edit      … 参照画像(ブラウザ側で長辺 1024px に縮小)+ 指示を投入
   │  /api/jobs/:id  … 生成状況をポーリング
   ▼
Vercel 関数 (api/, lib/, policy/)   ← ルール判定はここ。API キーはブラウザに出ない
   │  Bearer WORKER_TOKEN
   ▼
Modal GPU ワーカー (worker/modal_app.py)   ← diffusers で実行。モデレーションなし
   ├ Generator (L40S): Z-Image-Turbo           テキスト→画像
   └ Editor    (H100): Qwen-Image-Edit-2509   参照画像つき編集
```

- 生成が終わるまで HTTP を待たずジョブ ID で追う設計なので、GPU のコールドスタート(初回 1〜2 分)でもタイムアウトしません。
- GPU は生成が無いとき自動停止するため、使った分だけの課金です。目安は生成(L40S)が 1 枚数円、編集(H100、40 ステップ)が 1 枚 10〜20 円程度。
- 編集モデルは bf16 で約 60GB 使うため 80GB クラスの GPU が必要です。初回起動はモデル取得込みで数分かかります(2 回目以降はキャッシュから 1〜2 分)。

## セットアップ

### 1. Modal(GPU ワーカー)

[modal.com](https://modal.com) でアカウントを作ってから(GitHub ログイン可)、リポジトリ直下で:

```bash
bash worker/setup.sh
```

ログイン → Secret 作成 → デプロイまで進み、`WORKER_TOKEN` と `WORKER_URL` が表示されます。
手動でやる場合は `worker/setup.sh` の中身のとおりです。

Vercel を設定する前に、ワーカー単体で動作確認できます(初回は数分かかります):

```bash
WORKER_URL=https://...modal.run WORKER_TOKEN=... python3 worker/smoke_test.py
WORKER_URL=... WORKER_TOKEN=... python3 worker/smoke_test.py --edit base.jpg ref.png
```

### 2. Vercel

Project Settings → Environment Variables に `.env.example` の 3 つを設定して再デプロイ。
`SITE_ACCESS_KEY` を設定すると、生成ページでキー入力が必要になります(URL を知られても GPU 代を使われないように)。

### 3. 動作確認

`/generate.html` を開いてプロンプトを入れて「生成する」。初回は GPU 起動 + モデル読み込みで 1〜2 分、2 回目以降は数秒です。

## 参照画像で編集する(顔の入れ替えなど)

「参照画像で編集」タブで、画像1(体・構図を保つ側)と画像2(顔・人物の参照)を選び、英語の平易な指示を書きます。既定の指示は「1枚目の女性の顔と髪を2枚目の女性に変える。ポーズ・服・背景はそのまま。表情と目線は2枚目」です。

実機で試した結果(Qwen-Image-Edit-2509、同じ2枚の画像):

| 指示の書き方 | 結果 |
|---|---|
| 平易な英語で「顔と髪を2枚目の人物に変える。ポーズ・服・背景はそのまま」 | 成功。体・背景を保ったまま顔・髪・表情が置き換わった |
| 「Replace the head (from the neck up) of the woman in image 1 with ...」 | 失敗。画像1がほぼそのまま返ってきた |
| 画像順を逆(顔参照を1枚目、体側を2枚目)にして指示 | 失敗。体側の画像がそのまま返ってきた |

精度を上げるコツ:

- 「the first image / the second image」「face and hair」のような日常的な言い方を使う。「image 1」「head」「neck up」のような機械的な表現は無視されやすい。
- 保ちたい要素(pose, clothes, background)と変えたい要素(face, hair, expression, gaze)を具体名で書く。
- 画像順は必ず「体側が1枚目、顔参照が2枚目」。逆にすると通らない。
- 「絶対に」「一切」などの強調や否定形はモデルの挙動を変えない。
- 同一人物性は 1 回で決まらないことがあるので、シードを変えて数枚回し、当たりを選ぶ。
- CFG を 4 → 5〜6 に上げると指示に従いやすくなるが、破綻も増える。
- 体を 1 ピクセルも変えたくない場合は、マスク付きインペイント + 同一人物アダプタ(PuLID など)を組む必要がある(未実装)。

注意: 実在の人物の顔を別の体に合成する行為は、パブリシティ権・名誉毀損の問題があります。本人の同意がある素材か、生成人物同士で使ってください。

## 生成ルールを変える

`policy/policy.js` を編集してデプロイするだけです。

| セクション | 内容 |
|---|---|
| `legal` | 日本法上どのみち公開できないもの(未成年の性的描写)。削除しない |
| `custom` | 自分で決めるルール。既定は空(制限なし)。ファイル内のコメント例のように追加する |
| `limits` | 最大サイズ・ステップ数・プロンプト長、編集の既定値(`edit`) |
| `promptSuffix` | 全プロンプトに自動で付ける文字列(画風の統一など) |

判定はキーワード(部分一致、全角半角・大文字小文字を無視)と、`all` による組み合わせ判定です。
ルールをローカルで確認するには:

```bash
npm test
```

## モデルを変える

Modal の Secret `illust-gen` に `MODEL_ID`(生成)/ `EDIT_MODEL_ID`(編集)を追加して `modal deploy` し直すだけです。

| モデル | ライセンス | メモ |
|---|---|---|
| `Tongyi-MAI/Z-Image-Turbo`(生成の既定) | Apache-2.0 | 8 ステップで高速。HF トークン不要 |
| `black-forest-labs/FLUX.1-schnell` | Apache-2.0 | HF 上で gated 化されたため、ライセンス同意と `HF_TOKEN` が必要 |
| `black-forest-labs/FLUX.1-dev` | 非商用ライセンス | 品質が高い。販売しない用途なら可。HF でライセンス同意し `HF_TOKEN` も Secret に追加 |
| `Qwen/Qwen-Image-Edit-2509`(編集の既定) | Apache-2.0 | 複数参照画像に対応。H100 必要 |
| `black-forest-labs/FLUX.1-Kontext-dev` | 非商用ライセンス | 単一画像の編集向き。2 枚参照は苦手 |
| その他 diffusers 形式のモデル | 各モデルによる | `DiffusionPipeline` で読める形式なら同じ手順 |

大きいモデルに変える場合は `worker/modal_app.py` の `GPU`(既定 `L40S`、48GB)/ `EDIT_GPU`(既定 `H100`、80GB)も見直してください。

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
