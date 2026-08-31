#!/usr/bin/env python3
"""型2(速報↓時系列)用ニュース探知: 業界メディアのRSSを巡回し、
キーワードに合う新着記事を data/topics/inbox/ にダイジェスト出力する。
使い方: python3 scripts/news_scout.py [--days 7]
依存: 標準ライブラリのみ
"""
import json, re, sys, urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
INBOX = ROOT / "data" / "topics" / "inbox"
SEEN = ROOT / "data" / "topics" / "news_seen.json"

FEEDS = ["https://jp.pronews.com/feed", "https://cginterest.com/feed/"]
KEYWORDS = ["Premiere", "After Effects", "DaVinci", "Resolve", "Final Cut",
            "CapCut", "Adobe", "Blackmagic", "編集", "テロップ", "字幕",
            "生成AI", "AI", "YouTube", "収益", "料金", "価格", "サブスク"]
UA = {"User-Agent": "Mozilla/5.0"}

def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()

def main():
    days = int(sys.argv[sys.argv.index("--days")+1]) if "--days" in sys.argv else 7
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    seen = set(json.loads(SEEN.read_text())) if SEEN.exists() else set()
    hits = []
    for feed in FEEDS:
        try:
            root = ET.fromstring(fetch(feed))
        except Exception as e:
            print(f"[news] {feed} 失敗: {e}", file=sys.stderr); continue
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = item.findtext("pubDate") or ""
            try:
                dt = parsedate_to_datetime(pub)
            except Exception:
                continue
            if dt < cutoff or link in seen:
                continue
            if any(k.lower() in title.lower() for k in KEYWORDS):
                hits.append({"date": dt.strftime("%Y-%m-%d"), "title": title,
                             "url": link, "feed": feed})
                seen.add(link)
    hits.sort(key=lambda h: h["date"], reverse=True)
    INBOX.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    out = INBOX / f"{today}-news.md"
    lines = [f"# 業界ニュース候補 {today}(過去{days}日 / {len(hits)}件)", ""]
    for h in hits:
        lines.append(f"- {h['date']} [{h['title']}]({h['url']})")
    out.write_text("\n".join(lines))
    SEEN.write_text(json.dumps(sorted(seen), ensure_ascii=False, indent=1))
    print(f"[news] {len(hits)}件 -> {out}", file=sys.stderr)

if __name__ == "__main__":
    main()
