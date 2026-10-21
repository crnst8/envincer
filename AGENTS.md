# AGENTS.md

Notes for coding agents working in this repo.

Read [`.claude/skills/envincer/SKILL.md`](.claude/skills/envincer/SKILL.md)
before changing code. It covers what envincer does, where each concern lives,
the data shapes, and the traps.

## House rules

- Node 22.3+, CommonJS, no framework, no bundler, no build step. The UI is
  plain DOM in `public/app.js`; build nodes with `h()`, never `innerHTML` with
  page or LLM text.
- Runtime dependencies are `playwright-core` and `sharp`. Do not add more
  without a reason that the existing two cannot cover.
- Every LLM path has a deterministic fallback in `server/planner.js`. Keep it
  that way: the tool must work with no `OPENCODE_API_KEY`.
- Never print, commit or document the OpenCode key value. It lives in `.env`
  (ignored). Document env vars by key name only.
- `./dev.sh check` (`npm test`) before calling anything done. Tests need
  Chromium and tesseract.
- Mannered prose is banned in docs and UI text. Say what you mean. The UI has
  no explanatory copy.
- The repo is public. `STATUS.md`, `.env`, `data/` and `public/fonts/` stay
  out of git; check `git status` for anything host-specific before committing.
- Update the skill when a module changes job, a route is added or removed, the
  shot/target schema changes, or an env var is added.
