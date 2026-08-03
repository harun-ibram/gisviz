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
    # pandas is imported by splatfacto-w's phototourism dataparser but is not a
    # nerfstudio dependency, and plugin discovery has no try/except — a missing
    # import there takes down every `ns-train` invocation, not just that method.
    .pip_install("nerfstudio", "pandas", "boto3", "requests")
    # Splatfacto-W (appearance embeddings for photos shot under varying light /
    # with transient occluders). Not on PyPI, and the checkout has to stay: its
    # PLY exporter lives at the repo root, outside the installed package.
    .run_commands(
        "git clone --depth 1 https://github.com/KevinXu02/splatfacto-w.git /opt/splatfacto-w",
        "pip install --no-deps -e /opt/splatfacto-w",
        # An unregistered method is not a hard error in ns-train — tyro just
        # reports every following flag as "unrecognized", which reads like a
        # syntax problem. Catch it at image build instead.
        'python -c "from nerfstudio.plugins.registry import discover_methods;'
        " m = discover_methods()[0];"
        ' assert \'splatfacto-w-light\' in m, sorted(m)"',
    )
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


# ---------------------------------------------------------------------------
# Georeferencing (Phase 4b)
#
# A COLMAP reconstruction has arbitrary scale, position and orientation, which
# is why the viewer has to hand-place every splat. If the photos carry EXIF GPS,
# COLMAP can solve the 7-DOF similarity itself: `model_aligner` fits the sparse
# model's camera centres to the GPS fixes and writes out an ENU model — metres,
# gravity-aligned, north-oriented.
#
# Everything here is best-effort. Photos without GPS are the normal case for
# screenshots and edited images, and a job must never fail because of it.
# ---------------------------------------------------------------------------

# COLMAP's own floor for a similarity fit. Three is a minimum, not a target —
# scale accuracy comes from averaging over many cameras.
MIN_GPS_IMAGES = 3

# RANSAC inlier threshold, in metres. Phone GPS is 3-10 m horizontally and worse
# in urban canyons, so a tight threshold would reject nearly every fix.
GPS_RANSAC_MAX_ERROR_M = 5.0


def _dms_to_degrees(dms) -> float:
    """EXIF stores coordinates as a (degrees, minutes, seconds) rational triple."""
    degrees, minutes, seconds = (float(part) for part in dms)
    return degrees + minutes / 60.0 + seconds / 3600.0


def _exif_gps(path: str):
    """``(lat, lon, alt)`` in degrees/metres, or None when the photo has no fix."""
    from PIL import Image
    from PIL.ExifTags import GPSTAGS, IFD

    try:
        with Image.open(path) as img:
            gps = img.getexif().get_ifd(IFD.GPSInfo)
    except Exception:  # unreadable, or simply not an image with EXIF
        return None
    if not gps:
        return None

    tags = {GPSTAGS.get(key, key): value for key, value in gps.items()}
    latitude, longitude = tags.get("GPSLatitude"), tags.get("GPSLongitude")
    if not latitude or not longitude:
        return None

    # EXIF in the wild is malformed often enough that one odd tag must not take
    # down a whole job: a photo we cannot read is simply a photo without a fix.
    try:
        lat = _dms_to_degrees(latitude)
        if str(tags.get("GPSLatitudeRef", "N")).upper().startswith("S"):
            lat = -lat
        lon = _dms_to_degrees(longitude)
        if str(tags.get("GPSLongitudeRef", "E")).upper().startswith("W"):
            lon = -lon

        # GPSAltitudeRef 1 means "below sea level". It is an EXIF BYTE, so
        # Pillow hands it back as b'\x00'/b'\x01' rather than an int — int() on
        # those bytes raises, which is why this is unpacked explicitly.
        altitude_ref = tags.get("GPSAltitudeRef") or 0
        if isinstance(altitude_ref, (bytes, bytearray)):
            altitude_ref = altitude_ref[0] if altitude_ref else 0

        # Note this is ellipsoidal height, not orthometric — see the README
        # before trusting it against a LiDAR DEM.
        altitude = float(tags.get("GPSAltitude") or 0.0)
        if int(altitude_ref) == 1:
            altitude = -altitude
    except (TypeError, ValueError, ZeroDivisionError):
        return None

    return lat, lon, altitude


def _write_gps_reference(images_dir: str, processed_dir: str, dest: str) -> tuple[int, int]:
    """
    Write COLMAP's ``ref_images.txt`` (``name lat lon alt``) for every photo that
    has a fix. Returns (photos with GPS, photos total).

    Read from the *originals*, not the processed copies: ns-process-data
    re-encodes into processed/images and that can drop EXIF entirely. The catch
    is that it also renames them (frame_00001.*), and COLMAP knows the new names
    — so pair the two directories by sorted order, which is the order
    nerfstudio itself enumerates them in. If the counts disagree we cannot
    associate them safely, so we give up rather than emit wrong coordinates.
    """
    originals = sorted(
        name for name in os.listdir(images_dir)
        if os.path.isfile(os.path.join(images_dir, name))
    )
    processed_images = os.path.join(processed_dir, "images")
    if not os.path.isdir(processed_images):
        return 0, len(originals)

    renamed = sorted(
        name for name in os.listdir(processed_images)
        if os.path.isfile(os.path.join(processed_images, name))
    )
    if len(renamed) != len(originals):
        print(
            f"[gps] {len(originals)} source photos but {len(renamed)} processed — "
            "cannot map names onto the COLMAP model, skipping alignment"
        )
        return 0, len(originals)

    located = 0
    with open(dest, "w") as handle:
        for original, colmap_name in zip(originals, renamed):
            fix = _exif_gps(os.path.join(images_dir, original))
            if fix is None:
                continue
            located += 1
            handle.write(f"{colmap_name} {fix[0]:.9f} {fix[1]:.9f} {fix[2]:.3f}\n")

    return located, len(originals)


def _georeference(work: str, images_dir: str, processed_dir: str) -> dict:
    """
    Align the COLMAP model to ENU metres from EXIF GPS, then regenerate
    transforms.json from the aligned model so training happens in that frame.

    Returns a summary for the webhook. Never raises: on any problem the caller
    carries on with the unaligned (arbitrary-scale) pipeline.
    """
    summary = {"georeferenced": False, "gps_photos": 0, "total_photos": 0}

    sparse_dir = os.path.join(processed_dir, "colmap", "sparse", "0")
    if not os.path.isdir(sparse_dir):
        summary["reason"] = "no COLMAP sparse model to align"
        return summary

    ref_path = os.path.join(work, "ref_images.txt")
    located, total = _write_gps_reference(images_dir, processed_dir, ref_path)
    summary["gps_photos"] = located
    summary["total_photos"] = total

    if located < MIN_GPS_IMAGES:
        summary["reason"] = f"only {located}/{total} photos carry EXIF GPS"
        print(f"[gps] {summary['reason']} — leaving the splat unaligned")
        return summary

    aligned_dir = os.path.join(processed_dir, "colmap", "sparse", "aligned")
    os.makedirs(aligned_dir, exist_ok=True)
    transform_path = os.path.join(work, "sim3.txt")

    try:
        subprocess.run(
            ["colmap", "model_aligner",
             "--input_path", sparse_dir,
             "--output_path", aligned_dir,
             "--ref_images_path", ref_path,
             "--ref_is_gps", "1",
             # ENU = the local East-North-Up metric frame: 1 unit = 1 m, +Z up,
             # +Y north. Exactly the frame the building mesh is built in.
             "--alignment_type", "enu",
             "--estimate_scale", "1",
             "--robust_alignment", "1",
             "--robust_alignment_max_error", str(GPS_RANSAC_MAX_ERROR_M),
             "--min_common_images", str(MIN_GPS_IMAGES),
             "--transform_path", transform_path],
            check=True,
        )
        # Regenerating transforms.json is the step that actually matters: without
        # it the aligned model sits on disk unused and training still runs in
        # COLMAP's arbitrary frame. --skip-colmap reuses the aligned model
        # instead of re-running SfM; --skip-image-processing avoids re-encoding
        # every photo a second time.
        subprocess.run(
            ["ns-process-data", "images", "--data", images_dir,
             "--output-dir", processed_dir,
             "--skip-colmap", "--skip-image-processing",
             "--colmap-model-path", os.path.join("colmap", "sparse", "aligned")],
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        # A failed fit is a normal outcome with sloppy GPS — carry on unaligned.
        summary["reason"] = f"model_aligner failed: {exc}"
        print(f"[gps] {summary['reason']} — leaving the splat unaligned")
        return summary

    if os.path.exists(transform_path):
        with open(transform_path) as handle:
            summary["sim3"] = handle.read().strip()

    summary["georeferenced"] = True
    print(f"[gps] aligned to ENU from {located}/{total} photos with EXIF GPS")
    return summary


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
        # 1b) Georeference from EXIF GPS, if the photos carry any. Best-effort:
        # when it succeeds the splat is trained in ENU metres instead of
        # COLMAP's arbitrary frame, so the viewer needs no hand-placement.
        georeference = _georeference(work, images_dir, processed_dir)

        # 2) Train the Gaussian splat. Headless flag so it exits when done.
        # `splatfacto-w-light`, not `splatfacto-w`: the full method's dataparser
        # is hard-wired to the NeRF-W phototourism captures — it reads
        # <data>/dense/sparse/*.bin and a train/test split .tsv whose name is a
        # Literal of "brandenburg|trevi|sacre". The light variant is the same
        # appearance model on nerfstudio's normal dataparser, so it consumes
        # ns-process-data output as-is.
        subprocess.run(
            ["ns-train", "splatfacto-w-light", "--data", processed_dir,
             "--output-dir", train_dir,
             "--viewer.quit-on-train-completion", "True"],
            check=True,
        )
        # 3) Export to .ply. nerfstudio writes config.yml under a nested run dir.
        configs = glob.glob(os.path.join(train_dir, "**", "config.yml"), recursive=True)
        if not configs:
            raise RuntimeError("Training finished but no config.yml was produced")
        # Not `ns-export gaussian-splat`: it asserts isinstance(model,
        # SplatfactoModel) and SplatfactoWModel derives straight from Model.
        # The plugin's own exporter bakes one camera's appearance embedding into
        # per-gaussian SH; the background model is dropped since no PLY viewer
        # understands it.
        #
        # --camera_idx is not optional in practice. The model defaults
        # self.camera_idx = 0 in populate_modules, but export_script.py declares
        # `camera_idx: Optional[int] = None` and calls set_camera_idx()
        # unconditionally — so omitting the flag overwrites that 0 with None and
        # the shs_0 property dies on torch.tensor(None). 0 = bake in the first
        # training photo's lighting; any valid training index works.
        subprocess.run(
            ["python", "/opt/splatfacto-w/export_script.py",
             "--load_config", configs[0], "--output_dir", export_dir,
             "--camera_idx", "0"],
            check=True,
        )
        plys = glob.glob(os.path.join(export_dir, "**", "*.ply"), recursive=True)
        if not plys:
            raise RuntimeError("Export finished but no .ply was produced")

        # 4) Upload the splat to R2 and tell the backend to set model_path.
        # The georeference summary rides along so the UI can say "N of M photos
        # had GPS" rather than silently serving an unscaled model, and so the
        # Sim3 is persisted next to the splat it belongs to.
        client.upload_file(plys[0], os.environ["R2_BUCKET_NAME"], output_key)
        _post_webhook(webhook_url, {
            "status": "done",
            "output_key": output_key,
            **georeference,
        })
    except Exception as exc:  # always fire a webhook so the job never hangs
        _post_webhook(webhook_url, {"status": "failed", "error": str(exc)})
        raise
