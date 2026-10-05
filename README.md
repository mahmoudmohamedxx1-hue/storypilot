# StoryPilot 🎬

**Continuous AI video factory** — turns every story in a Google Sheet (updated hourly by
the Gemini Spark automation) into **cinematic vertical videos (1080×1920, 60fps
hyperframes)** and publishes them to YouTube, TikTok and Instagram — **generated
continuously, back-to-back, with parallel workers**. 100% **keyless / free** stack,
driven by GitHub Actions + the StoryPilot app's render loop.

```
Google Sheet (Gemini Spark)  ←──── always in sync (every ~60s)
        │
        ▼  StoryPilot app: CONTINUOUS RENDER LOOP (polls every 90s)
│  pending stories? ──► dispatch hourly-video.yml BACK-TO-BACK
│        (cron :47 + ensure :19 are backup layers)
        ▼  .github/workflows/hourly-video.yml  ── parallel worker matrix
┌──────────────────────────────────────────────────────────────┐
│ 1. Fetch stories    every sheet tab (tolerant EN/AR parser)  │
│      └ shard the pending queue across N workers              │
│ 2. Keyless AI polish (freellmpool — GLM-Flash first,         │
│      auto-failover): tighter narration + platform title/     │
│      description/tags — falls back to original text, never   │
│      blocks a render                                          │
│ 3. Render cinematic MP4s (per worker, in parallel)           │
│      • keyless AI scene imagery (Pollinations flux)          │
│      • Ken Burns motion (ffmpeg zoompan)                     │
│      • Edge-TTS voiceover (ar-EG-ShakirNeural)               │
│      • word-synced Arabic captions (Cairo/Noto/Amiri fonts)  │
│      • 60fps hyperframes, H.264/AAC, 1080×1920               │
│ 4. Upload per-worker artifacts + commit render state         │
│ 5. Publish job: post EVERY video to YouTube/TikTok/Instagram │
└──────────────────────────────────────────────────────────────┘
```

The app itself chats and polishes stories with **GLM-5.3-Flash via the z.ai SDK**; the
pipeline's AI (story fallback + polish) is **keyless via
[freellmpool](https://github.com/0xzr/freellmpool)**.

## Repo layout

| Path | What it is |
|---|---|
| `.github/workflows/hourly-video.yml` | The render workflow — parallel worker matrix + publish job |
| `generate_video.py` | Cinematic renderer — `story.json` → `output/output.mp4` |
| `scripts/render_pending.py` | The queue: shards pending stories across workers, keyless AI polish, renders |
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

### Always generating (self-healing, 4 layers)

Videos are generated CONTINUOUSLY while pending stories exist — not just hourly:

| Layer | What | When |
|---|---|---|
| 1. **App render loop (primary)** | dispatches the render workflow back-to-back whenever pending stories exist (pending = sheet stories minus repo render state) | polls every **90s** |
| 2. `hourly-video.yml` render cron | backup | every hour at **:47 UTC** (off-peak minute) |
| 3. `.github/workflows/ensure-hourly.yml` | watcher that re-dispatches when the last run is stale | every hour at **:19 UTC** |
| 4. cooldown guard | after 2 consecutive no-progress runs the loop pauses 20 min (no dispatch spam) | automatic |

Each dispatched run fans out to **3 parallel workers** by default (override with the
`workers_json` input or the `WORKERS_JSON` repo variable) — each worker renders its own
shard of the pending queue, so throughput is ~3× a single run. Every worker commits its
own `state/videos.shard*.json`, so progress is never lost and workers never collide.

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
