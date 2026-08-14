"""Modal GPU worker: photos in R2 -> GS2Mesh -> a splat .ply *and* a mesh .glb in R2.

Deployed separately from gpu/splat_app.py, gpu/sugar_app.py and the Railway
backend with:

    modal deploy gpu/gs2mesh_app.py

This is a third, self-contained alternative to the two-stage
splat_app -> sugar_app pipeline, not a replacement for it. Where that pipeline
trains with nerfstudio's splatfacto and then fits a Poisson surface to the
gaussians with SuGaR, GS2Mesh (https://github.com/yanivw12/gs2mesh) trains with
Inria's own 3DGS, renders *stereo pairs* of novel views around the trained
splat, runs the DLNR stereo network on each pair to get a metric-consistent
depth map per view, and fuses those depths with TSDF. One worker, one image, one
call, both artifacts.

Nothing in src/main.py references this app — it is not wired into the /jobs
endpoints or the Job model. Call it directly:

    modal.Function.from_name("gisviz-gs2mesh", "process").spawn(
        job_id, input_prefix, output_key, mesh_key, webhook_url
    )

Like the other two workers it never touches the database: it reads photos from
R2, writes both artifacts to R2, and POSTs a secret-signed webhook.

Secrets (shared with gpu/splat_app.py and gpu/sugar_app.py):
  - ``custom-secret``  -> R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
  - ``gisviz-webhook`` -> JOB_WEBHOOK_SECRET
"""

import glob
import os
import re
import shutil
import subprocess
import tempfile

import modal

app = modal.App("gisviz-gs2mesh")

GS2MESH_DIR = "/opt/gs2mesh"

# GS2Mesh gets its own interpreter rather than sharing the container's.
#
# Upstream documents Python 3.8 and means it: its vendored SAM2 carries a
# patched `python_requires=">=3.8.0"` where upstream SAM2 declares ">=3.10.0".
# But a Modal function *cannot* run on 3.8 — `Image.add_python` only accepts
# 3.10-3.14, and the modal client (which the container imports into the same
# interpreter as the decorated function) declares `Requires-Python >=3.10`.
#
# So the container is 3.10 for Modal's sake, GS2Mesh lives in a 3.8 venv, and
# the two meet over a subprocess boundary. That is also how upstream's own
# README drives it (`python run_single.py ...` inside a dedicated conda env), so
# nothing here is a workaround for the split — it is the documented entrypoint.
VENV = "/opt/gs2mesh-venv"
PY = f"{VENV}/bin/python"

# COLMAP arch list and the CUDA arch list for the compiled torch extensions:
# 75=T4, 80=A100, 86=A10G, 90=H100. Keep in sync with the `gpu=` choice on the
# function below — build machines have no GPU, so `native` cannot work.
CUDA_ARCHS_CMAKE = "75;80;86;90"
CUDA_ARCHS_TORCH = "7.5;8.0;8.6;9.0"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:11.8.0-devel-ubuntu22.04", add_python="3.10"
    )
    # COLMAP 3.8's build deps (minus Qt/CGAL, which GUI_ENABLED=OFF /
    # CGAL_ENABLED=OFF make unnecessary), plus ffmpeg for GS2Mesh's video-frame
    # extraction and libgl/libglib for Open3D, which the TSDF stage imports even
    # headless. software-properties-common is for add-apt-repository below.
    .apt_install(
        "git", "wget", "ffmpeg", "build-essential", "cmake", "ninja-build",
        "pkg-config", "software-properties-common",
        "libboost-program-options-dev", "libboost-filesystem-dev",
        "libboost-graph-dev", "libboost-system-dev", "libboost-test-dev",
        "libeigen3-dev", "libflann-dev", "libfreeimage-dev", "liblz4-dev",
        "libmetis-dev", "libgoogle-glog-dev", "libgtest-dev", "libsqlite3-dev",
        "libceres-dev", "libsuitesparse-dev", "libglew-dev", "libgl1-mesa-dev",
        "libgl1", "libglib2.0-0",
    )
    # Must come *before* any pip install: image steps are ordered, and several
    # deps below compile from source. The `add_python` interpreter reports clang
    # as its compiler, which isn't in this image, so point setuptools/CMake at
    # gcc. FORCE_CUDA/TORCH_CUDA_ARCH_LIST are for the torch CUDA extensions
    # (diff-gaussian-rasterization, simple-knn, SAM2, GroundingDINO), which
    # compile on a build machine with no GPU. GroundingDINO in particular gates
    # its CUDA extension on `torch.cuda.is_available() or "TORCH_CUDA_ARCH_LIST"
    # in os.environ` — without that variable it silently builds CPU-only.
    .env({
        "QT_QPA_PLATFORM": "offscreen",
        "CC": "gcc",
        "CXX": "g++",
        "FORCE_CUDA": "1",
        "TORCH_CUDA_ARCH_LIST": CUDA_ARCHS_TORCH,
    })
    # ---------------------------------------------------------------------
    # COLMAP, built from source with CUDA.
    #
    # Lifted from gpu/splat_app.py, which documents the reasoning at length.
    # The short version: `apt_install("colmap")` gives a build without CUDA,
    # COLMAP then falls back to SiftGPU-over-OpenGL, and that aborts in a
    # headless container. GS2Mesh walks straight into the same trap — its
    # gs2mesh_utils/colmap_utils.py:run_colmap shells out to
    # `colmap feature_extractor ... --SiftExtraction.use_gpu 1`.
    #
    # Pinned to 3.8: newest tag that builds against Ubuntu 22.04's Ceres 2.0.
    # ---------------------------------------------------------------------
    .run_commands(
        "git clone --branch 3.8 --depth 1 https://github.com/colmap/colmap.git /tmp/colmap",
        # 3.8 bug in exactly our configuration (CUDA on, GUI off): sift.cc
        # guards its GL header with `#if !defined(GUI_ENABLED) &&
        # !defined(CUDA_ENABLED)` yet still passes GL_LUMINANCE to
        # SiftGPU::RunSIFT, so the enums are undeclared. glew.h is header-only
        # here (they're macros), so this adds no link dependency.
        '''sed -i '/^#include "flann\\/flann.hpp"$/a #include <GL/glew.h>' /tmp/colmap/src/feature/sift.cc'''
        " && grep -q '#include <GL/glew.h>' /tmp/colmap/src/feature/sift.cc",
        "cmake -S /tmp/colmap -B /tmp/colmap/build -GNinja"
        " -DCMAKE_BUILD_TYPE=Release"
        " -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc"
        f" -DCMAKE_CUDA_ARCHITECTURES='{CUDA_ARCHS_CMAKE}'"
        " -DCUDA_ENABLED=ON"
        " -DGUI_ENABLED=OFF"
        " -DCGAL_ENABLED=OFF"
        " -DTESTS_ENABLED=OFF"
        " -DIPO_ENABLED=OFF",  # LTO across 4 CUDA archs roughly doubles build time
        "ninja -C /tmp/colmap/build install",
        # CUDA_ENABLED is best-effort in COLMAP's CMake: if it can't find CUDA
        # it silently produces the same OpenGL-dependent binary that fails at
        # runtime. Fail the *image build* instead of a user's job.
        "ldd /usr/local/bin/colmap | grep -q libcudart"
        " || (echo 'COLMAP built without CUDA — check nvcc detection' && exit 1)",
        "rm -rf /tmp/colmap",
    )
    # ---------------------------------------------------------------------
    # The Python 3.8 environment GS2Mesh actually runs in.
    # ---------------------------------------------------------------------
    .run_commands(
        # Ubuntu 22.04 ships 3.10 only; deadsnakes is where 3.8 comes from.
        "add-apt-repository -y ppa:deadsnakes/ppa",
        "apt-get update",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends"
        " python3.8 python3.8-dev python3.8-venv python3.8-distutils",
        "rm -rf /var/lib/apt/lists/*",
        f"python3.8 -m venv {VENV}",
        # setuptools is capped for the same load-bearing reason gpu/sugar_app.py
        # documents: setuptools >=81 drops pkg_resources, and torch's
        # cpp_extension.py opens with `from pkg_resources import packaging` —
        # upgrading it breaks the very extension builds it exists to enable.
        f"{PY} -m pip install --upgrade 'pip<25' 'setuptools<70' wheel",
    )
    # torch 2.3.1 / torchvision 0.18.1 is GS2Mesh's documented pin (its vendored
    # SAM2 requires >=2.3.1), on cu118 to match the base image. cp38 wheels
    # exist for this combination; they stop existing at torch 2.5.
    .run_commands(
        f"{PY} -m pip install torch==2.3.1 torchvision==0.18.1"
        " --index-url https://download.pytorch.org/whl/cu118",
    )
    # A plain clone, not --recursive: third_party/{DLNR,gaussian-splatting,
    # segment-anything-2,GroundingDINO} are vendored directories in GS2Mesh's
    # own tree (mode 040000), not git submodules, and several carry local
    # patches — the SAM2 copy has its python_requires relaxed to 3.8. A
    # recursive clone would be a no-op here; re-cloning them from upstream
    # would lose the patches.
    .run_commands(
        f"git clone --depth 1 https://github.com/yanivw12/gs2mesh.git {GS2MESH_DIR}",
    )
    # The four local packages GS2Mesh's requirements.txt lists as bare paths.
    # --no-build-isolation on every one is mandatory, not a preference: each
    # does `from torch.utils.cpp_extension import CUDAExtension` at the top of
    # setup.py, and a PEP 517 build runs in a fresh venv holding only
    # setuptools, so the torch installed above is invisible and the build dies
    # with "No module named 'torch'" before compiling anything.
    .run_commands(
        f"{PY} -m pip install --no-build-isolation"
        f" {GS2MESH_DIR}/third_party/gaussian-splatting/submodules/diff-gaussian-rasterization",
        f"{PY} -m pip install --no-build-isolation"
        f" {GS2MESH_DIR}/third_party/gaussian-splatting/submodules/simple-knn",
        f"{PY} -m pip install --no-build-isolation {GS2MESH_DIR}/third_party/segment-anything-2",
        f"{PY} -m pip install --no-build-isolation {GS2MESH_DIR}/third_party/GroundingDINO",
    )
    # The rest of requirements.txt, read from the file itself rather than
    # transcribed here. Only the four local-path lines are dropped — those are
    # the packages installed above, and pip would rebuild them from source.
    #
    # Installing it verbatim is deliberate. Curating this list by what "looks
    # like" a notebook-only dependency does not work: k3d reads as one, but
    # gs2mesh_utils/colmap_utils.py imports
    # gs2mesh_utils/third_party/visualization/visualize.py at module scope and
    # *that* imports k3d — so dropping it kills run_single.py on its own line
    # 12, before a single job does any work. Take upstream's list as given.
    .run_commands(
        f"grep -v '^third_party/' {GS2MESH_DIR}/requirements.txt > /tmp/gs2mesh-reqs.txt",
        f"{PY} -m pip install -r /tmp/gs2mesh-reqs.txt",
    )
    # ---------------------------------------------------------------------
    # Pretrained weights, at the paths the code hard-codes.
    #
    # DLNR_Middlebury is the default --stereo_model and is *not* optional: the
    # stereo stage is where GS2Mesh's depth comes from, so without it there is
    # no mesh. SAM2 + GroundingDINO serve the optional masker_automask path;
    # they are baked in anyway so enabling that flag doesn't need a rebuild.
    # ---------------------------------------------------------------------
    .run_commands(
        f"mkdir -p {GS2MESH_DIR}/third_party/DLNR/pretrained",
        f"wget -q -O {GS2MESH_DIR}/third_party/DLNR/pretrained/DLNR_Middlebury.pth"
        " https://github.com/David-Zhao-1997/High-frequency-Stereo-Matching-Network/releases/download/v1.0.0/DLNR_Middlebury.pth",
        f"wget -q -O {GS2MESH_DIR}/third_party/DLNR/pretrained/DLNR_SceneFlow.pth"
        " https://github.com/David-Zhao-1997/High-frequency-Stereo-Matching-Network/releases/download/v1.0.0/DLNR_SceneFlow.pth",
        f"mkdir -p {GS2MESH_DIR}/third_party/segment-anything-2/checkpoints",
        f"wget -q -O {GS2MESH_DIR}/third_party/segment-anything-2/checkpoints/sam2_hiera_large.pt"
        " https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt",
        f"mkdir -p {GS2MESH_DIR}/third_party/GroundingDINO/weights",
        f"wget -q -O {GS2MESH_DIR}/third_party/GroundingDINO/weights/groundingdino_swint_ogc.pth"
        " https://github.com/IDEA-Research/GroundingDINO/releases/download/v0.1.0-alpha/groundingdino_swint_ogc.pth",
    )
    # Everything above compiles CUDA against whatever torch is present. If the
    # arch list or FORCE_CUDA ever drifts, these fail silently at import rather
    # than at build — i.e. an hour into someone's job. Catch it here instead.
    .run_commands(
        f'{PY} -c "import torch, diff_gaussian_rasterization, simple_knn,'
        ' groundingdino, sam2, open3d, trimesh, plyfile"',
        # Then the check that actually matters: import the entrypoint itself.
        # Hand-listing modules here would repeat the mistake that let a missing
        # k3d ship — it only asserts what someone thought to name. run_single.py
        # pulls the whole gs2mesh_utils tree (and through it DLNR, the 3DGS
        # scene/renderer packages and the visualization module) at import scope,
        # and its work is behind a __main__ guard, so importing it is both a
        # complete dependency check and a no-op. Needs the real cwd: the module
        # resolves everything off os.getcwd() and its siblings off sys.path[0].
        f'cd {GS2MESH_DIR} && {PY} -c "import run_single"',
        # And the wrapper's own deps, in the *container* interpreter.
        "pip install boto3 requests trimesh",
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


def _post_webhook(webhook_url: str, payload: dict) -> None:
    import requests

    requests.post(
        webhook_url,
        json=payload,
        headers={"X-Webhook-Secret": os.environ["JOB_WEBHOOK_SECRET"]},
        timeout=30,
    )


def _ply_vertex_count(path: str) -> int:
    """
    Read ``element vertex N`` out of a PLY header.

    Parsed by hand rather than with plyfile because plyfile lives in the 3.8
    venv, not in the container interpreter this runs in — and reading a header
    is not worth a second copy of the dependency.
    """
    with open(path, "rb") as handle:
        for _ in range(64):  # headers are short; don't read a GB looking for one
            line = handle.readline()
            if not line or line.strip() == b"end_header":
                break
            match = re.match(rb"element\s+vertex\s+(\d+)", line.strip())
            if match:
                return int(match.group(1))
    return 0


def _find_splat(colmap_name: str) -> str:
    """
    The Inria 3DGS checkpoint GS2Mesh's training stage wrote.

    run_single.py drives third_party/gaussian-splatting/train.py with
    ``--model_path splatting_output/{splatting}/{colmap_name}``, and that writes
    Inria's standard layout underneath. Take the highest iteration: upstream
    saves both 7000 and 30000 by default and only the last one is fully trained.

    The trailing wildcard on the directory is load-bearing for the same reason
    it is in _find_mesh: ``--downsample > 1`` makes run_single rewrite
    colmap_name to ``{name}_downsample{N}`` *before* the training stage, so
    every path from there on uses the rewritten name.
    """
    pattern = os.path.join(
        GS2MESH_DIR, "splatting_output", "*", f"{colmap_name}*",
        "point_cloud", "iteration_*", "point_cloud.ply",
    )
    candidates = glob.glob(pattern)
    if not candidates:
        raise RuntimeError(
            f"Training finished but no 3DGS checkpoint was produced under {pattern}"
        )

    def iteration(path: str) -> int:
        name = os.path.basename(os.path.dirname(path))
        return int(name.rsplit("_", 1)[-1])

    return max(candidates, key=iteration)


def _find_mesh(colmap_name: str) -> str:
    """
    The cleaned TSDF mesh, named per gs2mesh_utils/eval_utils.py:create_strings
    as ``output/{experiment}/{colmap_name}/{TSDF_string}_cleaned_mesh.ply``.
    Same trailing wildcard, same downsample-rename reason as _find_splat.
    """
    pattern = os.path.join(
        GS2MESH_DIR, "output", "*", f"{colmap_name}*", "*_cleaned_mesh.ply"
    )
    candidates = glob.glob(pattern)
    if not candidates:
        raise RuntimeError(f"TSDF finished but no cleaned mesh was produced under {pattern}")
    # More than one only happens if TSDF parameters changed between runs in a
    # warm container, which _cleanup below is meant to prevent. Newest wins.
    return max(candidates, key=os.path.getmtime)


def _cleanup(colmap_name: str) -> None:
    """
    Drop this job's inputs and outputs from the container.

    Containers are reused across inputs, and every GS2Mesh stage writes into
    fixed trees under /opt/gs2mesh keyed by colmap_name. Leaving a job's
    hundreds of stereo renders and 30k-iteration checkpoints behind would both
    fill the disk and let a later glob match an earlier job's artifacts.
    """
    trees = (
        glob.glob(os.path.join(GS2MESH_DIR, "data", "custom", f"{colmap_name}*"))
        + glob.glob(os.path.join(GS2MESH_DIR, "splatting_output", "*", f"{colmap_name}*"))
        + glob.glob(os.path.join(GS2MESH_DIR, "output", "*", f"{colmap_name}*"))
    )
    for tree in trees:
        shutil.rmtree(tree, ignore_errors=True)


@app.function(
    # 80 GB. H100 is the only supported card here; its arch is in both arch
    # lists above. GS2Mesh's own docs cite A40/L40, and note that VRAM scales
    # with image resolution and gaussian count — hence the `downsample` knob.
    gpu="H100",
    # COLMAP + 30k GS iterations + a stereo render *pair* per view + DLNR on
    # each + TSDF fusion. Materially longer than either existing worker, which
    # each do roughly one of those stages.
    timeout=10800,
    secrets=[
        modal.Secret.from_name("custom-secret"),
        modal.Secret.from_name("gisviz-webhook"),
    ],
    image=image,
)
def process(
    job_id: str,
    input_prefix: str,
    output_key: str,
    mesh_key: str,
    webhook_url: str,
    downsample: int = 1,
    masker_automask: bool = False,
    masker_prompt: str = "main_object",
) -> None:
    """
    Photos under ``input_prefix`` -> a 3DGS ``.ply`` at ``output_key`` and a
    textured ``.glb`` at ``mesh_key``, both in R2.

    ``downsample`` divides image resolution before COLMAP; raise it if a
    capture OOMs. ``masker_automask`` runs GroundingDINO + SAM2 to isolate the
    object named by ``masker_prompt`` from its background before TSDF fusion —
    worth it for a single object in a cluttered scene, pointless for a scene
    capture.
    """
    client = _r2_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    # GS2Mesh identifies a capture by directory name throughout, and derives
    # every output path from it. Namespacing it by job keeps concurrent
    # containers and sequential runs in one container from colliding.
    colmap_name = f"job-{job_id}"
    try:
        # 1) Stage the photos where GS2Mesh looks for an image sequence:
        # data/{dataset_name}/{colmap_name}/images/.
        images_dir = os.path.join(GS2MESH_DIR, "data", "custom", colmap_name, "images")
        os.makedirs(images_dir, exist_ok=True)
        count = _download_prefix(client, input_prefix, images_dir)
        if count == 0:
            raise RuntimeError(f"No photos found under {input_prefix}")
        print(f"[gs2mesh] staged {count} photos for {colmap_name}")

        # 2) COLMAP -> 3DGS -> stereo renders -> DLNR depth -> TSDF, all of it.
        #
        # cwd is load-bearing: run_single.py computes
        # `base_dir = os.path.abspath(os.getcwd())` at import time and resolves
        # data/, splatting_output/, output/ and every third_party weight path
        # off it.
        #
        # --skip_video_extraction because the input is already an image
        # sequence; without it the first stage looks for {colmap_name}.mp4.
        command = [
            PY, "run_single.py",
            "--colmap_name", colmap_name,
            "--dataset_name", "custom",
            "--skip_video_extraction",
            "--downsample", str(downsample),
        ]
        if masker_automask:
            # --masker_SAM2_local is what makes init_predictor use the weights
            # baked into the image; without it SAM2 is pulled from the HF hub on
            # every single job.
            command += [
                "--masker_automask",
                "--masker_prompt", masker_prompt,
                "--masker_SAM2_local",
            ]
        else:
            # Without automask, run_single's masking branch just prints
            # "Automask must be enabled for masking in script mode. Skipping."
            # Skip the stage outright so that isn't mistaken for a failure.
            command.append("--skip_masking")

        # check=True catches the wrapper dying, but proves little on its own:
        # GS2Mesh runs COLMAP and GS training through os.system() and never
        # checks their exit codes. The globs below are the real test.
        subprocess.run(command, cwd=GS2MESH_DIR, check=True)

        # 3) Collect both artifacts. The splat needs no PLY-schema surgery
        # (unlike gpu/sugar_app.py's Inria shim) — GS2Mesh trains with Inria's
        # own trainer, so the checkpoint is already in that schema.
        splat_ply = _find_splat(colmap_name)
        mesh_ply = _find_mesh(colmap_name)
        gaussians = _ply_vertex_count(splat_ply)
        print(f"[gs2mesh] splat {splat_ply} ({gaussians} gaussians), mesh {mesh_ply}")

        # 4) .glb rather than the TSDF .ply, for the same reason
        # gpu/sugar_app.py exports one: a single key, a single signed URL, and a
        # format the viewer already loads. TSDF meshes carry vertex colours
        # rather than a texture atlas, and trimesh preserves those through glTF.
        import trimesh

        mesh_glb = os.path.join(tempfile.mkdtemp(prefix=f"gs2mesh-{job_id}-"), "mesh.glb")
        trimesh.load(mesh_ply).export(mesh_glb)

        # 5) Upload both, then tell the caller.
        client.upload_file(splat_ply, bucket, output_key)
        client.upload_file(
            mesh_glb, bucket, mesh_key,
            ExtraArgs={"ContentType": "model/gltf-binary"},
        )
        _post_webhook(webhook_url, {
            "status": "done",
            "backend": "gs2mesh",
            "output_key": output_key,
            "mesh_key": mesh_key,
            "gaussians": gaussians,
            "mesh_bytes": os.path.getsize(mesh_glb),
        })
    except Exception as exc:  # always fire a webhook so the job never hangs
        _post_webhook(webhook_url, {
            "status": "failed",
            "backend": "gs2mesh",
            "error": str(exc),
        })
        raise
    finally:
        # Best-effort by design: a cleanup problem must not turn a finished job
        # into a failed one, and the webhook has already gone out either way.
        try:
            _cleanup(colmap_name)
        except Exception as exc:
            print(f"[gs2mesh] cleanup failed: {exc}")


@app.local_entrypoint()
def main(
    input_prefix: str,
    output_key: str,
    mesh_key: str,
    webhook_url: str,
    job_id: str = "local",
    downsample: int = 1,
    masker_automask: bool = False,
    masker_prompt: str = "main_object",
) -> None:
    """
    Run one job synchronously, for iterating on the image build before
    deploying:

        modal run gpu/gs2mesh_app.py --input-prefix inputs/test/ \\
            --output-key models/test/scene.ply --mesh-key models/test/scene.glb \\
            --webhook-url https://example.invalid/hook

    The image build is the risky part here — COLMAP from source plus four CUDA
    extension builds — so get a `modal run` through before `modal deploy`.
    """
    process.remote(
        job_id,
        input_prefix,
        output_key,
        mesh_key,
        webhook_url,
        downsample,
        masker_automask,
        masker_prompt,
    )
