#!/usr/bin/env bash
# 初回セットアップ: Modal ログイン → Secret 作成 → デプロイ → URL 表示
# 使い方:  bash worker/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v modal >/dev/null 2>&1; then
  echo "▶ modal CLI をインストールします"
  python3 -m pip install -q modal
fi

if ! modal profile current >/dev/null 2>&1; then
  echo "▶ ブラウザが開くので Modal にログインしてください"
  modal token new
fi

if ! modal secret list 2>/dev/null | grep -q "illust-gen"; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  echo "▶ Secret illust-gen を作成します"
  modal secret create illust-gen WORKER_TOKEN="$TOKEN"
  echo
  echo "================================================================"
  echo " WORKER_TOKEN(Vercel の環境変数にも同じ値を設定してください)"
  echo " $TOKEN"
  echo "================================================================"
  echo
else
  echo "▶ Secret illust-gen は作成済みです(WORKER_TOKEN は Modal のダッシュボード → Secrets で確認できます)"
fi

echo "▶ デプロイします(初回はイメージのビルドで数分かかります)"
modal deploy worker/modal_app.py

echo
echo "デプロイ完了。上に表示された https://...--illust-gen-web.modal.run が WORKER_URL です。"
echo "ワーカー単体の動作確認:  WORKER_URL=<URL> WORKER_TOKEN=<token> python3 worker/smoke_test.py"
