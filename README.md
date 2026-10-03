# StoryPilot 🎬

**Hourly AI storytelling pipeline** — turns the stories in a Google Sheet (updated every
hour by the Gemini Spark automation) into **cinematic vertical videos (1080×1920)** and
publishes them to YouTube, TikTok and Instagram. 100% **keyless / free** stack, driven by
GitHub Actions.

```
Google Sheet (Gemini Spark, hourly)
        │
        ▼  .github/workflows/hourly-video.yml  (cron: 0 * * * *)
┌─────────────────────────────────────────────────────────────┐
│ 1. Fetch story      tolerant EN/AR sheet parser             │
│      └ fallback: keyless GLM story via freellmpool          │
│ 2. Render cinematic MP4                                     │
│      • keyless AI scene imagery (Pollinations flux)         │
│      • Ken Burns motion (ffmpeg zoompan)                    │
│      • Edge-TTS voiceover (ar-EG-ShakirNeural)              │
│      • word-synced Arabic captions (Cairo/Noto/Amiri fonts) │
│      • title + end cards, filmic grade, 24 fps H.264/AAC    │
│ 3. Upload artifact (MP4 + thumbnail + meta)                 │
│ 4. Post to YouTube / TikTok / Instagram (optional secrets)  │
└─────────────────────────────────────────────────────────────┘
```

## Repo layout

| Path | What it is |
|---|---|
| `.github/workflows/hourly-video.yml` | The hourly automation (schedule + manual dispatch) |
| `generate_video.py` | Cinematic renderer — `story.json` → `output/output.mp4` |
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

## Story sheet format (tolerant)

The first tab of the
[sheet](https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit)
is parsed **tolerantly** — English or Arabic labels, any column order:

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
