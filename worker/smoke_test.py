"""
ワーカー単体の動作確認(Vercel を設定する前に使う)

    WORKER_URL=https://xxx--illust-gen-web.modal.run WORKER_TOKEN=... python3 worker/smoke_test.py
    # 編集も試す場合: 画像を 1〜2 枚渡す
    ... python3 worker/smoke_test.py --edit base.jpg ref.png --prompt "Replace the head ..."

初回は GPU の起動とモデル取得で数分かかります。結果は smoke_*.png に保存されます。
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.request

URL = os.environ.get("WORKER_URL", "").rstrip("/")
TOKEN = os.environ.get("WORKER_TOKEN", "")


def call(path, body=None):
    req = urllib.request.Request(
        URL + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def wait(job_id, label):
    t0 = time.time()
    while True:
        j = call(f"/jobs/{job_id}")
        if j["status"] == "done":
            return j["result"]
        if j["status"] == "failed":
            sys.exit(f"{label} failed: {j.get('error')}")
        print(f"  {label}: running {int(time.time() - t0)}s", flush=True)
        time.sleep(3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", default="flat vector illustration of a video editor working on a laptop, pastel colors")
    ap.add_argument("--edit", nargs="+", metavar="IMAGE", help="編集モード: 画像1(体側) [画像2(顔参照)]")
    args = ap.parse_args()
    if not URL or not TOKEN:
        sys.exit("WORKER_URL と WORKER_TOKEN を環境変数で指定してください")

    print("health:", call("/health"))

    if args.edit:
        images = []
        for p in args.edit:
            with open(p, "rb") as f:
                images.append(base64.b64encode(f.read()).decode())
        job = call("/edit", {"prompt": args.prompt, "images": images})
        result = wait(job["job_id"], "edit")
        out = f"smoke_edit_{result['seed']}.png"
    else:
        job = call("/generate", {"prompt": args.prompt, "width": 1024, "height": 1024})
        result = wait(job["job_id"], "generate")
        out = f"smoke_generate_{result['seed']}.png"

    with open(out, "wb") as f:
        f.write(base64.b64decode(result["image_base64"]))
    print(f"saved {out}  ({result['width']}x{result['height']}, {result['steps']} steps, {result['elapsed_sec']}s, {result['model']})")


if __name__ == "__main__":
    main()
