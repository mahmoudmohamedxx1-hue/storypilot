# StoryPilot 🎬

**Continuous AI video factory** — turns every story in a Google Sheet (updated hourly by
the Gemini Spark automation) into **cinematic vertical videos (1080×1920, 60fps
hyperframes)** and publishes them to YouTube, TikTok and Instagram — **generated
continuously, back-to-back, forever**. 100% **keyless / free** stack on GitHub Actions.

**The loop lives on GitHub itself**: `factory.yml` runs ~5h, renders nonstop, then
**chains the next run** (dispatch verified with retries) — no external app needed to
keep it alive. When the sheet queue is empty, the keyless AI **invents new stories**
(`INFINITE_STORIES`) so production never stops. Finished videos are synced to
**Google Drive** every hour (deduped).

```
Google Sheet (Gemini Spark)  ←──── synced every ~150s inside each run
        │
        ▼  .github/workflows/factory.yml  ── THE INFINITE LOOP (~5h per run)
┌──────────────────────────────────────────────────────────────┐
│ 1. Sheet stories pending? ──► AI HYPERFRAME FORGE each one:  │
│      the keyless AI WRITES the renderer code per story       │
│      (freellmpool → llm7/Pollinations, self-repair loop,     │
│      built-in cinematic renderer as guaranteed fallback)     │
│ 2. Queue empty? ──► keyless AI INVENTS a new 10-scene story  │
│      and forges it (INFINITE_STORIES=true)                   │
│ 3. Every finished video:                                     │
│      • artifact upload (mp4 + meta + thumb + story + code)   │
│      • render state committed to the repo (survives runs)    │
│      • Google Drive sync (hourly TTL, hash-deduped)          │
│      • optional YouTube / TikTok / Instagram publishing      │
│ 4. Budget spent ──► CHAIN THE NEXT RUN (verified dispatch,   │
│      5 retries) ──► the loop never silently dies             │
└──────────────────────────────────────────────────────────────┘
        ▲ backstop layers: */15 cron · ensure-factory.yml */20 · app heartbeat

hourly-video.yml (parallel worker matrix, on-demand + :47 cron backup) stays
available for catch-up batches and single library renders.
```

The app itself chats and polishes stories with **GLM-5.3-Flash via the z.ai SDK**; the
pipeline's AI (story fallback + polish) is **keyless via
[freellmpool](https://github.com/0xzr/freellmpool)**.

## Repo layout

| Path | What it is |
|---|---|
| `.github/workflows/factory.yml` | **THE continuous loop** — forges videos nonstop, self-chains the next run |
| `.github/workflows/hourly-video.yml` | Parallel worker matrix — on-demand catch-up batches + single renders |
| `.github/workflows/ensure-factory.yml` | Watcher — re-dispatches the factory if the chain ever breaks |
| `scripts/factory.py` | Factory supervisor — sheet sync → forge → invent → repeat, budget-aware |
| `scripts/ai_forge.py` | Keyless AI code-writer — writes the per-story renderer, self-repairs, validates |
| `scripts/drive_sync.py` + `scripts/drive_webapp.js` | Hourly Google Drive sync via your own Apps Script web app |
| `generate_video.py` | Built-in cinematic renderer — `story.json` → `output/output.mp4` |
| `scripts/render_pending.py` | The catch-up queue: shards pending stories across workers, keyless AI polish |
| `scripts/generate_story.py` | Story source: Sheet → keyless freellmpool GLM → fallback |
| `post_video.py` | YouTube / TikTok / Instagram publishers |
| `fonts/` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| `web/` | **The full Kimi-style agent app** (Next.js + Prisma) — chat, Library of generated videos, n8n-style live pipeline view |

## Quickstart

1. **Run the pipeline now** — Actions tab → *Hourly Story Video* → *Run workflow*.
   The finished run leaves `output.mp4`, `thumb.jpg` and `meta.json` in the
   `hourly-video` artifact (14-day retention). The hourly cron runs it automatically.
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

### Always generating (self-healing, 5 layers)

Videos are generated CONTINUOUSLY — not just hourly — and never silently stop:

| Layer | What | When |
|---|---|---|
| 1. **`factory.yml` self-chain (primary)** | each run renders for ~5h (or until the queue drains), then **dispatches its successor and VERIFIES it exists** (5 retries) | every ~5h, forever |
| 2. `factory.yml` cron heartbeat | schedule backstop | every **15 min** (best-effort) |
| 3. `.github/workflows/ensure-factory.yml` | watcher that re-dispatches when the last factory run is >25m stale | every **20 min** (best-effort) |
| 4. `hourly-video.yml` cron + `ensure-hourly.yml` | catch-up backup: parallel workers drain any pending queue | hourly at **:47** / **:19 UTC** |
| 5. StoryPilot app heartbeat | dispatches the factory when it looks dead (while the app runs) | every 10 min |

Stop the factory: create `state/FACTORY_STOP` (the app's chat: *"stop the factory"*)
or disable the workflow. Resume: delete the file / re-enable.

### Hourly Google Drive sync

Every finished video (`output.mp4`, `meta.json`, `story.json`, `thumb.jpg`,
`ai_renderer.py`) is uploaded to Google Drive via **your own** Apps Script web app —
free, no API keys. One-time setup (~3 min):

1. Open [script.google.com](https://script.google.com) → New project
2. Paste the contents of `scripts/drive_webapp.js`
3. Deploy → New deployment → **Web app** → execute as **me**, access **anyone**
4. Copy the `/exec` URL → repo **Secret** `DRIVE_WEBAPP_URL` (optional `DRIVE_WEBAPP_KEY`)

Sync runs hourly (`DRIVE_SYNC_INTERVAL`, hash-deduped in `state/drive_sync.json`),
plus a final flush when a factory run ends. Until the secret is set, the step
skips gracefully — rendering never waits on Drive.

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
