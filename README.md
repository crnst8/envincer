# envincer

Screenshots of a web app at the right sizes, from a prompt.

Enter a URL and say what the images are for ("full suite for a GitHub README",
"App Store screenshots", "social cards in dark mode"). envincer reads the page,
plans which features to shoot and at which sizes, takes the screenshots with
Playwright, puts them in device frames or a browser window, checks them, and
shows them for approval. Adjust any shot in plain English ("hide the chat
widget", "scroll to pricing", "dark mode", "1440x900 2x") and it is retaken.
Download the approved set as a zip with a `manifest.json` and a `snippet.md` of
README-ready image tags.

## Run

```sh
npm install
cp .env.example .env      # optional: add OPENCODE_API_KEY
./dev.sh start            # http://127.0.0.1:4190 and http://<tailscale-ip>:4190
./dev.sh check            # tests
```

Fonts are optional: put `NeueHaasTextRegular.woff2`, `NeueHaasTextMedium.woff2`
and `PaperMono.woff2` in `public/fonts/` if you have them; otherwise the UI uses
system fonts.

Needs Node 22.3+, Chromium (`/usr/bin/chromium`) and `tesseract-ocr`
(`sudo apt-get install tesseract-ocr`). Without `OPENCODE_API_KEY` everything
works except AI review; planning, adjusting and preset drafts fall back to
keyword rules.

`./dev.sh` commands: `start`, `stop`, `restart`, `status`, `logs`, `check`.

## Use

1. **Shoot** — URL, prompt, optional preset. **Plan** shows the features
   (pages, sections) and targets (sizes, frames, formats); untick, edit or add
   any of them, then shoot. **Plan & shoot** skips the review step.
2. **Review** — each shot shows its size, file size and automatic findings:
   HTTP errors, blank captures, sideways scroll, broken images, clipped text,
   failed assets, and OCR legibility at the size the image will be shown.
   **Step through** opens a full-size view: `←`/`→` move, `A` approves, `R`
   retakes, `Z` zooms, and the adjust box takes an instruction.
3. **Download approved** — zip of the final images under clean names.

Presets are lists of targets. Eight are built in (GitHub README, App Store,
Google Play, Social cards, Responsive check, Device mockups, Full page,
Light + dark). Make new ones by describing them, copying a built-in, or saving
a run's targets.

Device templates are PNGs whose screen is a transparent hole. Three generic
frames ship in `devices/` (drawn by `tools/make-devices.js`). Upload more on
the Presets page, or drop PNGs into `data/devices/`; the screen area is found
automatically, and a file named `iphone.png`, `ipad.png` or `laptop.png`
replaces the built-in frame of that name.

### CLI

```sh
node bin/envincer.js https://example.com "github readme" --out shots/
node bin/envincer.js example.com --preset app-store --review
node bin/envincer.js example.com "social cards" --plan-only   # print the plan JSON
```

The CLI writes the images, `manifest.json`, `snippet.md` and `run.json`, and the
run also appears in the web UI.

## How it works

| Step | Tool |
|---|---|
| Read the page: nav links, sections, toggles, dark-mode CSS, preview image | Playwright (`server/capture.js`) |
| Plan features × targets from the prompt | OpenCode Go LLM, or keyword rules (`server/planner.js`) |
| Capture: viewport, DPR, mobile UA, colour scheme, actions, hidden elements, cookie banners hidden | Playwright |
| Frame: device template, browser window, rounded; status bar for phones; laptop+phone combo | sharp (`server/compose.js`) |
| Check: DOM checks, OCR legibility at display size | Playwright, tesseract (`server/ocr.js`) |
| Review: vision model looks for spinners, overlays, cut-off content and suggests a fix | OpenCode Go LLM |

Data is files: runs in `data/runs/<id>/`, user presets in `data/presets.json`,
uploaded templates in `data/devices/`.

## Configuration

See [`.env.example`](.env.example) for every key. The default model is
`claude-haiku-5-5` (vision, cheapest tier); the reasoning is in
`server/llm.js`.

## Limits

- The server fetches any URL it is given, including localhost (so it can shoot
  dev servers). It binds to localhost and the Tailscale address only; set
  `ENVINCER_PASSWORD` before binding anywhere else.
- Login-gated pages need `setup` actions in the plan JSON (goto, fill, click).
- Full-page captures stop at 16,000 px.
