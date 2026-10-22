# GallerOak Studio Guide (v1.5)

Everything GallerOak Studio does, how to set up each part, and how each one works step by step. It covers 1.3 (REA, Apps, Connectors), 1.4 (Voice, hologram faces, chat upgrades, App Chatbot) and 1.5 (ComfyUI).

GallerOak Studio is a local web app. You start it with Node.js 18 or newer, open `http://localhost:3210`, and it talks to your **OmniRoute** gateway using the models and combos you already made there. No Docker, no `npm install`.

---

## 1. Quick start

1. Install Node.js 18+.
2. Unzip `omnistudio-v1.5.zip`, then run `start.sh` (Mac/Linux) or `start.bat` (Windows). Or run `node server.js`.
3. Open `http://localhost:3210` (use `localhost`, not a LAN address, or the microphone will be blocked).
4. **Settings → Connection**: enter your OmniRoute address (default `http://localhost:20128/v1`) and API key, then **Save & test connection**.
5. Your models and combos appear in every picker. If a combo is missing, type its exact name under **Pinned combos**.
6. To try everything without a real gateway: `node test/mock-omniroute.js`, then connect to `http://localhost:20199/v1` with key `sk-test-key`.

Useful environment variables: `PORT` (another port), `OMNISTUDIO_DATA` (keep data in another folder).

## 2. Where everything is stored

All data is in `data/` next to `server.js`. It is plain files you can back up or copy.

| Path | Holds |
|---|---|
| `data/config.json` | Connection, default model per mode, search, agent, voice, REA settings. Your API key lives here and is never sent to the browser. |
| `data/personas.json` | Your characters (faces, signs, voices) |
| `data/prompts.json` | Your saved prompts |
| `data/connectors.json` | Your connectors and their secrets |
| `data/comfy/workflows/`, `data/outputs/comfy/` | ComfyUI: imported workflows, generated images and videos |
| `data/gateway.json`, `data/gateway-events.jsonl` | App Chatbot: your apps' connectors (key fingerprints only) and activity log |
| `data/chats/` | Saved conversations |
| `data/projects/<name>/` | Each website or app as a normal folder |
| `data/rea/<name>/` | Each REA investigation (`REPORT.md` and chat memory) |
| `data/skills/`, `data/skills-assign.json` | Skills and who has them |
| `data/workspaces/<task>/` | Everything the Computer and Team agents create |
| `data/runs/` | Logs of agent, team, REA and connector runs |
| `data/outputs/videos/` | Generated videos |
| `data/team.json` | Team roster and scores |

## 3. Every tab, and how to use it

### Voice (1.4)
Talk to your characters. See section 7 for setup and the full working process.

### Chat, Reasoning, Coding
- Pick a model or combo above the message box. Enter sends, Shift+Enter adds a line.
- **Settings** (in the bar): AutoTune on/off, temperature, top-p, thinking effort, max tokens, a custom system prompt, and *Search the web for each message*.
- **STM**: cleans replies after they arrive (code blocks are never changed).
- **Connectors**: tick which connectors this message may use (section 5).
- **Voice** toggle: replies are read aloud by their character. The **mic button** dictates into the box.
- Reasoning shows the model's thinking in a collapsible block. Coding keeps the temperature low and gives code blocks copy buttons.
- Chats are saved on the left. 👍/👎 on a reply teaches AutoTune.

### Chat upgrades (1.4)
How each one works, in order of use:
1. **Attach**: press the paperclip, drop files on the composer, or paste an image. Each file shows as a chip with size and a remove (✕) button; invalid files are refused with the reason. Nothing is read or sent until you press send.
2. **Send**: the browser reads the files then; the server checks type, size, count and image bytes again, builds the message (images as image parts, text files wrapped in `<attached_file>` tags and marked as data), and forwards it to your model. Nothing is written to disk. The chat shows the file names (and image thumbnails for this session); the saved chat keeps names and sizes only.
3. **While it answers**: the status line says what is happening; Stop or Esc cancels for real (the request to OmniRoute is aborted). If it fails, **Retry** asks again with the same message and files.
4. **After**: Copy, Read aloud (Pause / Resume / Stop; one reply at a time), Save (☆ → ★ Saved list), Export this reply, 👍/👎 for AutoTune, Regenerate.
5. **Find and keep**: search chats with Ctrl/⌘+K, rename with ✎, export a chat as `.md`, `.txt` or `.json` (no system prompts, keys or thinking), Clear to delete one.
6. **Prompts**: click a chip to fill the box (it never sends). *＋ Save prompt* stores the box text in `data/prompts.json`; *Manage* renames or deletes.
7. **Settings → Chat & Interaction**: faces, animation, density, text size, read-aloud default, speech rate and voice, recognition language, engines and upload limits (`uploads` in `data/config.json`: `maxFiles` 1-6, `maxFileMB` 1-5, `maxTextKB` 16-1024).

Not yet: PDF text extraction (PDFs are refused with a clear message), files together with connectors, files in the builder tabs, JSON import, model-written chat titles.

### Websites and Apps
1. Open the tab, press **New project**, describe what you want.
2. The model writes real `index.html`, CSS and JS files into `data/projects/<name>/`. Preview is live (desktop, tablet, mobile) and there is a built-in code editor.
3. Apps keep their `localStorage` data in the project folder; the **Data** tab shows it and can reset it.
4. Set the builder model in **Settings → Default model for each mode** (the app builder falls back to the website builder).

### REA
Reverse engineering with evidence (section 6).

### Video
Prompt → OmniRoute `POST {base}/videos/generations` → file downloaded and shown in a gallery. Queued providers are polled. **Improve prompt** rewrites a rough idea. Change the endpoint under Settings → video path.

### Computer
Gives a model its own workspace folder with a shell, file editor, web search and page reader.
1. Describe the task.
2. The model works step by step. Each shell command appears as a card: **Run it / Deny** (default).
3. Results land in `data/workspaces/<task>/`.
The shell is not a sandbox. Keep *Ask me before each command* on for models you do not trust.

### Team
Several models on one project: a lead plans, tasks go to the best free model per skill, another model reviews every result, a final check joins the parts, and `TEAM_REPORT.md` explains who did what. Set it up under **Team → Roster** (switch models on, set scores or press **Benchmark**).

### Arena
Send one prompt to several models at once and rank them on quality (completeness, relevance, structure, cleanliness, speed). Add a judge model in Settings for a blended score.

### Skills
Plain `.md` files (rules, knowledge, checklists) added to a model's system prompt. Upload per model, or tick *Everyone*.

### Connectors
Section 5.

### Settings
Connection, default model per mode, pinned combos, web search provider (DuckDuckGo needs nothing; Serper/SerpAPI give real Google results with a key), agent defaults, video path, AutoTune, STM, theme.

---

## 4. MCP in one page

MCP (Model Context Protocol) is how a model reaches tools. An MCP **server** exposes tools; GallerOak Studio is the **client**. It has two transports:

- **Local (stdio)**: GallerOak Studio starts a command on your computer (for example `npx -y @modelcontextprotocol/server-filesystem C:\work`) and talks to it over standard input/output. Code: `lib/mcp.js`.
- **Remote (Streamable HTTP)**: GallerOak Studio calls a URL, with headers for authentication such as `Authorization: Bearer …`. Code: `lib/mcp-http.js`. OAuth sign-in and the older SSE-only transport are not built in.

How a model uses a tool (the same for every model, with or without native function calling):
1. GallerOak Studio adds the list of tools to the system prompt.
2. The model writes a tag: `<tool name="server__toolname">{"arg": "value"}</tool>`.
3. GallerOak Studio checks the permission, asks you if needed, runs the call, and gives the result back as data.
4. The model reads the result and continues, up to `connectors.maxSteps` calls (default 15), then must answer.

Tool results are treated as data, never as instructions.

---

## 5. Connectors: setup and working process

### Setup
**Option A: Directory.** Connectors → Directory → **Add** on one of: Filesystem, Web fetch, Brave Search, GitHub, Context7 docs, Browser (Playwright), Memory, Sequential thinking, Time, REA. Fill in what it asks (a folder, or a key). `npx` servers download on first use; Web fetch and Time need [uv](https://docs.astral.sh/uv/) for `uvx`. It connects and lists its tools.

**Option B: Custom.** Connectors → **Add custom**.
- Local: name, command (e.g. `npx`), arguments (e.g. `-y @modelcontextprotocol/server-memory`), optional folder, environment variables (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`).
- Remote: name, URL (e.g. `https://example.com/mcp`), headers.

**Option C: Import.** Connectors → **Import**. GallerOak Studio finds servers already set up in Claude Desktop, Cursor and Claude Code, or you paste JSON like this:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/work"] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" } },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer xxx" } }
  }
}
```
Imports start switched off so you can check them first. Secret values stay on the server.

Where Claude Desktop's own file is (the one Import reads): Windows `%APPDATA%\Claude\claude_desktop_config.json`, Mac `~/Library/Application Support/Claude/claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`. Cursor: `~/.cursor/mcp.json`.

### What gets saved
`data/connectors.json`:
```json
{ "connectors": [ { "id": "github", "name": "GitHub", "type": "stdio", "command": "npx", "args": "-y @modelcontextprotocol/server-github", "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" }, "approve": "confirm", "toolPolicy": {}, "enabled": true } ] }
```
The browser only ever sees the *names* of secrets. Set `connectors.maxSteps` and `connectors.callTimeoutSec` in `data/config.json`.

### Working process
1. Add and switch on a connector. Press **Manage → Test** to connect and see its tools.
2. Set permissions: *Ask before tools that change things* (read-only tools run on their own), *Ask before every tool call*, or *Allow every tool*. Per tool: Default, Ask first, Allow or Off.
3. In Chat, Reasoning or Coding press **Connectors** in the composer and tick what this message may use.
4. Send. The model picks a tool, GallerOak Studio asks you if the rule says so (**Allow / Deny**), runs it, returns the result.
5. The reply shows a **Connector activity** block with every call and result, saved with the chat.

Troubleshooting: *command not found* means Node/uv is missing or not on PATH; an `npx` server that hangs the first time is downloading; a remote 401 means the header is wrong; if the test times out, raise `callTimeoutSec`.

---

## 6. REA: setup and working process

[REA](https://github.com/morluto/rea) ("Reverse Engineer Anything") is an MCP server of analysis tools. Your OmniRoute models drive it. REA needs no model of its own.

### Setup
1. Install REA once: `npx -y rea-agents setup --yes` (aimed at macOS).
2. Open **REA** → **Set up connection**. Press **Detect from other apps** to copy the exact command REA's setup wrote into Claude Desktop, Cursor or Claude Code, or type the command yourself. The default is a best guess:

```json
"rea": { "command": "npx", "args": "-y rea-agents mcp", "cwd": "", "approve": "confirm", "maxSteps": 40, "callTimeoutSec": 600 }
```
(in `data/config.json`). If **Save & test connection** fails, use Detect or check REA's own docs for the start command.

### Working process
1. **New investigation**: a name, the path of the target on this computer, and what you want to know.
2. Pick the model or combo (top right) and describe the task.
3. The model calls REA tools one step at a time. By default you approve each call (switch to automatic under the chat box).
4. Findings go into a **Report**. Copy it or download it as Markdown. Follow-ups keep the context.
5. Files: `data/rea/<name>/REPORT.md`, run logs in `data/runs/`.

REA runs as you, with your permissions. Analyse only software you own or may analyse. The same tools are also available as the *REA* connector in any chat.

---

## 7. Voice and faces (1.4)

### What you get
- Five characters with their own 3D hologram faces, colours, signs and voices: **theGOd** (gold, target), **Clutch** (purple, split ring), **Sage** (green, eye), **CODEX** (blue, star), **TURNER** (red, camera aperture).
- A generated face for every combo or pinned model you use (the same name always gives the same face).
- Each character's **sign sits at its voice box** (the throat). It breathes when idle, spins while thinking, pulses with the voice while speaking, and sends rings inward while it hears you.
- Ears (speech to text) and voices (text to speech), per character.

### Setup
1. Open **Voice**. Allow the microphone when the browser asks. It only works on `http://localhost` or HTTPS.
2. Make sure a chat model is set (Settings, or edit a character and choose its model).
3. **Voice settings**:
   - Ears: *Browser* (free, Chrome or Edge) or *OmniRoute* (`/audio/transcriptions`, model `whisper-1`).
   - Voices: *Browser* (free, different per character) or *OmniRoute* (`/audio/speech`, model `tts-1`, voice names alloy, echo, fable, onyx, nova, shimmer).
   - Language, for example `en-US`, `en-IN`, `hi-IN`.
   - *Let me interrupt*: only with headphones.
4. Stored in `data/config.json`:
```json
"voice": { "stt": { "engine": "browser", "language": "", "model": "whisper-1", "path": "/audio/transcriptions" },
           "tts": { "engine": "browser", "model": "tts-1", "path": "/audio/speech", "format": "mp3" }, "interrupt": false }
```

### Working process
1. **Push to talk**: press **Talk**, speak, and press it again (or pause; OmniRoute ears stop by silence). **Hands-free**: always listening, each sentence goes out when you stop speaking.
2. Your words are transcribed (browser service, or recorded and sent to OmniRoute through the server).
3. If the sentence starts with a name ("Sage, …", "hey Clutch, …"), that character takes over. Aliases are accepted ("kodex").
4. The character's model gets its role prompt, your extra personality text, and the recent conversation, and is told to answer in short spoken sentences.
5. The reply streams in. As each sentence completes it is cleaned (no markdown, links, emoji), code blocks are skipped with one short note, and the sentence is spoken while the next is still arriving.
6. The mouth opens to the loudness of the voice (real audio level for OmniRoute voices, estimated for browser voices). While it talks, the microphone is paused so it does not hear itself.
7. Chat, Reasoning and Coding use the same ears and voice: the mic button dictates, the **Voice** toggle reads replies aloud with a small floating face.

### Edit or create a character
**Edit character** (or **New character**): name, tagline, colour, sign, role, model or combo, aliases, horns, hair, eyes, extras (headphones, scar, gem), face sliders, voice (browser voice, OmniRoute voice name, pitch, speed), extra personality text, live preview, **Test voice**, **Surprise me**. Built-ins can be edited and **Reset to original**; your own can be deleted. On a combo face, **Make persona** keeps and customises it.

### Troubleshooting
- *No sound*: the browser blocks audio until you click something on the page; press Talk or Send once. Check the system volume and the character's volume.
- *Mic blocked*: allow it in the address bar. A LAN address is not a secure context; use `localhost`.
- *Browser engine says network error*: Chrome's recogniser needs internet. Switch Ears to OmniRoute.
- *OmniRoute 404 on audio*: your gateway may not offer those endpoints; check the paths and models in Voice settings, or use the browser engine.
- *Character hears itself*: use headphones, or leave *interrupt* off.

---

## 8. App Chatbot: connect your own apps (Hindi, Hinglish, English)

The **App Chatbot** tab turns GallerOak Studio into a small gateway for your own apps. Each app gets a **connector URL and a secret key**. The app sends customer messages to that URL and gets a reply from your OmniRoute model or combo, in the customer's own language.

### Setup in five steps
1. Open **App Chatbot**. Click **Turn on the gateway** (or Settings → tick *Gateway on* → *Save and apply*). It listens on port `8765` on your WiFi/LAN. GallerOak Studio itself stays on `127.0.0.1`.
2. In **Settings** pick the **default model or combo** (or leave it to use the Chat model from Settings).
3. **Apps → + Connect a new app.** Give it a name and the business name. The dialog shows the **connector URL** and the **key once**. Copy both.
4. Paste the URL and key into your app. Any OpenAI SDK works; the dialog has ready curl, Python and JavaScript examples.
5. Press **Settings** on the app card: choose the language, tone, and type what the bot should know (opening hours, delivery, returns, prices, FAQs).

### Languages
| Setting | What the customer gets |
|---|---|
| Auto (default) | The bot answers in what the customer writes: Hindi in Devanagari, Hinglish in Roman letters (WhatsApp style) or English. If they switch, the bot switches. Very short messages ("ok") keep the language of the chat. |
| English / Hindi / Hinglish | Always that language. |

Every reply includes `omni.language` (`en`, `hi`, `hinglish`) in the JSON and an `X-Language` header.

### Hand-off to a human
If the customer asks for a person ("insaan se baat karni hai", "manager se baat karwao", "I want a human", "मुझे मैनेजर से बात करनी है") the reply carries `omni.handoff: true` and the header `X-Handoff: 1`, and the bot says your hand-off message. Your app can use that flag to notify staff. Handoffs show in Activity and in the counters.

### Endpoints (OpenAI-compatible)
| Call | What it does |
|---|---|
| `GET /c/<id>/v1/ping` | Checks the key; marks the app connected |
| `GET /c/<id>/v1/models` | Returns the single model name |
| `POST /c/<id>/v1/chat/completions` | `{"messages":[{"role":"user","content":"..."}]}`, add `"stream": true` for live text |
| `GET /c/<id>/chat` | Ready-made chat page with a language picker, microphone and read-aloud (only if you switch it on) |

Send the key as `Authorization: Bearer gk_...`. Send the last few messages of the conversation each time; the gateway keeps no customer history.

### Safety rules built in
- Keys are stored only as a fingerprint and shown once. Lost key: **New key** (the old one stops).
- Wrong key and unknown app get the same answer. Five failed attempts block that address for 15 minutes (Activity → Unblock).
- Only devices on your local network can connect, unless you tick *accept connections from outside* (do that only behind a firewall or tunnel).
- Limits: 60 requests per minute per app, 12 per visitor on the chat page, 256 KB per request, 60 messages, 8000 characters per message.
- The app cannot choose the model, add tools or replace the instructions: its own `system` messages are dropped, the model is fixed by you, reply length is capped.
- **Customer messages are never written to the activity log.** Only events (connected, handoff, failed key, new address, rate limited...).
- The chat page needs no key, so it is off by default, local-network only, rate limited, and uses a strict content policy. Browser apps on another website need that site listed under *Allowed websites*.
- Revoke switches one app off at once; Delete removes it.

### Files
`data/gateway.json` (settings and key fingerprints), `data/gateway-events.jsonl` (activity, newest 5000 kept).

---

## 9. ComfyUI: images and videos on your own computer (1.5)

**Setup**
1. Start ComfyUI as usual. Its window shows an address, normally `http://127.0.0.1:8188` (ComfyUI Desktop uses the same).
2. Open the **ComfyUI** tab. It connects by itself and shows the version, your graphics card, free video memory and queue. If ComfyUI is elsewhere, open **Connection**, enter the address (and an access token if you protect it) and save. The token stays on this PC.
3. Pick **Images** or **Videos**, pick a workflow, write the prompt, press **Generate**.

**How it works**
- GallerOak Studio asks ComfyUI which nodes and models you have and builds ready-to-run workflows for the families it recognises (SD 1.5 / SDXL, Flux, Wan video where the nodes exist).
- Every workflow is checked against your real ComfyUI before it is sent. A missing model or node is explained in plain words and nothing is queued.
- Progress is live (step and node). **Stop** removes a queued job or interrupts a running one. **Free VRAM** unloads models. GPU out-of-memory errors come with what to try.
- Results are saved in `data/outputs/comfy` and shown in the gallery. Each result remembers its prompt and workflow; **Animate** turns a saved image into a video.
- **Improve prompt** rewrites a rough idea with your chat model.

**Your own workflow** (other models, image to video, Wan 2.2)
1. In ComfyUI make a workflow that ends in a Save Image or Save Video node.
2. Menu **Workflow → Export (API)**.
3. In GallerOak Studio press **Import workflow** and pick the file. It finds prompt, negative prompt, seed, size, frames, frame rate and start image on its own. Files are kept in `data/comfy/workflows`.

**Good to know:** no `--listen` or CORS settings are needed because GallerOak Studio's server talks to ComfyUI, not your browser. Live progress uses Node 22+ WebSocket; on Node 18/20 it polls once a second.

---

## 10. Security in short
- The server listens on `127.0.0.1` only; other websites' requests are rejected (host and origin checks, JSON-only writes).
- Your API key and connector secrets never go to the browser.
- Generated sites and apps preview in a sandbox.
- A local connector runs as you. Only add servers you trust.
- The App Chatbot gateway is a separate listener, off by default, local network only (see section 8).
- Voice audio is only sent where you choose: the browser's speech service, or your OmniRoute.

## 11. Tests
`npm test` runs 74 backend groups against a fake OmniRoute and 25 ComfyUI groups against a fake ComfyUI. All tabs and a ComfyUI image run were also driven in headless Chromium. The Voice tab was also driven in headless Chromium with a fake microphone. Not tested: Windows, a real microphone, real speech services, Firefox or Safari, a live OmniRoute, a real ComfyUI with real models, or the real directory servers.
