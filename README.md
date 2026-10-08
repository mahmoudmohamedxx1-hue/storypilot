# StoryPilot 🎬

**Continuous AI video factory** — turns every story in a Google Sheet (updated by
the Gemini Spark automation) into **cinematic vertical videos (1080×1920, 60fps
hyperframes)** and publishes them to YouTube, TikTok and Instagram — **continuously,
24/7**. 100% **keyless / free** stack on GitHub Actions.

**Videos are made in a CONTINUOUS way**: the factory runs ~5h jobs on GitHub
Actions that **chain themselves run-after-run** — one video after another, back
to back, with **no cap**. The total count just keeps climbing (…12, 13, 14 …
20 … and beyond). Pending sheet stories render first; whenever the queue is
empty the keyless AI **invents a fresh story** (retry ×3, emergency builtin
bank as fallback) so production never stalls. Finished videos are synced to
**Google Drive every hour** (deduped).

```
Google Sheet (Gemini Spark)  ←──── synced continuously mid-run
        │
        ▼  .github/workflows/factory.yml  ── self-chaining ~5h runs
┌──────────────────────────────────────────────────────────────┐
│ 1. CONTINUOUS LOOP ──► render pending stories back-to back:  │
│      sheet stories first; queue empty ──► the keyless AI     │
│      INVENTS a new 10-scene story every time and forges it   │
│      (the AI WRITES the renderer code per story: freellmpool │
│      → llm7/Pollinations, self-repair loop, built-in         │
│      cinematic renderer as guaranteed fallback)              │
│ 2. Every finished video:                                     │
│      • artifact upload (mp4 + meta + thumb + story + code)   │
│      • render state committed to the repo (survives runs)    │
│      • Google Drive sync (hourly, hash-deduped)              │
│      • optional YouTube / TikTok / Instagram publishing      │
│ 3. Time budget spent (~5h) ──► CHAIN the next run            │
│      (dispatch VERIFIED x5, REST fallback) ──► the loop      │
│      never ends. Live status in state/factory_status.json.   │
└──────────────────────────────────────────────────────────────┘
        ▲ healers: */15 cron backstop · ensure-factory.yml */20 · app heartbeat
```

`hourly-video.yml` (parallel worker matrix, **no cron**) stays available for
on-demand catch-up batches and single library renders — the continuous factory
owns automatic generation.

The app itself chats and polishes stories with **GLM-5.3-Flash via the z.ai SDK**; the
pipeline's AI (story fallback + polish) is **keyless via
[freellmpool](https://github.com/0xzr/freellmpool)**.

## Repo layout

| Path | What it is |
|---|---|
| `.github/workflows/factory.yml` | **THE continuous factory** — self-chaining ~5h runs + `*/15` cron backstop |
| `.github/workflows/ensure-factory.yml` | Ensure Continuous Factory — `*/20` watcher reviving a dead chain |
| `.github/workflows/hourly-video.yml` | Parallel worker matrix — manual/on-demand catch-up batches + single renders (no cron) |
| `scripts/factory.py` | Continuous supervisor — sheet sync → forge back-to-back → invent when empty → chain |
| `scripts/ai_forge.py` | Keyless AI code-writer — writes the per-story renderer, self-repairs, validates |
| `scripts/drive_sync.py` + `scripts/drive_webapp.js` | Hourly Google Drive sync via your own Apps Script web app |
| `generate_video.py` | Built-in cinematic renderer — `story.json` → `output/output.mp4` |
| `scripts/render_pending.py` | The catch-up queue: shards pending stories across workers, keyless AI polish |
| `scripts/generate_story.py` | Story source: Sheet → keyless freellmpool GLM → fallback |
| `post_video.py` | YouTube / TikTok / Instagram publishers |
| `fonts/` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| `web/` | **The full Kimi-style agent app** (Next.js + Prisma) — chat, Library of generated videos, n8n-style live pipeline view |

## Quickstart

1. **Nothing to start** — the factory chains itself around the clock. For an
   immediate run: Actions tab → *Continuous Video Factory* → *Run workflow*;
   from that moment the loop renders back-to-back and re-chains forever.
   Every run leaves `output.mp4`, `thumb.jpg` and `meta.json` in the
   `factory-videos` artifact (14-day retention).
2. **Publish to platforms** — add the optional secrets listed in
   [STORYPILOT.md](STORYPILOT.md). Each platform activates as soon as its secrets exist.
3. **Run the web app** —
   ```bash
   cd web
   bun install          # or npm install
   cp .env.example .env # set GITHUB_TOKEN / GITHUB_REPO
   bunx prisma db push
   bun run dev          # Kimi-style UI: chat + Library + live pipeline
   ```

### The loop never silently dies (self-healing)

| Layer | What | When |
|---|---|---|
| 1. **Self-chaining (primary)** | run dispatches + VERIFIES its successor (5 retries, REST fallback) | end of every run |
| 2. `factory.yml` cron backstop | re-tick; the singleton guard turns noise into no-ops | every 15 min |
| 3. `.github/workflows/ensure-factory.yml` | re-dispatches when no run is alive for 25+ min | every 20 min |
| 4. StoryPilot app heartbeat | revives the loop when it looks dead | every 10 min (while the app runs) |
| 5. Singleton guard + concurrency group | never two factories at once; queued noise auto-collapses | always |

Stop the factory: create `state/FACTORY_STOP` (the app's chat: *"stop the factory"*)
or disable the workflow. Resume: delete the file / re-enable (or *"start the factory"*).

### Google Drive sync

Every finished video (`output.mp4`, `meta.json`, `story.json`, `thumb.jpg`,
`ai_renderer.py`) is uploaded to Google Drive via **your own** Apps Script web app —
free, no API keys. One-time setup (~3 min):

1. Open [script.google.com](https://script.google.com) → New project
2. Paste the contents of `scripts/drive_webapp.js`
3. Deploy → New deployment → **Web app** → execute as **me**, access **anyone**
4. Copy the `/exec` URL → repo **Secret** `DRIVE_WEBAPP_URL` (optional `DRIVE_WEBAPP_KEY`)

Sync runs at least once an hour while the factory works (throttled by
`DRIVE_SYNC_INTERVAL`, hash-deduped in `state/drive_sync.json`), plus a flush at
the end of every run. Until the secret is set, the step skips gracefully —
rendering never waits on Drive.

Each dispatched hourly-video run fans out to **3 parallel workers** by default (override
with the `workers_json` input or the `WORKERS_JSON` repo variable) — each worker renders
its own shard of the pending queue. Every worker commits its own
`state/videos.shard*.json`, so progress is never lost and workers never collide. The
factory reads the **union** of all state files, so both engines share one done-set.

## Story sheet format (tolerant)

EVERY tab of the
[sheet](https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit)
is parsed **tolerantly** — English or Arabic labels, any column order, multiple stories
per tab:

- Label rows: `Story Title / العنوان`, `Logline`, `Genre`, `Duration`
- A scene table whose columns are detected by keyword
  (`time / duration`, `visual / وصف`, `prompt / برومبت`, `voiceover / التعليق الصوتي`, `sfx`)
- An optional complete-narration section

If no scenes are found (e.g. right after the Spark automation changes), the pipeline
generates a fresh story **keyless** via [freellmpool](https://github.com/0xzr/freellmpool)
(GLM Flash first, auto-failover to live keyless routes) — it never breaks.

## Keyless stack

| Piece | Service | Key needed |
|---|---|---|
| Voiceover | Microsoft Edge TTS (`ar-EG-ShakirNeural`) | none |
| Scene imagery | Pollinations (`flux`) | none |
| Fallback story writer | freellmpool (GLM Flash tier) | none |
| Video | MoviePy + Pillow + ffmpeg | none |
| Automation | GitHub Actions | included |

## Security notes

- Platform tokens live **only** in GitHub Secrets — never in code.
- Rotate any token that was ever pasted in a chat or document.

## The web app (`web/`)

A Kimi-style agent console for the pipeline:

- **Chat** — GLM-5.3-Flash via the z.ai SDK, with tools: fetch stories, sync sheet, make
  videos, trigger workflows, deploy, list repos
- **Library** — every generated video with player, status chips and one-click re-render
- **Pipeline** — n8n-style node canvas with **live** per-step states from GitHub Actions
- **Platforms / Workflows / Settings** — manage tokens, the workflow bundle and defaults

See `web/src` for the source; it is a standard Next.js (App Router) + Prisma app.
