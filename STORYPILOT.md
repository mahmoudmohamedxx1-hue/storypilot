# StoryPilot — Continuous Video Factory (videos non-stop)

This repo makes videos **CONTINUOUSLY** — one after another, back to back, 24/7.
The total count just keeps climbing (…12, 13, 14 … 20 … and beyond). Nothing is
scheduled by the clock:

1. **Continuous Video Factory (`.github/workflows/factory.yml`)** — runs ~5h jobs on
   GitHub Actions that **chain themselves**: near the end of its time budget a run
   dispatches + VERIFIES its successor (5 retries), so the loop never ends. Inside a
   run, `scripts/factory.py` renders pending stories back-to-back with no cap.
2. **The KEYLESS AI WRITES THE HYPERFRAME CODE** — for every story, `scripts/ai_forge.py`
   asks a keyless AI (freellmpool pool first: `auto`, gpt-oss-120b, Qwen3-Coder… then the
   Pollinations text API — no API keys anywhere) to write a COMPLETE Python renderer for that
   specific story: 1080×1920 @ 60fps hyperframes, Edge-TTS narration (ar-EG-ShakirNeural),
   shaped Arabic RTL text, keyless AI scene imagery, ken-burns motion, ffmpeg-pipe streaming.
   The forge sandbox-runs the AI-written script, validates the MP4 with ffprobe, and feeds any
   error back to the AI for a **self-repair** round (3 attempts). The battle-tested built-in
   renderer is the final fallback, so **a video ALWAYS comes out**. Whichever model actually
   wrote the code is recorded in `meta.json`.
3. **Infinite stories** — every sheet tab is re-synced mid-run (Spark edits are picked up,
   hash-tracked in `state/videos.json` so nothing is re-rendered). Pending sheet stories
   render first; when the queue is empty and `INFINITE_STORIES=true` (default), the keyless
   AI invents a **fresh story every time** (rotating Arabic finance topics, no repeats, retry
   ×3, emergency builtin story bank as fallback) so production never stalls. Set
   `INFINITE_STORIES=false` to render only what the sheet holds.
4. **Publish everywhere** — every finished video posts to YouTube, TikTok and Instagram Reels
   (each platform activates as soon as its secrets exist).
5. **Google Drive sync, every hour** — finished videos upload right after they render and a
   sync pass runs at least once per hour (`DRIVE_SYNC_INTERVAL`, default 3600s; deduped in
   `state/drive_sync.json`). One-time 3-minute setup via your own Apps Script web app —
   see **Google Drive backup** below.

`hourly-video.yml` is the **manual/on-demand** renderer (the app's Library **Make video**
button and manual batch catch-up on 3 parallel workers) — it has **no cron**.

## Reliability layers (the loop never silently dies)

| Layer | What it does |
|---|---|
| Self-chaining | every run dispatches + VERIFIES its successor (5 retries, REST fallback) |
| `*/15` cron backstop | factory.yml re-ticks every 15 min; the singleton guard turns noise into no-ops |
| ensure-factory.yml | `*/20` watcher — re-dispatches the factory when no run is alive for 25+ min (and it is not stopped) |
| App heartbeat | while the StoryPilot app runs: revives the loop when it looks dead |
| Singleton guard + concurrency group | never two factories at once; queued noise auto-collapses |

**STOP everything:** create the file `state/FACTORY_STOP` in the repo (or ask the app:
"stop the factory") — the current run finishes its video and does NOT chain. Remove the file
(or "start the factory") to resume. Disabling the workflow also stops everything.

## Files

| File | Purpose |
|---|---|
| `.github/workflows/factory.yml` | **THE continuous factory** — self-chaining ~5h runs + `*/15` backstop |
| `.github/workflows/ensure-factory.yml` | Loop watcher — revives a dead chain at `*/20` |
| `scripts/factory.py` | Continuous supervisor: sync → forge back-to-back → invent when empty → chain |
| `scripts/ai_forge.py` | **Keyless AI code-writer**: AI writes the hyperframe renderer per story, sandbox-run + self-repair + fallback |
| `scripts/drive_sync.py` | Hourly Google Drive upload of every finished video (deduped, never blocks rendering) |
| `scripts/drive_webapp.js` | The Apps Script you paste into script.google.com (one-time Drive setup) |
| `.github/workflows/hourly-video.yml` | Manual/on-demand renders (single story / batch catch-up, 3 parallel workers) |
| `scripts/render_pending.py` | Batch queue used by hourly-video (same parser/state as the factory) |
| `scripts/generate_story.py` | Single-story source: Google Sheet (tolerant parser) → keyless AI → fallback |
| `generate_video.py` | Built-in cinematic renderer (the guaranteed fallback): `story.json` → 1080×1920 60fps MP4 |
| `state/videos*.json` | Render state committed by the bot — which stories already have videos (the factory reads the UNION of videos.json + every shard file) |
| `state/factory_status.json` | Live factory status (phase, current story, queue depth, videos total, Drive sync) — refreshed continuously, read by the app |
| `state/drive_sync.json` | Drive sync dedup state — which video folders were already uploaded |
| `fonts/` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| `post_video.py` | Posts to YouTube / TikTok / Instagram |
| `requirements.txt` | Python dependencies (all free / keyless) |
| `web/` | The full Kimi-style agent app (Next.js) source |

## Secrets (Settings → Secrets and variables → Actions)

Add only what you need — every platform is optional and skipped gracefully:

| Secret | Platform | How to get it |
|---|---|---|
| `YOUTUBE_REFRESH_TOKEN` | YouTube | OAuth playground with `youtube.upload` scope |
| `YOUTUBE_CLIENT_ID` | YouTube | Google Cloud Console → OAuth client |
| `YOUTUBE_CLIENT_SECRET` | YouTube | Google Cloud Console → OAuth client |
| `TIKTOK_ACCESS_TOKEN` | TikTok | TikTok for Developers → Content Posting API |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram | Meta Graph API (IG business account) |
| `INSTAGRAM_USER_ID` | Instagram | Your Instagram Business account id |
| `DRIVE_WEBAPP_URL` | Google Drive | The `/exec` URL of your Apps Script web app (see below) |
| `DRIVE_WEBAPP_KEY` | Google Drive | Optional shared secret you set as `KEY` in the Apps Script |

### Google Drive backup (one-time, ~3 minutes, no OAuth keys)

Every finished video lands in **StoryPilot Videos / <date> <title> [<id>]/** in your Drive,
synced at least once per hour while the factory runs. Setup:

1. Open [script.google.com](https://script.google.com) (the account that owns the Spark sheet) → **New project**.
2. Delete everything in `Code.gs` and paste the contents of `scripts/drive_webapp.js` from this repo.
3. *(Optional)* set `KEY` in the script to a long random string — you will reuse it as the `DRIVE_WEBAPP_KEY` secret.
4. **Deploy → New deployment → Web app**: *Execute as*: **Me**, *Who has access*: **Anyone** → Deploy → authorize the Drive scope → copy the **/exec URL**.
5. Put that URL in the `DRIVE_WEBAPP_URL` secret (repo settings, or paste it in the app's **Platforms → Google Drive** card and hit *Save & push secrets*).

Done — each video bundle (`output.mp4`, `meta.json`, `story.json`,
`thumb.jpg`, `ai_renderer.py`) is synced hourly and at the end of every run.
Failed uploads retry on the next pass and never block video production.

### Optional repository variables

| Variable | Default | Meaning |
|---|---|---|
| `INFINITE_STORIES` | `true` | Keyless AI invents fresh stories whenever the queue is empty |
| `INVENT_ATTEMPTS` | `3` | Invention retries before falling back to the builtin story bank |
| `FLP_MODEL` | `auto` | Keyless model tried first for code/story writing (freellmpool) |
| `AI_ATTEMPTS` | `3` | Self-repair rounds when the AI-written renderer fails |
| `FACTORY_BUDGET_MIN` | `300` | Minutes per run before chaining the next |
| `SHEET_ID` | the Spark sheet | Google Sheet id with the stories |
| `TTS_VOICE_AR` | `ar-EG-ShakirNeural` | Edge-TTS Arabic voice |
| `ENABLE_AI_IMAGES` | `true` | Keyless AI scene imagery (Pollinations) |
| `IMAGE_MODEL` | `flux` | Pollinations image model (`flux` / `turbo`) |
| `FRAME_RATE` | `60` | Hyperframes — 60fps silky motion (set `24` for the old rate) |
| `DRIVE_ROOT_FOLDER` | `StoryPilot Videos` | Drive folder name for the video backup |
| `DRIVE_SYNC_INTERVAL` | `3600` | Seconds between Drive sync passes (the hourly sync) |
| `YOUTUBE_PRIVACY` | `public` | `public` / `unlisted` / `private` |
| `TIKTOK_PRIVACY` | `SELF_ONLY` | `SELF_ONLY` until your TikTok app is approved |

## Run it now

Actions tab → **Continuous Video Factory** → **Run workflow** — a run starts immediately,
renders back-to-back and chains the next one, so the loop is live from that moment on.
**Stop everything:** create the file `state/FACTORY_STOP` (or ask the app: "stop the
factory") or disable the workflow.

Every run leaves its rendered MP4s (one folder per video: `output.mp4`, `meta.json`,
`thumb.jpg`, `story.json` and `ai_renderer.py` — the code the AI wrote) in the
**factory-videos** artifact (14-day retention), and commits the render state + live factory
status back to this repo.
## Story sheet


https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit

EVERY non-code tab is parsed tolerantly (English or Arabic labels, any column order):
label rows for Title / Logline / Genre / Duration, a scene table whose columns are
detected by keyword (time, visual, prompt, voiceover, sfx — Arabic or English), and an
optional complete-narration section. If parsing finds no scenes, the pipeline falls
back to a keyless AI story so it never breaks.
