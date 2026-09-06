"""
画像生成ワーカー(Modal 上で動く GPU サーバー)
====================================================
オープンウェイトモデルを自前でホストします。モデレーションは一切かかりません。
ルール判定は Vercel 側(policy/policy.js)で行い、ここには通過したプロンプトだけが届きます。

デプロイ:
    pip install modal
    modal token new
    modal secret create illust-gen WORKER_TOKEN=<長いランダム文字列> [HF_TOKEN=hf_...] [MODEL_ID=...]
    modal deploy worker/modal_app.py

デプロイ後に表示される https://<workspace>--illust-gen-web.modal.run を
Vercel の WORKER_URL に、WORKER_TOKEN を同じ値で設定してください。

画像編集(参照画像あり)は EDIT_MODEL_ID(既定 Qwen/Qwen-Image-Edit-2509、Apache-2.0)で
別コンテナ(H100)が動きます。テキスト生成と編集はそれぞれ独立してゼロスケールします。

モデル切り替え(MODEL_ID を Secret に入れるだけ):
    black-forest-labs/FLUX.1-schnell  (既定。Apache-2.0、4ステップで高速、HF_TOKEN 不要)
    black-forest-labs/FLUX.1-dev      (高品質。非商用ライセンス。HF でライセンス同意 + HF_TOKEN 必要)
    diffusers 形式で配布されている他のモデルも同様に指定できます。
"""

import base64
import io
import os
import time

import modal

APP_NAME = "illust-gen"
CACHE_DIR = "/cache"
DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell"
DEFAULT_EDIT_MODEL = "Qwen/Qwen-Image-Edit-2509"
GPU = os.environ.get("MODAL_GPU", "L40S")  # A100-40GB でも可。FLUX 系は bf16 で約 24GB 使います
EDIT_GPU = os.environ.get("MODAL_EDIT_GPU", "H100")  # Qwen-Image-Edit は bf16 で約 60GB 使うため 80GB クラスが必要
MAX_IMAGE_BYTES = 6 * 1024 * 1024

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch>=2.6.0",
        "diffusers>=0.36.0",
        "transformers>=4.51.0",
        "accelerate>=1.2.0",
        "sentencepiece",
        "protobuf",
        "pillow",
        "huggingface_hub[hf_transfer]",
        "fastapi[standard]>=0.115.0",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "HF_HUB_CACHE": CACHE_DIR})
)

volume = modal.Volume.from_name(f"{APP_NAME}-hf-cache", create_if_missing=True)
secret = modal.Secret.from_name(APP_NAME)


def model_defaults(model_id: str) -> dict:
    """モデルごとの既定ステップ数と guidance"""
    if "schnell" in model_id.lower() or "turbo" in model_id.lower():
        return {"steps": 4, "guidance": 0.0}
    return {"steps": 28, "guidance": 3.5}


@app.cls(
    gpu=GPU,
    image=image,
    volumes={CACHE_DIR: volume},
    secrets=[secret],
    timeout=600,
    scaledown_window=180,  # 最後の生成から 3 分でコンテナ停止(課金停止)
)
class Generator:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import DiffusionPipeline

        self.model_id = os.environ.get("MODEL_ID", DEFAULT_MODEL)
        t0 = time.time()
        self.pipe = DiffusionPipeline.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
            token=os.environ.get("HF_TOKEN") or None,
        ).to("cuda")
        volume.commit()  # 初回ダウンロード分をキャッシュに保存
        print(f"loaded {self.model_id} in {time.time() - t0:.1f}s")

    @modal.method()
    def generate(
        self,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        steps: int | None = None,
        seed: int | None = None,
        guidance: float | None = None,
    ) -> dict:
        import torch

        defaults = model_defaults(self.model_id)
        steps = int(steps or defaults["steps"])
        guidance = defaults["guidance"] if guidance is None else float(guidance)
        if seed is None:
            seed = int.from_bytes(os.urandom(4), "big")
        generator = torch.Generator(device="cuda").manual_seed(int(seed))

        t0 = time.time()
        result = self.pipe(
            prompt=prompt,
            width=int(width),
            height=int(height),
            num_inference_steps=steps,
            guidance_scale=guidance,
            generator=generator,
        )
        img = result.images[0]
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return {
            "image_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
            "mime": "image/png",
            "seed": int(seed),
            "steps": steps,
            "guidance": guidance,
            "width": img.width,
            "height": img.height,
            "model": self.model_id,
            "elapsed_sec": round(time.time() - t0, 2),
        }


def decode_image(data: str):
    """data URL または生の base64 を PIL.Image(RGB)に変換"""
    from PIL import Image

    if "," in data and data.strip().startswith("data:"):
        data = data.split(",", 1)[1]
    raw = base64.b64decode(data, validate=False)
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image too large")
    img = Image.open(io.BytesIO(raw))
    img.load()
    return img.convert("RGB")


def fit_dimensions(width: int, height: int, area: int = 1024 * 1024, multiple: int = 16) -> tuple[int, int]:
    """縦横比を保ったまま指定面積に収め、multiple の倍数に丸める"""
    ratio = width / height
    w = (area * ratio) ** 0.5
    h = w / ratio
    return max(multiple, round(w / multiple) * multiple), max(multiple, round(h / multiple) * multiple)


@app.cls(
    gpu=EDIT_GPU,
    image=image,
    volumes={CACHE_DIR: volume},
    secrets=[secret],
    timeout=900,
    scaledown_window=180,
)
class Editor:
    """参照画像つき編集(Qwen-Image-Edit-2509 等)"""

    @modal.enter()
    def load(self):
        import torch
        from diffusers import DiffusionPipeline

        self.model_id = os.environ.get("EDIT_MODEL_ID", DEFAULT_EDIT_MODEL)
        t0 = time.time()
        self.pipe = DiffusionPipeline.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
            token=os.environ.get("HF_TOKEN") or None,
        ).to("cuda")
        volume.commit()
        print(f"loaded {self.model_id} in {time.time() - t0:.1f}s")

    @modal.method()
    def edit(
        self,
        prompt: str,
        images: list[str],
        negative_prompt: str = " ",
        steps: int = 40,
        cfg: float = 4.0,
        seed: int | None = None,
    ) -> dict:
        import torch

        pil_images = [decode_image(d) for d in images]
        # 出力サイズは 1 枚目(体・構図を保ちたい側)の縦横比から決める
        width, height = fit_dimensions(*pil_images[0].size)
        if seed is None:
            seed = int.from_bytes(os.urandom(4), "big")
        generator = torch.Generator(device="cuda").manual_seed(int(seed))

        t0 = time.time()
        result = self.pipe(
            image=pil_images,
            prompt=prompt,
            negative_prompt=negative_prompt or " ",
            true_cfg_scale=float(cfg),
            num_inference_steps=int(steps),
            width=width,
            height=height,
            generator=generator,
        )
        img = result.images[0]
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return {
            "image_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
            "mime": "image/png",
            "seed": int(seed),
            "steps": int(steps),
            "guidance": float(cfg),
            "width": img.width,
            "height": img.height,
            "model": self.model_id,
            "elapsed_sec": round(time.time() - t0, 2),
        }


@app.function(image=image, secrets=[secret])
@modal.asgi_app()
def web():
    from fastapi import Depends, FastAPI, Header, HTTPException
    from pydantic import BaseModel, Field

    api = FastAPI(title="illust-gen worker")
    expected = os.environ.get("WORKER_TOKEN", "")

    def auth(authorization: str = Header(default="")):
        if not expected or authorization != f"Bearer {expected}":
            raise HTTPException(status_code=401, detail="unauthorized")

    class GenerateIn(BaseModel):
        prompt: str = Field(min_length=1, max_length=4000)
        width: int = Field(default=1024, ge=256, le=2048)
        height: int = Field(default=1024, ge=256, le=2048)
        steps: int | None = Field(default=None, ge=1, le=100)
        seed: int | None = Field(default=None, ge=0)
        guidance: float | None = Field(default=None, ge=0, le=30)

    @api.get("/health")
    def health():
        return {
            "ok": True,
            "model": os.environ.get("MODEL_ID", DEFAULT_MODEL),
            "gpu": GPU,
            "edit_model": os.environ.get("EDIT_MODEL_ID", DEFAULT_EDIT_MODEL),
            "edit_gpu": EDIT_GPU,
        }

    @api.post("/generate", dependencies=[Depends(auth)])
    def generate(body: GenerateIn):
        # 非同期で起動してジョブIDを返す(コールドスタート中でもHTTPがタイムアウトしない)
        call = Generator().generate.spawn(**body.model_dump())
        return {"job_id": call.object_id}

    class EditIn(BaseModel):
        prompt: str = Field(min_length=1, max_length=4000)
        images: list[str] = Field(min_length=1, max_length=3)  # base64 / data URL
        negative_prompt: str = Field(default=" ", max_length=2000)
        steps: int = Field(default=40, ge=1, le=100)
        cfg: float = Field(default=4.0, ge=1.0, le=10.0)
        seed: int | None = Field(default=None, ge=0)

    @api.post("/edit", dependencies=[Depends(auth)])
    def edit(body: EditIn):
        for d in body.images:
            if len(d) > MAX_IMAGE_BYTES * 4 // 3 + 64:
                raise HTTPException(status_code=413, detail="image too large")
        call = Editor().edit.spawn(**body.model_dump())
        return {"job_id": call.object_id}

    @api.get("/jobs/{job_id}", dependencies=[Depends(auth)])
    def job(job_id: str):
        try:
            call = modal.FunctionCall.from_id(job_id)
        except Exception:
            raise HTTPException(status_code=404, detail="job not found")
        try:
            result = call.get(timeout=0)
        except TimeoutError:
            return {"status": "running"}
        except modal.exception.OutputExpiredError:
            raise HTTPException(status_code=410, detail="job result expired")
        except Exception as e:  # 生成側の例外
            return {"status": "failed", "error": str(e)[:500]}
        return {"status": "done", "result": result}

    return api
