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
    # NOTE: deliberately *not* `apt_install("colmap")`. The distro package is
    # built without CUDA, and COLMAP only falls back to SiftGPU-over-OpenGL in
    # that case — which aborts in a headless container. We build it ourselves
    # below instead. The list here is COLMAP 3.8's build deps (minus Qt/CGAL,
    # which GUI_ENABLED=OFF / CGAL_ENABLED=OFF make unnecessary).
    .apt_install(
        "git", "wget", "ffmpeg", "build-essential", "cmake", "ninja-build",
        "libboost-program-options-dev", "libboost-filesystem-dev",
        "libboost-graph-dev", "libboost-system-dev", "libboost-test-dev",
        "libeigen3-dev", "libflann-dev", "libfreeimage-dev", "liblz4-dev",
        "libmetis-dev", "libgoogle-glog-dev", "libgtest-dev", "libsqlite3-dev",
        "libceres-dev", "libsuitesparse-dev", "libglew-dev", "libgl1-mesa-dev",
    )
    # Must come *before* pip_install: image steps are ordered, and some
    # nerfstudio deps (fpsample, pyliblzfse) have no cp310 wheels and compile
    # from source. The `add_python` interpreter reports clang as its compiler,
    # which isn't in this image, so point setuptools/CMake at gcc instead.
    .env({"QT_QPA_PLATFORM": "offscreen", "CC": "gcc", "CXX": "g++"})
    # Build COLMAP with CUDA so feature extraction/matching run on the GPU.
    # With -DCUDA_ENABLED=ON, SiftGPU is compiled against CUDA and the
    # OpenGLContextManager that crashes headless is #ifdef'd out entirely
    # (src/feature/extraction.cc: `#ifndef CUDA_ENABLED`).
    #
    # Pinned to 3.8: it's the newest tag that builds against the Ceres 2.0 in
    # Ubuntu 22.04. COLMAP >=3.9 uses the Ceres 2.1 Manifold API and needs
    # Ceres built from source too.
    #
    # Architectures are listed explicitly because build machines have no GPU,
    # so `native` can't work: 75=T4, 80=A100, 86=A10G — keep in sync with the
    # `gpu=` choices on the function below.
    .run_commands(
        "git clone --branch 3.8 --depth 1 https://github.com/colmap/colmap.git /tmp/colmap",
        # 3.8 bug in exactly our configuration (CUDA on, GUI off): sift.cc guards
        # its GL header with `#if !defined(GUI_ENABLED) && !defined(CUDA_ENABLED)`
        # yet still passes GL_LUMINANCE/GL_UNSIGNED_BYTE to SiftGPU::RunSIFT, so
        # the enums are undeclared. Include glew.h unconditionally (header-only
        # here — they're macros, so this adds no link dependency).
        '''sed -i '/^#include "flann\\/flann.hpp"$/a #include <GL/glew.h>' /tmp/colmap/src/feature/sift.cc'''
        " && grep -q '#include <GL/glew.h>' /tmp/colmap/src/feature/sift.cc",
        "cmake -S /tmp/colmap -B /tmp/colmap/build -GNinja"
        " -DCMAKE_BUILD_TYPE=Release"
        " -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc"
        " -DCMAKE_CUDA_ARCHITECTURES='75;80;86'"
        " -DCUDA_ENABLED=ON"
        " -DGUI_ENABLED=OFF"
        " -DCGAL_ENABLED=OFF"
        " -DTESTS_ENABLED=OFF"
        " -DIPO_ENABLED=OFF",  # LTO across 3 CUDA archs roughly doubles build time
        "ninja -C /tmp/colmap/build install",
        # CUDA_ENABLED is best-effort in COLMAP's CMake: if it can't find CUDA
        # it silently produces the same OpenGL-dependent binary that fails at
        # runtime. Fail the *image build* instead of a user's job.
        "ldd /usr/local/bin/colmap | grep -q libcudart"
        " || (echo 'COLMAP built without CUDA — check nvcc detection' && exit 1)",
        "rm -rf /tmp/colmap",
    )
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
    # 24 GB; drop to "T4" for small scenes, bump to "A100" if OOM/timeout. If you
    # add a card outside sm_75/80/86, add its arch to CMAKE_CUDA_ARCHITECTURES.
    gpu="A10G",
    timeout=3600,  # splatfacto's 30k iters dominate; SfM is minutes on the GPU
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
        # Runs SIFT on the GPU (nerfstudio's default), which only works because
        # the image builds COLMAP with CUDA — see the image definition above.
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
