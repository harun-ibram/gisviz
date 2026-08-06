"""Modal GPU worker: a trained Gaussian splat -> SuGaR -> a textured .glb in R2.

Deployed separately from gpu/splat_app.py and from the Railway backend with:

    modal deploy gpu/sugar_app.py

The split is deliberate. This image and the splat image share nothing but CUDA:
that one builds COLMAP from source and pins nerfstudio, this one pins torch to
2.1.0 so a prebuilt PyTorch3D wheel exists. Keeping them apart means a broken
SuGaR layer can never take splat training down with it, and neither image is
rebuilt when the other changes — the COLMAP build alone is 15-25 minutes.

The backend spawns a run with
``modal.Function.from_name("gisviz-sugar", "mesh").spawn(...)`` from the splat
webhook handler (see src/main.py:job_webhook). Like the splat worker, this one
never touches the database: it reads R2, writes R2, and POSTs a secret-signed
webhook back to the backend, which is what sets ``mesh_path``.

Secrets (shared with gpu/splat_app.py):
  - ``custom-secret``  -> R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
  - ``gisviz-webhook`` -> JOB_WEBHOOK_SECRET
"""

import glob
import os
import shutil
import subprocess
import tempfile

import modal

app = modal.App("gisviz-sugar")

SUGAR_DIR = "/opt/sugar"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:11.8.0-devel-ubuntu22.04", add_python="3.10"
    )
    # libgl/libglib are open3d's runtime deps even headless; libegl/libglvnd are
    # nvdiffrast's, which JIT-compiles its extension on first use rather than at
    # install time — so it costs nothing here and is available if SuGaR reaches
    # for it. The path that actually matters (textured .obj export) rasterizes
    # with PyTorch3D, not nvdiffrast.
    .apt_install(
        "git", "build-essential", "cmake", "ninja-build", "pkg-config",
        "libgl1", "libglib2.0-0", "libegl1", "libglvnd-dev",
    )
    # Same reason as the splat image: `add_python`'s interpreter reports clang
    # as its compiler and clang is not in this image. FORCE_CUDA/arch list are
    # for the two CUDA submodules, which compile on a build machine with no GPU
    # — 75=T4, 80=A100, 86=A10G, matching the `gpu=` choices below.
    .env({
        "CC": "gcc",
        "CXX": "g++",
        "FORCE_CUDA": "1",
        "TORCH_CUDA_ARCH_LIST": "7.5;8.0;8.6",
    })
    # torch 2.1.0 rather than the splat image's 2.1.2, pinned to the newest
    # combination PyTorch3D publishes a prebuilt wheel for. Building PyTorch3D
    # from source adds 30+ minutes to every rebuild of this image.
    .pip_install(
        "torch==2.1.0", "torchvision==0.16.0",
        index_url="https://download.pytorch.org/whl/cu118",
    )
    .pip_install("fvcore", "iopath")
    .pip_install(
        "pytorch3d",
        find_links="https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu118_pyt210/download.html",
    )
    # numpy 2 breaks both open3d and the PyTorch3D wheel, which were built
    # against the 1.x ABI.
    .pip_install(
        "numpy<2", "open3d", "PyMCubes", "plyfile==0.8.1", "rich", "plotly",
        "trimesh", "pillow", "boto3", "requests",
    )
    .run_commands(
        # --no-build-isolation below makes pip use *this* environment's build
        # tools instead of provisioning its own, so they have to be here. Kept
        # in this layer rather than the pip_install above so that fixing it does
        # not invalidate the cached torch/PyTorch3D layers.
        #
        # The upper bound is load-bearing: setuptools >=81 drops pkg_resources,
        # and torch 2.1's cpp_extension.py opens with `from pkg_resources import
        # packaging`. Upgrading setuptools here therefore breaks the very builds
        # this line exists to enable. The base image ships 68.1.2, which is fine
        # — this pins that rather than trusting it to stay.
        "pip install 'setuptools<70' wheel",
        f"git clone --recursive https://github.com/Anttwo/SuGaR.git {SUGAR_DIR}",
        # --no-build-isolation is mandatory, not a preference. Both submodules
        # do `from torch.utils.cpp_extension import CUDAExtension` at the top of
        # setup.py, and PEP 517 builds them in a fresh venv holding only
        # setuptools — so the torch installed above is invisible and the build
        # dies with "No module named 'torch'" before it compiles anything.
        f"pip install --no-build-isolation {SUGAR_DIR}/gaussian_splatting/submodules/diff-gaussian-rasterization",
        f"pip install --no-build-isolation {SUGAR_DIR}/gaussian_splatting/submodules/simple-knn",
        # Same flag again: nvdiffrast probes for torch while resolving its build
        # requirements and aborts with its own "run pip install with
        # --no-build-isolation" message otherwise. It is an optional dependency
        # — SuGaR's textured-mesh export rasterizes with PyTorch3D
        # (sugar_extractors/refined_mesh.py) and never reaches for it — so if
        # this line ever becomes a maintenance burden, deleting it costs nothing
        # on the path this pipeline actually takes.
        "pip install --no-build-isolation git+https://github.com/NVlabs/nvdiffrast.git",
        # Both submodules compile CUDA against whatever torch is present. If the
        # arch list or FORCE_CUDA above ever drifts they fail silently at import
        # rather than at build, an hour into someone's job.
        'python -c "import pytorch3d, diff_gaussian_rasterization, simple_knn,'
        ' open3d, trimesh, plyfile"',
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


# ---------------------------------------------------------------------------
# Inria checkpoint shim
#
# SuGaR loads gaussians from {gs_output_dir}/point_cloud/iteration_{N}/point_cloud.ply
# and cameras from {gs_output_dir}/cameras.json — the layout the original
# graphdeco-inria trainer writes. nerfstudio produces neither, so the splat
# worker stages the cameras (see gpu/splat_app.py:_stage_mesh_inputs) and this
# worker fabricates the rest around the exported .ply.
# ---------------------------------------------------------------------------

# Inria's GaussianModel hard-codes max_sh_degree=3 and asserts on the exact
# count: 3 * (3 + 1)**2 - 3 == 45 f_rest properties, 15 per colour channel.
_REST_PER_CHANNEL = 15

_FIXED_PROPERTIES = [
    "x", "y", "z",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
]


def _to_inria_ply(src: str, dst: str) -> int:
    """
    Rewrite the exported splat into the PLY schema Inria's loader accepts.

    Only the spherical harmonics need touching. Positions, ``opacity`` (logit)
    and ``scale_*`` (log) and ``rot_*`` (wxyz) are stored identically by
    nerfstudio and Inria, so they are copied straight across.
    """
    import numpy as np
    from plyfile import PlyData, PlyElement

    vertex = PlyData.read(src)["vertex"]
    count = vertex.count
    present = {prop.name for prop in vertex.properties}

    missing = [name for name in _FIXED_PROPERTIES if name not in present]
    if missing:
        raise RuntimeError(f"Splat PLY has no {missing} — not a 3DGS export?")

    rest_names = sorted(
        (name for name in present if name.startswith("f_rest_")),
        key=lambda name: int(name.rsplit("_", 1)[-1]),
    )
    print(f"[mesh] splat PLY: {count} gaussians, {len(rest_names)} f_rest properties")

    # Inria reshapes these as (N, 3 channels, 15 coefficients), so a splat
    # exported at a lower SH degree has to be padded *per channel* — appending
    # zeros at the end would shift every coefficient into the wrong channel.
    per_channel = len(rest_names) // 3
    rest = np.zeros((count, 3, _REST_PER_CHANNEL), dtype=np.float32)
    if per_channel:
        source = np.stack(
            [np.asarray(vertex[name]) for name in rest_names], axis=1
        ).reshape(count, 3, per_channel)
        keep = min(per_channel, _REST_PER_CHANNEL)
        rest[:, :, :keep] = source[:, :, :keep]
    rest = rest.reshape(count, 3 * _REST_PER_CHANNEL)

    columns = {name: np.asarray(vertex[name], dtype=np.float32) for name in _FIXED_PROPERTIES}
    # Inria's loader ignores normals but its writer emits them, and some viewers
    # refuse a splat PLY without them.
    for name in ("nx", "ny", "nz"):
        columns[name] = np.zeros(count, dtype=np.float32)
    for index in range(rest.shape[1]):
        columns[f"f_rest_{index}"] = rest[:, index]

    order = (
        ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
        + [f"f_rest_{i}" for i in range(3 * _REST_PER_CHANNEL)]
        + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    )
    array = np.empty(count, dtype=[(name, "f4") for name in order])
    for name in order:
        array[name] = columns[name]

    PlyData([PlyElement.describe(array, "vertex")]).write(dst)
    return count


def _write_gs_checkpoint(gs_dir: str, scene_dir: str, normalized_ply: str) -> None:
    """Lay the normalized splat out the way SuGaR expects to find it."""
    # Both iterations: the wrapper defaults to loading 30000 while train.py's
    # --iteration_to_load defaults to 7000, and which one is asked for depends
    # on the code path. The file is the same either way.
    for iteration in (7000, 30_000):
        destination = os.path.join(gs_dir, "point_cloud", f"iteration_{iteration}")
        os.makedirs(destination, exist_ok=True)
        shutil.copyfile(normalized_ply, os.path.join(destination, "point_cloud.ply"))

    # SuGaR reads cameras from cameras.json, not from this file — it is written
    # only because the Inria layout always carries one and cheap insurance beats
    # a crash 30 minutes into a run.
    with open(os.path.join(gs_dir, "cfg_args"), "w") as handle:
        handle.write(
            "Namespace(data_device='cuda', eval=False, images='images',"
            f" model_path='{gs_dir}', resolution=-1, sh_degree=3,"
            f" source_path='{scene_dir}', white_background=False)"
        )


@app.function(
    # 24 GB. SuGaR's memory ceiling is the coarse stage's densified gaussians,
    # not the mesh; --high_poly (1M vertices) and a "long" refinement want an
    # A100 instead, and its arch is already in the build's arch list.
    gpu="A10G",
    timeout=5400,  # coarse training + Poisson + refinement + texturing
    secrets=[
        modal.Secret.from_name("custom-secret"),
        modal.Secret.from_name("gisviz-webhook"),
    ],
    image=image,
)
def mesh(
    job_id: str,
    splat_key: str,
    work_prefix: str,
    mesh_key: str,
    webhook_url: str,
) -> None:
    client = _r2_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    try:
        work = tempfile.mkdtemp(prefix=f"mesh-{job_id}-")
        # The scene directory's *name* becomes the output directory's name in
        # SuGaR (it splits scene_path on "/" and takes the last component), so
        # naming it after the job makes the results findable without guessing.
        scene_dir = os.path.join(work, "scene", job_id)
        images_dir = os.path.join(scene_dir, "images")
        gs_dir = os.path.join(work, "gs")
        os.makedirs(images_dir, exist_ok=True)
        os.makedirs(gs_dir, exist_ok=True)

        # 1) Pull the handoff bundle the splat worker staged, plus the splat
        # this mesh is built from. The splat is read back from R2 rather than
        # re-staged: it is the largest artifact in the job and it is already
        # sitting at output_key.
        photos = _download_prefix(client, f"{work_prefix}images/", images_dir)
        if photos == 0:
            raise RuntimeError(f"No staged images under {work_prefix}images/")
        client.download_file(
            bucket, f"{work_prefix}cameras.json", os.path.join(gs_dir, "cameras.json")
        )
        splat_ply = os.path.join(work, "splat.ply")
        client.download_file(bucket, splat_key, splat_ply)

        # 2) Reshape the splat into an Inria checkpoint SuGaR can open.
        normalized = os.path.join(work, "point_cloud.ply")
        gaussians = _to_inria_ply(splat_ply, normalized)
        _write_gs_checkpoint(gs_dir, scene_dir, normalized)

        # 3) Coarse SuGaR -> Poisson mesh -> refinement -> textured .obj.
        #
        # --low_poly is 200k vertices at 1 gaussian per triangle, and
        # "short" refinement is 2k iterations: roughly 20-30 minutes here and a
        # mesh a browser can actually load. --eval False keeps every photo in
        # training instead of holding out every 8th — this is a capture
        # pipeline, not a benchmark. --export_ply False because the hybrid
        # representation is redundant when we already serve the splat itself.
        #
        # SuGaR runs its stages through os.system() and does not check their
        # exit codes, so check=True here proves nothing: the glob below is the
        # real test of whether it worked.
        subprocess.run(
            ["python", "train_full_pipeline.py",
             "-s", scene_dir,
             "--gs_output_dir", gs_dir,
             "-r", "dn_consistency",
             "--low_poly", "True",
             "--refinement_time", "short",
             "--export_obj", "True",
             "--export_ply", "False",
             "--eval", "False",
             "--white_background", "False"],
            cwd=SUGAR_DIR,  # it writes results to ./output relative to the CWD
            check=True,
        )
        pattern = os.path.join(SUGAR_DIR, "output", "refined_mesh", job_id, "**", "*.obj")
        objs = glob.glob(pattern, recursive=True)
        if not objs:
            raise RuntimeError("SuGaR finished but produced no textured mesh")

        # 4) One .glb instead of the .obj/.mtl/.png trio: a single key, a single
        # signed URL, and no relative texture references for the viewer to
        # resolve through presigned links. trimesh reads the material and
        # texture sitting next to the .obj and embeds them.
        import trimesh

        scene = trimesh.load(objs[0])
        glb_path = os.path.join(work, "mesh.glb")
        scene.export(glb_path)

        client.upload_file(
            glb_path, bucket, mesh_key,
            ExtraArgs={"ContentType": "model/gltf-binary"},
        )
        _post_webhook(webhook_url, {
            "stage": "mesh",
            "status": "done",
            "mesh_key": mesh_key,
            "gaussians": gaussians,
            "mesh_bytes": os.path.getsize(glb_path),
        })
    except Exception as exc:  # always fire a webhook so the stage never hangs
        _post_webhook(webhook_url, {
            "stage": "mesh",
            "status": "failed",
            "error": str(exc),
        })
        raise
