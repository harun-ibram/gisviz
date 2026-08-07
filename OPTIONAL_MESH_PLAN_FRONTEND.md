# Optional mesh stage — frontend

Frontend half of `OPTIONAL_MESH_PLAN.md` (branch `optional_mesh_backend`).

## Context

Uploading photos used to run both GPU stages unconditionally — the Gaussian
splat, then a SuGaR mesh on top of it — so every upload took roughly twice as
long as the splat alone, for a mesh most users never open. The backend makes the
mesh opt-in per job via `want_mesh` on `POST /jobs`, defaulting to `false`. The
upload form needs to offer that choice and say what it costs.

## API contract

- `POST /jobs` body gains `want_mesh: boolean`. Omitting it means no mesh, so
  the field is only interesting when the user ticks the box.
- `GET /jobs/{id}` gains `want_mesh`, alongside the existing `mesh_status`
  (`null | processing | done | failed | skipped`). `status` is still about the
  splat alone and goes `done` while the mesh is still running.
- `mesh_status: "skipped"` means two different things, told apart by
  `want_mesh`: not requested (`false`) vs. requested but unbuildable (`true`).
- There is no way to add a mesh after the fact — the photos are purged as soon
  as the splat lands on a `want_mesh: false` job, so `POST /jobs/{id}/mesh`
  returns 409 for them. Don't offer a retry action for those jobs.

## Changes

**`src/components/Upload.jsx`**

- `wantMesh` state, `useState(false)` to match the backend default.
- An **Options** section below Photos, in the left column: a checkbox labelled
  "Also build a 3D mesh" plus help text stating the cost — a second pass over
  the finished splat that roughly doubles processing time, with the splat
  viewable before the mesh starts. Reuses the app's existing `.radio` + `.dot`
  boolean control (the same pair the GIS layer library's filters use): a real
  `<input type="checkbox">` for semantics, the styled dot for the affordance.
  Disabled while a job is running.
- `want_mesh: wantMesh` in the `POST /jobs` body.
- A **Mesh** row in the job rail's summary ("Yes · slower" / "No"), so the
  choice is visible next to Mode/Target/Photos rather than only in the form.
- While running, the status line says "Processing the splat…" when a mesh was
  requested, since `status: done` is not the end of the job in that case.
- On success, if the polled job comes back `mesh_status: "processing"`, append a
  notice that the mesh is still building and will attach on its own. Appended to
  `notice` rather than assigned, so it does not clobber the skipped-photos
  message.

**`src/App.css`** — `.gv-upload-options` (column layout) and
`.gv-upload-option-help` (12px muted help text), added with the other
upload-page rules. No new component styling: the control itself is themed.

## Verification

- `npm run lint` and `npm run build` both clean; the new classes are present in
  the built CSS.
- In the running app: the box is unticked on load, the rail reads "Mesh: No",
  and `POST /jobs` carries `want_mesh: false`. Tick it — the rail reads
  "Mesh: Yes · slower" and the request carries `true`. During a real run the
  status line mentions the splat, and on completion the mesh notice appears
  while the "Open in visualizer" link works off the splat immediately.
