"""Modal GPU worker: photos in R2 -> COLMAP + Gaussian splatting -> .ply back to R2.

Deployed separately from the Railway backend with:

    modal deploy gpu/splat_app.py

The FastAPI backend triggers a run with
``modal.Function.from_name("gisviz-splat", "process").spawn(...)`` (see
src/main.py:start_job). This worker never touches the database: it only reads
photos from R2, writes the result to R2, and POSTs a secret-signed webhook back
to the backend, which is what actually sets ``model_path``.

Secrets (create in the Modal dashboard):
  - ``gisviz-r2``      -> R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
  - ``gisviz-webhook`` -> JOB_WEBHOOK_SECRET
"""

import glob
import os
import subprocess
import tempfile

import modal

app = modal.App("gisviz-splat")

# COLMAP + nerfstudio (bundles the `splatfacto` Gaussian-splatting trainer and
# wraps COLMAP via `ns-process-data images`). This image build is the main
# technical risk — iterate with `modal run gpu/splat_app.py` before deploying.
# Fallback if nerfstudio's CUDA deps won't build cleanly: drop nerfstudio and
# call COLMAP's CLI directly (feature_extractor -> exhaustive_matcher -> mapper)
# plus graphdeco-inria/gaussian-splatting's train.py with its
# diff-gaussian-rasterization / simple-knn submodules.
image = (
    modal.Image.from_registry(
        "nvidia/cuda:11.8.0-devel-ubuntu22.04", add_python="3.10"
    )
    .apt_install("colmap", "git", "wget", "ffmpeg", "build-essential", "cmake")
    # Must come *before* pip_install: image steps are ordered, and some
    # nerfstudio deps (fpsample, pyliblzfse) have no cp310 wheels and compile
    # from source. The `add_python` interpreter reports clang as its compiler,
    # which isn't in this image, so point setuptools/CMake at gcc instead.
    .env({"QT_QPA_PLATFORM": "offscreen", "CC": "gcc", "CXX": "g++"})
    .pip_install("torch==2.1.2", "torchvision==0.16.2", index_url="https://download.pytorch.org/whl/cu118")
    .pip_install("nerfstudio", "boto3", "requests")
)


def _r2_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def _download_prefix(client, prefix: str, dest: str) -> int:
    """Download every object under ``prefix`` into ``dest``. Returns the count."""
    bucket = os.environ["R2_BUCKET_NAME"]
    n = 0
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            name = key[len(prefix):].lstrip("/")
            if not name:  # skip the "folder" marker
                continue
            client.download_file(bucket, key, os.path.join(dest, name))
            n += 1
    return n


def _post_webhook(webhook_url: str, payload: dict) -> None:
    import requests

    requests.post(
        webhook_url,
        json=payload,
        headers={"X-Webhook-Secret": os.environ["JOB_WEBHOOK_SECRET"]},
        timeout=30,
    )


@app.function(
    gpu="A10G",  # 24 GB; drop to "T4" for small scenes, bump to "A100" if OOM/timeout
    timeout=1800,
    secrets=[
        modal.Secret.from_name("custom-secret"),
        modal.Secret.from_name("gisviz-webhook"),
    ],
    image=image,
)
def process(job_id: str, input_prefix: str, output_key: str, webhook_url: str) -> None:
    client = _r2_client()
    try:
        work = tempfile.mkdtemp(prefix=f"job-{job_id}-")
        images_dir = os.path.join(work, "images")
        processed_dir = os.path.join(work, "processed")
        train_dir = os.path.join(work, "outputs")
        export_dir = os.path.join(work, "export")
        os.makedirs(images_dir, exist_ok=True)

        count = _download_prefix(client, input_prefix, images_dir)
        if count == 0:
            raise RuntimeError(f"No photos found under {input_prefix}")

        # 1) COLMAP (structure-from-motion) -> transforms.json + sparse cloud.
        subprocess.run(
            ["ns-process-data", "images", "--data", images_dir,
             "--output-dir", processed_dir],
            check=True,
        )
        # 2) Train the Gaussian splat. Headless flag so it exits when done.
        subprocess.run(
            ["ns-train", "splatfacto", "--data", processed_dir,
             "--output-dir", train_dir,
             "--viewer.quit-on-train-completion", "True"],
            check=True,
        )
        # 3) Export to .ply. nerfstudio writes config.yml under a nested run dir.
        configs = glob.glob(os.path.join(train_dir, "**", "config.yml"), recursive=True)
        if not configs:
            raise RuntimeError("Training finished but no config.yml was produced")
        subprocess.run(
            ["ns-export", "gaussian-splat", "--load-config", configs[0],
             "--output-dir", export_dir],
            check=True,
        )
        plys = glob.glob(os.path.join(export_dir, "**", "*.ply"), recursive=True)
        if not plys:
            raise RuntimeError("Export finished but no .ply was produced")

        # 4) Upload the splat to R2 and tell the backend to set model_path.
        client.upload_file(plys[0], os.environ["R2_BUCKET_NAME"], output_key)
        _post_webhook(webhook_url, {"status": "done", "output_key": output_key})
    except Exception as exc:  # always fire a webhook so the job never hangs
        _post_webhook(webhook_url, {"status": "failed", "error": str(exc)})
        raise
