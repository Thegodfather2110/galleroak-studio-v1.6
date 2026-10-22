# GallerOak Studio changelog (formerly OmniStudio)

One place that records every update, newest first. Add a new section at the top for each release.
Each entry says what you get, where it lives in the files, and how it was checked.

Current version: **1.6.0**

---

## 1.6 (GallerOak Studio redesign)

**Renamed OmniStudio to GallerOak Studio** and redesigned the whole interface. No routes, APIs, integrations or stored data changed.
- **Brand:** new oak-tree and AI-node logo (`public/assets/`: `galleroak-mark.svg`, `favicon.svg`, `icon-512.png`, your full lockup `galleroak-logo-full.png`; inline version in `public/brand.js`). Animated boot screen, window title per view, favicon.
- **Design system** (`public/app.css`, rebuilt on tokens): black and white monochrome, dark and light themes, charcoal surfaces, silver borders, one set of buttons, inputs, cards, tabs, chips and switches used by every view.
- **Home** (new, `public/home.js`): an oak-and-hub map of every tool, live status tiles (gateway, combos, projects, chats, App Chatbot), recent chats that open in place, and the full gallery of tools. Read-only; it only uses existing GET routes.
- **Navigation:** collapsible sidebar (button or Ctrl/Cmd+B, remembered), tooltips on the collapsed rail, slide-in drawer with a top bar on phones, skip link, current page marked for screen readers.
- **Micro-interactions** (`public/ux.js`): animated dropdowns that replace every select (type to filter long model lists, arrow keys, Enter, Esc; the real select stays in the page so nothing else changed), custom tooltips, press ripples, request progress strip, fluid view transitions, animated dialogs and toasts, skeleton loaders, animated popovers.
- **Motion respect:** follows the system reduce-motion setting; Settings > Appearance has Theme and Motion switches (Follow system / Reduce motion).
- **Safe rename:** visible text, docs, console banner, `start.bat` and the package name changed. Kept on purpose so nothing breaks: `OMNISTUDIO_DATA`, `OMNISTUDIO_WORKSPACE`, `OMNISTUDIO_ALLOW_PRIVATE_FETCH`, the `os.` browser settings keys, the `omnistudio-chat` export format, the `omnistudio-storage` preview marker, ComfyUI output file prefix `OmniStudio`, and every mention of OmniRoute (a separate product). The customer-facing chat page of App Chatbot keeps showing each business's own name.
- Guide renamed to `GALLEROAK-STUDIO-GUIDE.md`.
- **Checked:** all 74 backend test groups and 25 ComfyUI tests pass unchanged; every view opened in a real browser (dark, light, collapsed rail, phone width) with no console errors.

---

## 1.5 (ComfyUI)

**New: ComfyUI tab** (Create section, below Video)
- Makes **images and videos** with the ComfyUI running on your computer (or on your network).
- Reads which nodes and models you have and builds ready-to-run workflows for the families it recognises: SD 1.5 / SDXL, Flux, Wan video.
- **Import workflow:** use your own ComfyUI "Export (API)" file. Prompt, negative prompt, seed, size, frames, frame rate and start image are found automatically. Editor-format files are refused with exact instructions.
- **Checked before sending:** a missing model or node is explained in plain words and nothing is queued.
- Live progress, **Stop** (queued or running), **Free VRAM**, readable GPU out-of-memory and validation errors, **Animate** (saved image to video), **Improve prompt** with your chat model, gallery with delete and prompt reuse.
- Optional access token for a protected ComfyUI; it stays on the server and is never sent to the browser.
- Files: `lib/comfy.js`, `public/comfy.js`, `test/comfy-tests.js`, `test/mock-comfy.js`. Routes `/api/comfy/*` and `/outputs/comfy/*`. Settings `comfy` in `data/config.json`. Data in `data/comfy/workflows` and `data/outputs/comfy`.

**Merged into one build**
- ComfyUI (from the ComfyUI zip) now sits together with Voice and faces, the roadmap chat upgrades and the App Chatbot gateway. Nothing was removed from either side; the changes were additive.
- `package.json` version is 1.5.0; `npm test` runs both suites.

**Checked**
- 74 backend test groups and 25 ComfyUI test groups pass.
- All 16 tabs open without errors in headless Chromium; a ComfyUI image was generated through the UI against a fake ComfyUI.
- Not tested: a real ComfyUI with real models, Windows.

---

## 1.4 (Voice, faces, chat upgrades, App Chatbot)

**Voice and hologram faces** (Talk section, new **Voice** tab)
- Five built-in characters (theGOd, Clutch, Sage, CODEX, TURNER) as software-3D hologram faces, plus a generated face for every combo you use. Each has its sign at the voice box, which pulses while it speaks or listens.
- Ears (speech to text) and voices (text to speech): the browser's free engines or your own OmniRoute `/audio/*` endpoints. Push to talk or hands-free, optional interrupt, say a name ("Clutch, ...") to switch character.
- Character editor (face, sign, colours, model/combo, voice). Faces also appear beside replies in Chat, Reasoning, Coding, Team and Computer.
- Files: `public/holo.js`, `public/voice.js`, `public/interact.js`, `lib/personas.js`, `lib/voice.js`, `lib/voice-text.js`. Routes `/api/personas`, `/api/voice/*`. Settings `voice`.

**Chat upgrades (from the roadmap)**
- Attachments (picker, drag and drop, paste) with server-side checks; limits are configurable (`uploads`).
- Reply actions: copy, read aloud, star/save, export, retry. Status line and Stop.
- Chat search, rename, export (Markdown, text, JSON), clear. Prompt chips and saved prompts. Keyboard shortcuts, scroll-to-latest, dictation mics in other tabs, reduced-motion support.
- Settings has a new **Chat & Interaction** section.
- Routes `/api/prompts`, `/api/chats/search`, `/api/saved`.

**App Chatbot** (Work section, new tab)
- Connects your own apps to OmniRoute as a customer-support chatbot in **English, Hindi (Devanagari) and Hinglish**, modelled on your Python "appai" gateway.
- One connector URL and secret key per app, OpenAI-compatible (`/c/<id>/v1/chat/completions`, streaming supported), `omni.language` and handoff flag in every reply.
- Auto language matching, per-app knowledge text, tone, greeting, hand-off message, persona, model, reply cap.
- Optional ready-made chat page with microphone and read-aloud (off by default).
- Dashboard: connection status, test chat, activity log, blocked addresses, revoke / restore / new key / delete.
- Safety: separate listener, off by default, local network only, port 8765; hashed keys shown once; same 401 for wrong key and unknown app; 5 failed attempts block an address for 15 minutes; rate and size limits; fixed model, no tools, client system messages dropped; customer messages never logged.
- Files: `lib/gateway.js`, `lib/gateway-page.js`, `lib/lang.js`, `public/gateway.js`, routes `/api/gateway/*`, data `data/gateway.json`, `data/gateway-events.jsonl`.

**Docs:** `OMNISTUDIO-GUIDE.md` written (every tab, MCP, connectors, REA, voice, App Chatbot).

**Checked:** 74 backend groups; Voice, chat features and the App Chatbot driven in headless Chromium. Not tested: real microphone, real speech services, Windows, live OmniRoute.

---

## 1.3 (REA, Apps, Connectors)

- **REA** tab: reverse engineering through an MCP server, driven by your OmniRoute models and combos, approval for every tool call, saved report.
- **Apps** tab: build working apps with the website builder; app data persists in the project folder and shows in a Data tab. Websites and Apps have separate galleries; old projects stay under Websites.
- **Connectors** tab: directory of MCP servers, custom local or remote servers, import from Claude Desktop / Cursor, per-tool permissions, and a Connectors button in the Chat, Reasoning and Coding composers.
- Zero-dependency MCP clients `lib/mcp.js` (local, with per-server environment) and `lib/mcp-http.js` (Streamable HTTP).
- Merged v1.2 + REA + Apps into one folder.

## 1.2

- Settings section buttons (Connection, Search, Judge, ...).
- Team roster has a Skills column per model; image, video, audio and embedding models marked non-text.
- Benchmark code runs under Node's permission mode on Node 20+.
- Computer: *Preview here* for HTML deliverables; empty model replies reported as errors.
- Runs list cached for speed.

## 1.1 and earlier (the base)

- OmniRoute connection and model/combo pickers (pinned combos first).
- Chat, Reasoning (thinking shown separately) and Coding modes with streaming and saved chats.
- Websites: named projects with live preview, code editor and device sizes.
- Video: prompt to `/videos/generations`, downloaded to your PC, gallery.
- Arena: one prompt to several models, ranked on quality, optional judge model.
- Skills: `.md` files per model or combo that models read and learn.
- Web search for the models (DuckDuckGo with no key; Serper, SerpAPI, Brave, SearXNG optional).
- Computer: a model with its own workspace, shell, editor and search, with per-command approval.
- Team: several models on one project with a lead, parallel tasks, reviewers and a final check.
- AutoTune and STM (semantic transformation modules); all files stored locally in `data/`.

---

### How to add the next entry
Copy the 1.5 block to the top, change the heading, list what changed and which files, and say how it was checked and what was not.
