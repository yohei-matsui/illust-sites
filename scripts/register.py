#!/usr/bin/env python3
"""祭りの手動登録(10秒ルート): 火元ポストのURLを渡すと、配信エンドポイントで
本文・投稿者・エンゲージ数を取得し、反応カードの雛形を data/topics/ に作る。
引用欄のコピペは data/topics/<id>.quotes.txt に貼れば、そのまま資料として同梱される。

使い方: python3 scripts/register.py <ポストURL>
"""
import json, re, sys, urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOPICS = ROOT / "data" / "topics"

def main():
    url = sys.argv[1]
    m = re.search(r"status/(\d+)", url)
    if not m:
        sys.exit("ポストURLからIDを抽出できません")
    tid = m.group(1)
    req = urllib.request.Request(
        f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&lang=ja&token=x",
        headers={"User-Agent": "Mozilla/5.0"})
    j = json.loads(urllib.request.urlopen(req, timeout=20).read())
    u = j.get("user", {})
    date = (j.get("created_at") or "")[:10]
    card = {
        "id": f"{date}-{u.get('screen_name','unknown')}-{tid[-6:]}",
        "source_post": {
            "url": f"https://x.com/{u.get('screen_name','i')}/status/{tid}",
            "author": f"{u.get('name')} (@{u.get('screen_name')})",
            "author_type": "要確認: 事業者/実名クリエイターか(私人なら扱わない)",
            "posted_at": date,
            "text": j.get("text"),
            "metrics": {"likes": j.get("favorite_count"), "replies": j.get("conversation_count")},
            "fetched_via": f"cdn.syndication.twimg.com ({datetime.now().strftime('%Y-%m-%d')})"},
        "situation": "TODO: 何が起きているか1文で",
        "reactions": [],
        "quotes_paste_file": f"data/topics/{date}-{u.get('screen_name')}-{tid[-6:]}.quotes.txt",
        "note": "引用欄をコピペして quotes_paste_file に保存 → Claudeに『反応カード化して』と依頼",
        "verified": False}
    TOPICS.mkdir(parents=True, exist_ok=True)
    out = TOPICS / f"{card['id']}.json"
    out.write_text(json.dumps(card, ensure_ascii=False, indent=2))
    print(f"登録: {out}")
    print(f"火元: {card['source_post']['author']} いいね{card['source_post']['metrics']['likes']}")
    print(f"次: 引用欄({url.rstrip('/')}/quotes)をコピーして {card['quotes_paste_file']} に貼るか、チャットに直接貼る")

if __name__ == "__main__":
    main()
