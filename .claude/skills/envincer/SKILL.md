---
name: envincer
description: Orientation for the "envincer" repo — a self-hosted tool that takes screenshots of a web app at preset resolutions from a plain-English prompt, frames them in device templates or a browser window, checks them with DOM checks and tesseract OCR, optionally reviews them with an OpenCode Go vision model, and lets the user approve, adjust in plain English, and download a zip. Node + node:http + playwright-core + sharp, vanilla JS UI, files on disk. Consult this skill BEFORE reading or changing code here, and whenever a request touches: planning (features × targets), presets, device templates or screen detection, capture actions, cookie-banner hiding, status bar drawing, compose/framing/combo, OCR legibility, the LLM client or model choice, the run/shot lifecycle, the API routes, the zip/manifest/snippet export, the CLI, or `./dev.sh`. It does NOT restate current code; read the named file for detail.
---

# envincer

Prompt → plan → shoot → check → approve/adjust → zip. Default port 4190,
bound to 127.0.0.1 and the Tailscale address when there is one.

## Where things live

| File | Job |
|---|---|
| `server/index.js` | HTTP server, all `/api/*` routes, static files, optional Basic auth, one listener per bind address. |
| `server/capture.js` | Playwright: `discover(url)` (links, sections, toggles, dark-mode CSS, preview JPEG) and `shoot(shot)` (raw PNG + DOM checks). Shared Chromium, global concurrency limiter. |
| `server/compose.js` | sharp: device frame, browser window, rounded, drawn status bar, laptop+phone combo, `finish()` (padding, background, exact canvas, width, format). |
| `server/devices.js` | Device templates from `devices/*.png` (built in) and `data/devices/*.png` (uploaded; same id overrides the built-in). Screen = flood fill of transparent pixels from the centre. |
| `tools/make-devices.js` | Draws the built-in frames in `devices/`. Rerun after changing it; the screen holes are sized to 393×852, 820×1180 and 1440×900. |
| `server/planner.js` | Schema normalisation (`normTarget`, `normFeature`, `normPlan`), `expand()` to shots, LLM prompts for plan/adjust/review/preset, deterministic fallbacks, `findings()`. |
| `server/llm.js` | OpenCode Go client: Messages, Responses or Chat Completions by model name. Model choice and reasoning are in the header comment. |
| `server/ocr.js` | tesseract CLI; legibility = words read at displayed size ÷ words read at 1.5× CSS size. |
| `server/runs.js` | Run lifecycle: create, queue, shoot, OCR, auto-review/auto-fix, adjust, edit, restore version, duplicate, export entries. |
| `server/store.js` | JSON files: user presets, runs (`data/runs/<id>/run.json` + images), stored-zip writer. |
| `server/presets-builtin.js` | The eight built-in presets. |
| `public/app.js` | The whole UI: Shoot (form + plan editor), Run (cards, lightbox, polling), Runs, Presets (+ device templates). |
| `bin/envincer.js` | CLI: same pipeline without the server. |
| `test/envincer.test.js` | node:test; fixture site, mock OpenCode server. |

## Data shapes

- **Target** (size/frame/format) and **Feature** (path, selector, actions,
  hide) are documented in the `SCHEMA` string in `server/planner.js`; that
  string is also what the LLM sees. A **shot** is feature × target, flattened,
  plus status, version, image, thumb, checks, ocr, findings, review, history.
- A **preset** is `{ id, name, description, targets }`. Built-ins are
  read-only; copies go to `data/presets.json`.

## Traps

- With a device, viewport height is derived from the template screen minus the
  status bar (`devices.js` defaults, `normTarget`). Do not let callers set it.
- `hide` and selectors go through Playwright locators, not CSS, so `text=` and
  `:has-text()` work. `document.querySelector` cannot take them.
- A shot's status becomes `done` only after OCR and findings are written; the
  CLI and tests wait on that.
- `expand()` must set `name`/`feature`/`target` after spreading the feature, or
  the feature name overwrites the shot name.
- OCR legibility assumes a 2× viewer (`ENVINCER_VIEWER_DPR`). At 1× every
  laptop mockup at README width reads as illegible.
- OpenCode Go wants `x-opencode-session` per conversation and a non-generic
  user agent; `llm.js` sends the run id and `envincer/0.1`.
- `STATUS.md` is excluded via `.git/info/exclude` (public repo; it holds host details). Recreate the exclude line in a fresh clone.
- `public/fonts/` is ignored; the fonts are not redistributable. The CSS falls back to system fonts.
- `pkill -f "node server/index.js"` from a shell whose command line contains
  that string kills the shell. Use `./dev.sh stop` (pidfile).

## Commands

`./dev.sh start|stop|restart|status|logs|check`; `node bin/envincer.js URL
"prompt" [--preset ID] [--out DIR] [--review] [--plan-only]`.
