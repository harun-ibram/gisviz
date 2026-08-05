# Login Plan — Frontend

## Context

The backend plan (`LOGIN_PLAN.md`, branch `login`) puts a JWT gate on the eight
write endpoints — `POST /nodes`, `/regions`, `/jobs`, `/jobs/{id}/start`,
`/gis/jobs`, `/gis/jobs/{id}/start`, `DELETE /gis/jobs/{id}`,
`DELETE /gis/layers/{id}` — and leaves every `GET` public. It adds
`POST /auth/login` (returns `{access_token, token_type, expires_in, user:{id,email}}`)
and `GET /auth/me`.

The frontend (this branch, `login_frontend`, off `frontend`) currently sends no
credentials at all, so every upload and delete would start failing with a 401 the
moment the backend ships. This plan makes the app carry a token, and makes the
gate visible:

- **A small login-status icon pinned bottom-left**, on every page.
- **A rectangular login popup centered on screen**, ~440px wide — not a full-screen
  takeover.
- **Every tab stays browsable logged out.** The Upload tab and the GIS upload panel
  still render; the forms are just disabled with a "Sign in to upload" prompt.

Decisions made: token in **`localStorage`** (`gisviz:auth:v1`) so a login survives
a browser restart until the backend's 8h expiry; the bottom-left icon opens a
**small popover with the email + Sign out** when already signed in.

## Conventions this follows (from `GIS_PLAN_FRONTEND.md` + shipped code)

- `src/hooks/SplatLibraryProvider.jsx:4` stays the **only** place
  `import.meta.env.VITE_API_URL` is read. The auth code takes `apiBaseUrl` from
  `useSplatLibrary()`.
- Context lives in a three-file trio (`*Context.js` + `use*.js` + `*Provider.jsx`)
  because `eslint-plugin-react-refresh` rejects a `.jsx` that exports both a
  component and a non-component.
- New CSS is **appended to `src/App.css`** in one delimited section.
  `src/theme/nocturne.css` is vendored and must not be edited; `App.css` loads last
  so overrides win at equal specificity without `!important`.
- Reuse primitives before inventing: `.dialog-backdrop`/`.dialog` for the popup,
  `.field`/`.input` for the form, `.btn`/`.btn-primary`/`.btn-secondary`,
  `.gv-tool` for the icon button, `.gv-library-error` for error text.
- **The client gate is UX, not security** — the backend still 401s. Never treat a
  hidden button as protection.
- `npm run lint` must pass; deliberate hook-dep omissions get an explicit disable
  with a comment.

## New files

### `src/hooks/authContext.js`, `src/hooks/useAuth.js`, `src/hooks/AuthProvider.jsx`

Mirrors the `splatLibraryContext.js` / `useSplatLibrary.js` / `SplatLibraryProvider.jsx`
trio exactly, down to the guard message (`'useAuth must be used within an AuthProvider'`).

`AuthProvider` state and context value:

| Key | Purpose |
|---|---|
| `user` | `{id, email}` or `null` |
| `isAuthed` | `Boolean(user)` — what every gate reads |
| `ready` | false until the stored token has been validated, so the UI doesn't flash "signed out" on load |
| `getToken()` | ref-backed reader, **not** the raw token, so `makeGisApi` needn't be re-memoized on every token change |
| `login(email, password)` | calls the API, stores the token, sets `user`; throws on failure so the dialog can show the message |
| `logout()` | clears state + storage |
| `requireLogin()` | opens the login dialog from anywhere (used by the "Sign in to upload" buttons) |
| `dialogOpen`, `closeDialog()` | dialog visibility, held here so any component can trigger it |

Behaviour:

- Token persisted at `localStorage['gisviz:auth:v1']` as `{token, user}`. All storage
  access wrapped in try/catch — same reasoning as
  `GisLibraryProvider.jsx:72-74` ("a full or unavailable storage is not worth
  surfacing"). Key naming follows `gisviz:<feature>:v<n>` from
  `GisLibraryProvider.jsx:99`.
- On mount, if a token is stored, call `GET /auth/me` with it. 200 → restore the
  session; 401 → drop it silently (it expired while the tab was closed). Either way
  set `ready`.
- `handleUnauthorized()` — clears the session and opens the dialog. Passed down to
  the GIS API so an expired token mid-session surfaces as a login prompt, not a red
  error string.

### `src/auth/authApi.js`

`makeAuthApi(apiBaseUrl)` returning `{ login({email, password}), me(token) }`,
mirroring `makeGisApi`'s factory shape and reusing `request()` from `gisApi.js`
(exported for this — see below) so there is one fetch/error path in the app. Never
reads `import.meta.env`.

### `src/components/auth/AuthCorner.jsx`

The bottom-left widget. Rendered as a sibling of `.gv-shell` in `App.jsx` — **not
inside it**, because `.gv-shell` is `overflow: hidden` (`App.css:4-9`) and would
clip it.

- A fixed `.gv-auth-fab` button (reusing `.gv-tool` sizing) with `IconUser`.
- Signed out: muted, `aria-label="Sign in"`. Click → `requireLogin()`.
- Signed in: accent-tinted with a small dot (reuse `.gv-pulse-dot`,
  `App.css:174-181` — currently orphaned CSS that nothing renders).
  ``aria-label={`Signed in as ${user.email}`}``. Click → toggles a compact popover
  anchored **above** the button: the email on one line, then a
  `btn btn-secondary btn-block` "Sign out" with `IconLogOut`.
- Popover closes on Escape, on outside click (a `pointerdown` listener on
  `document` while open), and on sign-out. `aria-expanded` on the button.

### `src/components/auth/LoginDialog.jsx`

The centered popup. Copies the render pattern of the existing confirm dialog at
`GisLayerLibrary.jsx:274-292` — a conditional render (no portal, no `<dialog>`
element), `role="dialog" aria-modal="true"` on the backdrop:

```
.dialog-backdrop            ← position:fixed, inset:0, grid place-items:center (nocturne.css:242)
  .dialog                   ← width: min(440px, 100%), surface bg, radius-lg, shadow-lg
    .dialog-title           "Sign in"
    <form onSubmit>
      .field > label + .input   email    (type="email", autoFocus, autoComplete="username")
      .field > label + .input   password (autoComplete="current-password")
                                 + a .gv-tool toggle using the existing
                                   IconEye / IconEyeOff (icons.jsx:125,134)
      <p className="gv-library-error">  on failure
      .dialog-actions
        btn btn-secondary  Cancel
        btn btn-primary    Sign in   (type="submit", disabled while pending)
```

Wrapping the fields in a `<form>` gets Enter-to-submit and browser password-manager
support for free. Escape and backdrop click close it; focus returns to the corner
button on close. Errors: the backend returns a generic
`"Invalid email or password"` for 401 and a 429 after five failures — render
`error.message` verbatim, which is the app's existing habit
(`GisUploadPanel.jsx:107`, `GisLayerLibrary.jsx:193`).

### `src/components/auth/SignInNotice.jsx`

One shared line reused by both upload surfaces: `<p className="text-muted">` with
"Sign in to upload." and a `btn btn-ghost` that calls `requireLogin()`. Modelled on
`queueFullMessage` in `gisErrors.js` — the existing precedent for "a server-side
policy that disables submit with an inline explanation".

## Modified files

### `src/App.jsx`

Two edits:

1. Nest `AuthProvider` **inside** `SplatLibraryProvider` and **outside**
   `GisLibraryProvider` (`App.jsx:93-96`). Inside, because it needs `apiBaseUrl`
   from `useSplatLibrary()` and that is the only sanctioned source; outside
   `GisLibraryProvider`, because the GIS API needs the token. `SplatLibraryProvider`
   itself only issues public GETs, so it needs nothing from auth — no circular
   dependency, and **`SplatLibraryProvider.jsx` is not modified at all.**
2. Render `<AuthCorner />` next to `<Analytics />` (`App.jsx:120`), outside
   `.gv-shell`.

Nav links are untouched: the Upload tab stays visible and reachable logged out.

### `src/App.css`

Append one `/* — auth — */` section: `.gv-auth-fab`, `.gv-auth-fab--in`,
`.gv-auth-pop`, `.gv-auth-pop-email`, and a media rule for `max-width: 860px`
(where the 236px sidebar disappears, `App.css:704-711`, and the button would sit
over content).

**Also add `.dialog-backdrop { z-index: 1100 }` here.** The app's only existing
z-index is `.gv-stage-alert { z-index: 2 }` (`App.css:531`), and nocturne's
`.dialog-backdrop` declares none — but Leaflet's own stylesheet puts panes at
200-700 and `.leaflet-control` at 800. A dialog opened from the corner button while
`/gis` is mounted would paint *under* the map controls. Fixing it in `App.css`
(which loads after nocturne) also fixes the existing delete-confirm dialog. Layer
the widget above it: fab `1000`, popover `1001`, backdrop `1100`.

### `src/gis/gisApi.js`

- Export the existing private `request()` (and keep `GisApiError` exported) so
  `authApi.js` reuses the one fetch/error path. `GisApiError` is currently imported
  nowhere outside this file, so nothing else is affected.
- `makeGisApi(apiBaseUrl, { getToken, onUnauthorized } = {})`. Add a private
  `send(url, options)` used by **the four mutating endpoints only** — `createJob`
  (L87), `startJob` (L94), `deleteJob` (L100), `deleteLayer` (L106):

  ```js
  // Only mutations carry the token: the read endpoints are public, and the fewer
  // places the token travels the better.
  const send = async (url, options = {}) => {
      const token = getToken?.()
      const headers = token
          ? { ...options.headers, Authorization: `Bearer ${token}` }
          : options.headers

      try {
          return await request(url, { ...options, headers })
      } catch (error) {
          if (error?.status === 401) {
              onUnauthorized?.()
              throw new GisApiError('Your session expired. Sign in again to continue.', { status: 401 })
          }
          throw error
      }
  }
  ```

  This is the single choke point for 401s on the whole GIS half.

### `src/hooks/GisLibraryProvider.jsx`

One line. `GisLibraryProvider.jsx:123-124` becomes:

```js
const { getToken, handleUnauthorized } = useAuth()
const api = useMemo(
    () => makeGisApi(apiBaseUrl, { getToken, onUnauthorized: handleUnauthorized }),
    [apiBaseUrl, getToken, handleUnauthorized],
)
```

Both callbacks are `useCallback`-stable and read the token through a ref, so the
memo does not churn when the token changes.

### `src/components/Upload.jsx`

The splat half has no fetch wrapper — three call sites change:

- `Upload.jsx:311` (`POST /{node|region}s`), `:328` (`POST /jobs`), `:359`
  (`POST /jobs/{id}/start`) each get an `Authorization: Bearer` header. Build it
  once at the top of `handleProcess` via a small local `authHeaders()` helper so the
  three sites stay identical.
- **Do not touch `Upload.jsx:32`** — that is the presigned R2 `PUT`. An
  `Authorization` header there breaks the S3 signature and the upload 403s. Same
  applies to `src/gis/uploadGisFiles.js:45` and `GisVectorLayer.jsx:101,109`; those
  files are not modified.
- `canProcess` (`Upload.jsx:259`) gains `&& isAuthed`, so the Process button at
  `:605-613` disables itself using the existing `.btn:disabled` styling.
- Render `<SignInNotice />` just above that button when `!isAuthed`.
- On a 401 from any of the three, call `handleUnauthorized()` so the popup opens.

`GIS_PLAN_FRONTEND.md` declares `Upload.jsx` off-limits, but that constraint was
scoped to the GIS work; gating it is the point here. Flagging it explicitly so the
deviation is deliberate.

### `src/components/gis/GisUploadPanel.jsx`

`canSubmit` (`GisUploadPanel.jsx:80`) gains `&& isAuthed`; render `<SignInNotice />`
above the submit button (`:203-210`). The panel stays mounted and visible — per the
requirement that every tab remains browsable. `GisPage.jsx` is **not** modified.

### `src/components/gis/GisLayerLibrary.jsx` and `GisJobRail.jsx`

The destructive controls get `disabled={!isAuthed}` with a
`title="Sign in to delete"`:

- `GisLayerLibrary.jsx:79-86` — the per-row delete `.gv-tool--sm`.
- `GisJobRail.jsx:223-231` — "Cancel job"; `:199-205` — "Retry start"; the retry
  inside `ErrorCard` (`:68-75`, used at `:215`).
- `GisJobRail.jsx:241-245` "Dismiss" stays enabled — it is client-only, no network.

### `src/components/icons.jsx`

Add `IconUser` and `IconLogOut` in the existing flat style (`viewBox="0 0 24 24"`,
`fill="none"`, `stroke="currentColor"`, `strokeWidth` 1.6-1.8, `size` prop) —
match `IconClose` (`icons.jsx:143`) exactly. `IconEye`/`IconEyeOff` already exist
for the password toggle; no other icons needed.

## Not modified (regression gate)

`src/hooks/SplatLibraryProvider.jsx`, `src/components/gis/GisPage.jsx`,
`src/components/SplatViewer.jsx`, `src/components/OSMViewer.jsx`,
`src/theme/nocturne.css`, `src/gis/uploadGisFiles.js`,
`src/components/gis/GisVectorLayer.jsx`, `vite.config.js`, `package.json`
(no new dependencies — the whole feature is `fetch` + existing CSS).

## Verification

Run the backend from the `login` branch with `AUTH_SECRET` set and a user created
via `python src/create_user.py`, then `npm run dev` (Vite proxies `/api` →
`localhost:8000`, `vite.config.js`).

1. **Logged out, everything still browsable** — the acceptance test. Visit `/`,
   `/viewer`, `/nodes`, `/regions`, and `/gis`: splat lists populate, and on `/gis`
   the map draws layers, the layer library lists them, and the detail rail opens.
   No 401 appears in the network tab, because none of these send a token and all of
   them are public.
2. **Gate is visible, not hidden** — `/upload` and `/gis` both still render their
   upload forms, greyed out, each showing "Sign in to upload". The Upload nav link
   is still present in the header and sidebar.
3. **Corner icon** — bottom-left on every route, above the Leaflet controls on
   `/gis` (this is what the z-index work is for; check it specifically while the map
   is on screen). Clicking it opens the centered popup: a ~440px rectangle over a
   dimmed backdrop, window still visible around it.
4. **Login** — wrong password → the backend's generic message inside the dialog,
   dialog stays open. Correct password → dialog closes, the icon switches to its
   signed-in state, and both upload forms enable in place with no reload.
5. **Persistence** — hard-refresh: still signed in, with no "signed out" flash
   (that is what `ready` guards). Open a second tab: also signed in. Confirm
   `localStorage['gisviz:auth:v1']` exists.
6. **Upload round trip while signed in** — process a GIS job end to end
   (`POST /gis/jobs` → presigned PUTs → `POST /gis/jobs/{id}/start` → job rail
   polls to `done` → layer appears on the map), then delete that layer. Check in
   devtools that the `PUT`s to R2 carry **no** `Authorization` header — a stray one
   there is the most likely bug in this change, and it fails as a 403 from
   Cloudflare, not from our backend.
7. **Expiry / mid-session 401** — sign in, then clear the token from localStorage
   (or restart the backend with a different `AUTH_SECRET`) and press Process: the
   login popup opens by itself instead of showing a raw error, and the forms return
   to their disabled state.
8. **Sign out** — click the corner icon, popover shows the email, Sign out returns
   the app to the state in steps 1-2. Escape and an outside click both close the
   popover.
9. `npm run lint` and `npm run build` clean.

## Out of scope

- `src/components/SplatViewer.jsx:78` reads `import.meta.env.VITE_API_URL`
  directly with no `/api` fallback — a pre-existing bug that
  `GIS_PLAN_FRONTEND.md` already flags. Not touched here.
- `src/config.js` is a stray Node/dotenv/Postgres file imported by nothing; it
  would break a browser build if ever imported. Deleting it is a separate cleanup.
- Signup / password-reset UI — the backend deliberately has no such endpoints.
- Route-level redirects, roles, "remember me", refresh tokens.
