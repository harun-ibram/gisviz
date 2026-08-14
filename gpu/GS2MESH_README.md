# GS2Mesh worker

The GPU worker the backend drives: photos in, **both** a Gaussian splat and a
mesh out, in a single call, using [GS2Mesh](https://github.com/yanivw12/gs2mesh).

**This replaced the two-stage `splat_app` → `sugar_app` pipeline.**
`/jobs/{id}/start` spawns `gisviz-gs2mesh`/`process` and nothing else. Those two
older apps and their sources under `gpu/` are untouched and still deployed, but
no backend code path spawns them any more —
[README.md](README.md) documents them as history. Reverting means pointing
`_spawn_gs2mesh_job` in `src/main.py` back at `gisviz-splat` and restoring the
two-stage webhook handlers.

Two consequences of the switch worth knowing:

- **EXIF-GPS georeferencing is gone.** `splat_app.py` fitted a 7-DOF similarity
  from photo GPS and trained in ENU metres; GS2Mesh has no equivalent, so its
  output is back in COLMAP's arbitrary frame and needs hand-placing in the
  viewer. If automatic placement matters more than mesh quality, that is the
  reason to revert.
- **The splat no longer arrives early.** It used to be servable ~30 minutes
  before the mesh. Both now land together, so `status` and `mesh_status` reach
  `done` at the same moment.

## How it differs from splat_app + sugar_app

|  | `splat_app` → `sugar_app` | `gs2mesh_app` |
|---|---|---|
| Modal apps | two (`gisviz-splat`, `gisviz-sugar`) | one (`gisviz-gs2mesh`) |
| Images | two, sharing only CUDA | one |
| Splat trainer | nerfstudio `splatfacto-w-light` | Inria 3DGS (`train.py`) |
| Surface method | SuGaR: bind gaussians to a surface, Poisson, refine, texture | render stereo pairs → DLNR stereo depth → TSDF fusion |
| Splat available before mesh | yes, ~30 min earlier | no, both land together |
| Georeferencing | EXIF GPS → ENU metres | none |
| Object isolation | none | optional GroundingDINO + SAM2 automasking |

GS2Mesh's pipeline is: COLMAP SfM → 3DGS training → render a *stereo pair* of
novel views at each camera → run the DLNR stereo network on each pair for a
geometrically consistent depth map → fuse the depths with TSDF (Open3D) →
cluster-clean the mesh.

The practical trade-off: SuGaR's surface is derived from the gaussians
themselves, so it inherits their fuzziness on thin structure, but it produces a
UV-textured mesh. GS2Mesh gets depth from a stereo prior instead of from the
gaussians, which tends to give cleaner geometry on flat and glossy surfaces, but
its output is vertex-coloured rather than textured.

## Deploy

```
modal deploy gpu/gs2mesh_app.py
```

**Iterate with `modal run gpu/gs2mesh_app.py` first.** The image build is the
risky part: COLMAP from source (~15-25 min, same as `splat_app`'s) plus four
torch CUDA extension builds. Every one of those has a build-time sanity check,
so a broken layer fails the build rather than someone's job an hour in.

No new secrets — it reuses the two the other workers already use:

- `custom-secret` → `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- `gisviz-webhook` → `JOB_WEBHOOK_SECRET`

## Calling it

`src/main.py:_spawn_gs2mesh_job` does this, from both `/jobs/{id}/start` and the
`/jobs/{id}/mesh` re-run:

```python
modal.Function.from_name("gisviz-gs2mesh", "process").spawn(
    job_id,          # namespaces this run's working directories
    input_prefix,    # R2 prefix holding the photos, e.g. "inputs/{job_id}/"
    output_key,      # where the 3DGS .ply goes
    mesh_key,        # where the .glb goes
    webhook_url,     # POSTed on completion, signed with JOB_WEBHOOK_SECRET
    downsample=1,        # divide image resolution; raise if a capture OOMs
    masker_automask=False,
    masker_prompt="main_object",
)
```

The worker imposes no key convention of its own; the backend passes
`models/{job_id}/{slug}.ply` and the same path with a `.glb` extension, so the
mesh is derivable from `model_path` without another round trip. The last three
arguments are defaulted and the backend does not currently pass them — raising
`downsample` is the first thing to try if a large capture OOMs.

Webhook payload on success:

```json
{"status": "done", "backend": "gs2mesh", "output_key": "...", "mesh_key": "...",
 "gaussians": 812345, "mesh_bytes": 4210332}
```

and on failure `{"status": "failed", "backend": "gs2mesh", "error": "..."}`. As
with the other two workers, a webhook always fires so a caller polling on it can
never hang.

A failure sets both `status` and `mesh_status` to `failed` and **keeps the
uploaded photos**, which is what makes `POST /jobs/{id}/mesh` able to re-run the
whole pipeline without a fresh upload. Success purges them.

### Automasking

`masker_automask=True` runs GroundingDINO to detect whatever `masker_prompt`
names, then SAM2 to segment it across views, and restricts TSDF fusion to that
object. Worth it for a single object in a cluttered scene; pointless for a scene
capture, where it will happily mask away most of what you wanted. Both sets of
weights are baked into the image, so toggling this needs no rebuild.

## Two things to know before touching the image

**COLMAP is built from source, not apt** — the same trap `splat_app.py`
documents at length. The distro package has no CUDA, COLMAP then falls back to
SiftGPU-over-OpenGL, and that aborts in a headless container. GS2Mesh walks
straight into it: `gs2mesh_utils/colmap_utils.py:run_colmap` calls
`colmap feature_extractor … --SiftExtraction.use_gpu 1`. The image compiles
COLMAP 3.8 with `-DCUDA_ENABLED=ON` (pinned to 3.8 because it is the last
release that builds against Ubuntu 22.04's Ceres 2.0) and the build fails if the
resulting binary does not link `libcudart`. Using a card other than H100 means
adding its arch to `CUDA_ARCHS_CMAKE` **and** `CUDA_ARCHS_TORCH`.

**GS2Mesh runs on its own Python 3.8, in a venv, behind a subprocess.** Upstream
documents Python 3.8 and means it — its vendored SAM2 carries a patched
`python_requires=">=3.8.0"` where upstream SAM2 declares `">=3.10.0"`. But a
Modal function cannot run on 3.8: `Image.add_python` only accepts 3.10–3.14, and
`modal` itself declares `Requires-Python >=3.10`, and the container imports the
Modal client into the same interpreter as the decorated function. So the
container is 3.10 for Modal's sake, GS2Mesh lives in a 3.8 venv at
`/opt/gs2mesh-venv`, and the worker shells out to
`/opt/gs2mesh-venv/bin/python run_single.py …`. That is upstream's own
entrypoint, so nothing is lost — but it does mean **the wrapper cannot import
anything from GS2Mesh's environment.** That is why the splat's vertex count is
parsed off the PLY header by hand instead of with `plyfile`.

Related: the clone is deliberately **not** `--recursive`.
`third_party/{DLNR,gaussian-splatting,segment-anything-2,GroundingDINO}` are
vendored directories in GS2Mesh's tree, not submodules, and some carry local
patches (that SAM2 `python_requires` among them). Re-cloning them from upstream
would lose those.

## Finding the outputs

GS2Mesh writes into fixed trees under `/opt/gs2mesh` keyed by `colmap_name`
(which this worker sets to `job-{job_id}`), so the worker globs for both
artifacts rather than trusting a constructed path:

- splat: `splatting_output/{splatting}/job-{id}/point_cloud/iteration_*/point_cloud.ply` — highest iteration wins, since upstream saves 7000 and 30000 and only the last is fully trained.
- mesh: `output/{experiment}/job-{id}*/*_cleaned_mesh.ply` — the trailing `*` is load-bearing, because `--downsample > 1` makes `run_single` rewrite `colmap_name` to `{name}_downsample{N}` partway through.

Both trees are deleted in a `finally` block after each job. Containers are
reused across inputs, and without that a later glob could match an earlier job's
artifacts — quite apart from filling the disk with stereo renders.

The splat needs no PLY-schema surgery on the way out, unlike `sugar_app.py`'s
Inria shim: GS2Mesh trains with Inria's own trainer, so the checkpoint is
already in that schema. The mesh is converted to `.glb` for the same reason
`sugar_app.py` does it — one key, one signed URL, no relative material
references for the viewer to resolve. TSDF meshes are vertex-coloured, and
trimesh carries that through glTF.
