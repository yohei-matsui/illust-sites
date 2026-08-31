#!/usr/bin/env python3
"""ネタ探知スクリプト(型1: 賛否まとめ用)

Togetter / Posfie を巡回し、映像制作・動画編集界隈で話題になっている
まとめを検出。各まとめから火元・反応ポストのIDを抜き、X配信エンドポイント
(ログイン不要)で本文・エンゲージ数を取得して、反応カードの下書きと
人間向けダイジェストを data/topics/inbox/ に出力する。

使い方: python3 scripts/scout.py [--days 30] [--max 5]
依存: 標準ライブラリのみ
"""
import json, re, sys, time, urllib.request, urllib.parse
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INBOX = ROOT / "data" / "topics" / "inbox"
SEEN = ROOT / "data" / "topics" / "seen.json"

KEYWORDS = ["動画編集", "映像制作", "編集者 単価", "Premiere", "After Effects",
            "DaVinci Resolve", "テロップ", "動画クリエイター", "AI 動画"]
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

# タイトルに最低1つ含まれること(関連度フィルタ)
RELEVANT = ["動画編集", "映像制作", "編集者", "テロップ", "Premiere", "プレミア",
            "After Effects", "AfterEffects", "DaVinci", "ダビンチ", "カラグレ",
            "動画クリエイター", "映像クリエイター", "編集ソフト", "編集アプリ",
            "字幕", "サムネ", "撮影", "納品", "案件"]
# 1つでも含まれたら除外(NGライン: 政治・事件・宗教はネタにしない)
NG = ["総理", "首相", "大臣", "選挙", "政党", "政権", "原爆", "戦争", "戦時",
      "事件", "逮捕", "容疑", "死亡", "遺族", "宗教", "デマ", "フェイク",
      "差別", "戦犯", "テロ"]

def relevant(title):
    return any(k in title for k in RELEVANT) and not any(k in title for k in NG)

def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="ignore")

def search_togetter(kw):
    """検索結果から (url, title, date) を返す"""
    q = urllib.parse.quote(kw)
    out = []
    for page in (1, 2):
        try:
            h = fetch(f"https://togetter.com/search?q={q}&page={page}")
        except Exception:
            break
        # 各カードは <a href=.../li/ID>タイトル</a> ... datetime="YYYY-MM-DD"
        blocks = re.split(r'(?=<a[^>]+href="https://togetter\.com/li/)', h)
        for b in blocks:
            m = re.search(r'href="(https://togetter\.com/li/\d+)"[^>]*>(.*?)</a>', b, re.S)
            d = re.search(r'(\d{4}-\d{2}-\d{2})', b)
            if m and d:
                title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
                if len(title) > 10:
                    out.append((m.group(1), title, d.group(1)))
        time.sleep(1)
    return out

def extract_tweet_ids(mat_url):
    h = fetch(mat_url)
    ids = re.findall(r'(?:x|twitter)\.com/[A-Za-z0-9_]+/status/(\d+)', h)
    seen, ordered = set(), []
    for i in ids:
        if i not in seen:
            seen.add(i); ordered.append(i)
    return ordered

def fetch_tweet(tid):
    try:
        j = json.loads(fetch(
            f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&lang=ja&token=x"))
        u = j.get("user", {})
        return {"id": tid, "author": u.get("name"), "screen_name": u.get("screen_name"),
                "text": (j.get("text") or "")[:280], "likes": j.get("favorite_count"),
                "replies": j.get("conversation_count"),
                "date": (j.get("created_at") or "")[:10],
                "url": f"https://x.com/{u.get('screen_name','i')}/status/{tid}"}
    except Exception:
        return None

def main():
    days = int(sys.argv[sys.argv.index("--days")+1]) if "--days" in sys.argv else 30
    max_topics = int(sys.argv[sys.argv.index("--max")+1]) if "--max" in sys.argv else 5
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    seen = set(json.loads(SEEN.read_text())) if SEEN.exists() else set()

    cands = {}
    for kw in KEYWORDS:
        for url, title, date in search_togetter(kw):
            if date >= cutoff and url not in seen and url not in cands and relevant(title):
                cands[url] = {"url": url, "title": title, "date": date, "keyword": kw}
        time.sleep(1)

    ranked = sorted(cands.values(), key=lambda c: c["date"], reverse=True)[:max_topics]
    INBOX.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    lines = [f"# ネタ候補ダイジェスト {today}", "",
             f"(過去{days}日 / Togetter経由 / 新着{len(ranked)}件)", ""]

    for c in ranked:
        print(f"[scout] {c['date']} {c['title'][:50]}", file=sys.stderr)
        ids = extract_tweet_ids(c["url"])[:12]
        tweets = [t for t in (fetch_tweet(i) for i in ids) if t]
        time.sleep(1)
        fire = tweets[0] if tweets else None
        card = {"id": f"{c['date']}-{c['url'].rsplit('/',1)[-1]}",
                "detected_via": {"service": "togetter", "url": c["url"],
                                  "title": c["title"], "keyword": c["keyword"]},
                "source_post": fire,
                "reactions_raw": tweets[1:],
                "note": "reactions_raw は自動収集の生データ。投稿生成前に人間が確認し、"
                        "陣営ラベル付きの reactions に要約・匿名化すること",
                "verified": False}
        (INBOX / f"{card['id']}.json").write_text(
            json.dumps(card, ensure_ascii=False, indent=2))
        lines += [f"## {c['date']} {c['title']}",
                  f"- まとめ: {c['url']}  (検知キーワード: {c['keyword']})"]
        if fire:
            lines.append(f"- 火元: {fire['author']} (@{fire['screen_name']}) "
                         f"いいね{fire['likes']} リプ{fire['replies']}")
            lines.append(f"  > {fire['text'][:100]}")
        lines += [f"- 収集ポスト数: {len(tweets)}", ""]
        seen.add(c["url"])

    SEEN.parent.mkdir(parents=True, exist_ok=True)
    SEEN.write_text(json.dumps(sorted(seen), ensure_ascii=False, indent=1))
    digest = INBOX / f"{today}-digest.md"
    digest.write_text("\n".join(lines))
    print(f"[scout] {len(ranked)}件 -> {digest}", file=sys.stderr)

if __name__ == "__main__":
    main()
