# StoryPilot — Continuous Story Video Factory

This repo renders **every story in the Google Sheet into a video**, continuously:

1. **Continuous factory (THE LOOP)**: `.github/workflows/factory.yml` runs up to
   ~5h per run, rendering nonstop. Near the end of its budget it **chains the next
   run** — dispatch is VERIFIED (retried 5× until a successor run actually exists),
   so the loop never silently dies. Backstops: `*/15` cron heartbeat,
   `ensure-factory.yml` (`*/20` watcher), `hourly-video.yml` cron + `ensure-hourly.yml`,
   and the app heartbeat. When the sheet queue is empty and `INFINITE_STORIES=true`,
   the keyless AI **invents a fresh 10-scene story** and forges it — production never
   stops. Stop: create `state/FACTORY_STOP` (app chat: *"stop the factory"*).
2. **AI Hyperframe Forge**: for every story, the keyless AI **WRITES the renderer
   code** (`scripts/ai_forge.py`: freellmpool → llm7/Pollinations, self-repair loop,
   ffprobe validation) and we run it — the built-in cinematic renderer is the
   guaranteed fallback, so a video ALWAYS gets produced.
3. **Keyless AI everywhere**: [freellmpool](https://github.com/0xzr/freellmpool)
   polishes each story's voiceovers (tighter pacing, stronger hooks) and writes the
   platform title/description/hashtags before rendering — no API keys needed, with
   automatic model failover. The app itself uses the z.ai SDK (GLM-5.3-Flash) for
   chat and on-demand story polish.
4. **Cinematic vertical 1080×1920 MP4s** at **60fps hyperframes** — keyless AI scene
   imagery (Pollinations flux) with Ken Burns motion + Edge-TTS voiceover +
   word-synced Arabic captions (MoviePy + Pillow + arabic-reshaper + python-bidi,
   bundled Cairo/Noto/Amiri fonts).
5. **Hourly Google Drive sync**: every finished video bundle is uploaded to Drive
   via your own Apps Script web app (see below) — hash-deduped, throttled to once
   per hour, plus a final flush at the end of each factory run.
6. **Post** every rendered video to YouTube, TikTok and Instagram Reels (each
   platform activates as soon as you add its secrets).

Catch-up batches and single-story renders remain available: `hourly-video.yml`
(parallel worker matrix — the app's **Make video** / **Make all videos** use it).

## Files

| File | Purpose |
|---|---|
| `.github/workflows/factory.yml` | **THE continuous loop** — forges videos nonstop, self-chains the next run |
| `scripts/factory.py` | Factory supervisor: sheet sync → forge → invent stories → repeat |
| `scripts/ai_forge.py` | Keyless AI code-writer: writes each story's renderer, self-repairs, validates |
| `scripts/drive_sync.py` | Hourly Google Drive sync (dedup + TTL + final flush) |
| `scripts/drive_webapp.js` | The Apps Script you paste once at script.google.com |
| `.github/workflows/hourly-video.yml` | Catch-up batch renders — parallel worker matrix + publish job |
| `.github/workflows/ensure-factory.yml` | Watcher — re-dispatches the factory if the chain breaks |
| `.github/workflows/ensure-hourly.yml` | Backup watcher for the hourly workflow |
| `scripts/render_pending.py` | Batch queue: shards the pending stories across workers and renders them |
| `scripts/generate_story.py` | Single-story source: Google Sheet (tolerant parser) → keyless GLM → fallback |
| `generate_video.py` | Cinematic renderer: `story.json` → 1080×1920 60fps MP4 |
| `state/videos*.json` | Render state committed by the bot — which stories already have videos (the factory reads the union of all shards) |
| `state/factory_status.json` | Live factory heartbeat (phase, current story, queue, recent videos) |
| `fonts/` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| `post_video.py` | Posts to YouTube / TikTok / Instagram |
| `requirements.txt` | Python dependencies |
| `web/` | The full Kimi-style agent app (Next.js) source |

## Secrets (Settings → Secrets and variables → Actions)

Add only what you need — every platform is optional and skipped gracefully:

| Secret | Platform | How to get it |
|---|---|---|
| `DRIVE_WEBAPP_URL` | Google Drive | Your Apps Script web app `/exec` URL (see the Drive section below) |
| `DRIVE_WEBAPP_KEY` | Google Drive | Optional shared key you set inside the Apps Script |
| `YOUTUBE_REFRESH_TOKEN` | YouTube | OAuth playground with `youtube.upload` scope |
| `YOUTUBE_CLIENT_ID` | YouTube | Google Cloud Console → OAuth client |
| `YOUTUBE_CLIENT_SECRET` | YouTube | Google Cloud Console → OAuth client |
| `TIKTOK_ACCESS_TOKEN` | TikTok | TikTok for Developers → Content Posting API |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram | Meta Graph API (IG business account) |
| `INSTAGRAM_USER_ID` | Instagram | Your Instagram Business account id |

### Optional repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Meaning |
|---|---|---|
| `FLP_MODEL` | `glm-4.7-flash` | freellmpool model tried first for story generation & polish |
| `LLM7_MODEL` | `GLM-5.3-Flash` | Keyless direct fallback for polish/story-gen (llm7.io, no API key) |
| `SHEET_ID` | the Spark sheet | Google Sheet id with the hourly story |
| `TTS_VOICE_AR` | `ar-EG-ShakirNeural` | Edge-TTS Arabic voice |
| `ENABLE_AI_IMAGES` | `true` | Keyless AI scene imagery (Pollinations) |
| `IMAGE_MODEL` | `flux` | Pollinations image model (`flux` / `turbo`) |
| `FRAME_RATE` | `60` | Hyperframes — 60fps silky motion (set `24` for the old rate) |
| `AI_ENHANCE` | `true` | Keyless AI polish of voiceovers + platform metadata before render |
| `BUDGET_MIN` | `36` | Minutes each worker spends rendering per run |
| `MAX_VIDEOS` | `4` | Max videos rendered **per worker** per run |
| `WORKERS_JSON` | `["0","1","2"]` | Parallel workers for cron-triggered runs (app dispatches override) |
| `YOUTUBE_PRIVACY` | `public` | `public` / `unlisted` / `private` |
| `TIKTOK_PRIVACY` | `SELF_ONLY` | `SELF_ONLY` until your TikTok app is approved |
| `FACTORY_BUDGET_MIN` | `300` | Minutes each factory run renders before chaining the next |
| `INFINITE_STORIES` | `true` | AI invents new stories when the sheet queue is empty |
| `DRIVE_SYNC_INTERVAL` | `3600` | Seconds between Drive sync passes (hourly) |
| `DRIVE_ROOT_FOLDER` | `StoryPilot Videos` | Drive folder name for uploads |

## Google Drive sync (one-time, ~3 minutes)

1. Open [script.google.com](https://script.google.com) → **New project**
2. Paste the contents of **`scripts/drive_webapp.js`** → save
3. **Deploy → New deployment → Web app** — execute as **me**, access: **anyone**
4. Copy the **`/exec`** URL and add it as the repo secret **`DRIVE_WEBAPP_URL`**

Every finished video (`output.mp4`, `meta.json`, `story.json`, `thumb.jpg`,
`ai_renderer.py`) lands in `StoryPilot Videos/<date> <title> [hash8]/` on YOUR Drive —
uploaded hourly at most, hash-deduped (never re-uploaded), and never blocking a render.

## Run it now

Actions tab → **Hourly Story Video** → **Run workflow**.
Every run leaves its rendered MP4s (one folder per video: `output.mp4`, `meta.json`,
`thumb.jpg`, `story.json`) in per-worker **hourly-video-w*** artifacts (14-day
retention), commits the render state, and the app's continuous loop (or the next
hourly cron) automatically continues any remaining queue.

## Story sheet

https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit

Every non-code tab is parsed tolerantly (English or Arabic labels, any column
order): label rows for Title / Logline / Genre / Duration, scene tables whose
columns are detected by keyword, and optional complete-narration sections. If
parsing finds no scenes, the pipeline falls back to a keyless AI story so it
never breaks.
