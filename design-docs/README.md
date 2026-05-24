# `design-docs/` — internal design specs

Living drafts of future-feature designs for the Radiant suite. Not customer-
facing. Excluded from the deployed site via `.assetsignore` so nothing in
here is served at `radiant-mpc.com/design-docs/...` even though it's in the
public Git repo for convenience.

| File | Status | Description |
|---|---|---|
| `quikbolus-phase-2-spec.md` (+ `.pdf`) | Draft v0.1 | Mold-design workflow + per-printer profile system for QuikBolus |

Each spec is paired: the markdown file is the source of truth; the PDF is a
rendered, printable companion (built via `C:\demo_videos\users_guides\build_*.py`).
Edit the `.md`, re-run the matching build script to refresh the `.pdf`.

When a spec is committed to a release, move it into the relevant product's
repo (e.g. `C:\Radiant_QuikBolus\docs\`) and replace the entry here with a
pointer.
