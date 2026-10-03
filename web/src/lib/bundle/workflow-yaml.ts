export function buildWorkflowYaml(opts: { sheetId: string; flpModel: string; voice: string }): string {
  return `# StoryPilot - Hourly Story -> MP4 -> YouTube/TikTok/Instagram
# Deployed by the StoryPilot agent app. Runs every hour on GitHub Actions.
name: Hourly Story Video

on:
  schedule:
    - cron: "0 * * * *" # every hour (UTC)
  workflow_dispatch:
    inputs:
      use_ai_story:
        description: "Generate a fresh story with keyless GLM (ignore the Sheet)"
        type: boolean
        default: false
      topic:
        description: "Topic for the AI story (optional)"
        default: ""
      story_json:
        description: "Full story JSON from the StoryPilot library (skips sheet parsing)"
        default: ""
        type: string

permissions:
  contents: read

concurrency:
  group: hourly-video
  cancel-in-progress: false

jobs:
  render-and-post:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      # secrets/vars mapped at job level — step-level if: may only read the env context
      YOUTUBE_REFRESH_TOKEN: \${{ secrets.YOUTUBE_REFRESH_TOKEN }}
      YOUTUBE_CLIENT_ID: \${{ secrets.YOUTUBE_CLIENT_ID }}
      YOUTUBE_CLIENT_SECRET: \${{ secrets.YOUTUBE_CLIENT_SECRET }}
      TIKTOK_ACCESS_TOKEN: \${{ secrets.TIKTOK_ACCESS_TOKEN }}
      INSTAGRAM_ACCESS_TOKEN: \${{ secrets.INSTAGRAM_ACCESS_TOKEN }}
      INSTAGRAM_USER_ID: \${{ secrets.INSTAGRAM_USER_ID }}
      YOUTUBE_PRIVACY: \${{ vars.YOUTUBE_PRIVACY || 'public' }}
      TIKTOK_PRIVACY: \${{ vars.TIKTOK_PRIVACY || 'SELF_ONLY' }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip

      - name: Install system deps (ffmpeg + fonts incl. Arabic)
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core fonts-noto-ui-core || true

      - name: Install Python deps
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt

      - name: Prepare story (Google Sheet by Gemini Spark + keyless GLM fallback)
        env:
          SHEET_ID: \${{ vars.SHEET_ID || '${opts.sheetId}' }}
          FLP_MODEL: \${{ vars.FLP_MODEL || '${opts.flpModel}' }}
          USE_AI_STORY: \${{ github.event_name == 'workflow_dispatch' && inputs.use_ai_story || 'false' }}
          STORY_TOPIC: \${{ github.event_name == 'workflow_dispatch' && inputs.topic || '' }}
          STORY_JSON: \${{ github.event_name == 'workflow_dispatch' && inputs.story_json || '' }}
        run: python scripts/generate_story.py

      - name: Render cinematic MP4 (keyless AI images + Edge-TTS + MoviePy, 1080x1920)
        env:
          TTS_VOICE_AR: \${{ vars.TTS_VOICE_AR || '${opts.voice}' }}
          ENABLE_AI_IMAGES: \${{ vars.ENABLE_AI_IMAGES || 'true' }}
          IMAGE_MODEL: \${{ vars.IMAGE_MODEL || 'flux' }}
        run: python generate_video.py

      - name: Upload video artifact
        uses: actions/upload-artifact@v4
        with:
          name: hourly-video
          path: |
            output/output.mp4
            output/meta.json
            output/thumb.jpg
          retention-days: 14
          if-no-files-found: error

      - name: Post to YouTube
        if: env.YOUTUBE_REFRESH_TOKEN != ''
        run: python post_video.py --youtube

      - name: Post to TikTok
        if: env.TIKTOK_ACCESS_TOKEN != ''
        run: python post_video.py --tiktok

      - name: Post to Instagram Reels
        if: env.INSTAGRAM_ACCESS_TOKEN != ''
        run: python post_video.py --instagram
`
}

export const REQUIREMENTS_TXT = `# StoryPilot hourly pipeline - all free / keyless
edge-tts>=6.1.0
moviepy>=2.0.0
pillow>=10.0.0
numpy>=1.24.0
arabic-reshaper>=3.0.0
python-bidi>=0.4.2
requests>=2.31.0
freellmpool>=0.13.0
`

export function buildSetupMd(opts: { repo: string; sheetUrl: string }): string {
  return `# StoryPilot — Hourly Cinematic Story Video Pipeline

This repo runs an **hourly automation** on GitHub Actions:

1. **Fetch the story** from the Google Sheet that Gemini Spark updates every hour
   (fallback: generate a fresh story **keyless** with [\`freellmpool\`](https://github.com/0xzr/freellmpool) — GLM Flash first, auto-failover to live keyless routes).
2. **Render a cinematic vertical 1080×1920 MP4** — keyless AI scene imagery (Pollinations flux)
   with Ken Burns motion + Edge-TTS voiceover + word-synced Arabic captions
   (MoviePy + Pillow + arabic-reshaper + python-bidi, bundled Cairo/Noto/Amiri fonts).
3. **Post** to YouTube, TikTok and Instagram Reels (each platform activates as soon as you add its secrets).

## Files

| File | Purpose |
|---|---|
| \`.github/workflows/hourly-video.yml\` | The hourly GitHub Actions workflow |
| \`scripts/generate_story.py\` | Story source: Google Sheet (tolerant parser) → keyless GLM → fallback |
| \`generate_video.py\` | Cinematic renderer: \`story.json\` → \`output/output.mp4\` |
| \`fonts/\` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| \`post_video.py\` | Posts to YouTube / TikTok / Instagram |
| \`requirements.txt\` | Python dependencies |
| \`web/\` | The full Kimi-style agent app (Next.js) source |

## Secrets (Settings → Secrets and variables → Actions)

Add only what you need — every platform is optional and skipped gracefully:

| Secret | Platform | How to get it |
|---|---|---|
| \`YOUTUBE_REFRESH_TOKEN\` | YouTube | OAuth playground with \`youtube.upload\` scope |
| \`YOUTUBE_CLIENT_ID\` | YouTube | Google Cloud Console → OAuth client |
| \`YOUTUBE_CLIENT_SECRET\` | YouTube | Google Cloud Console → OAuth client |
| \`TIKTOK_ACCESS_TOKEN\` | TikTok | TikTok for Developers → Content Posting API |
| \`INSTAGRAM_ACCESS_TOKEN\` | Instagram | Meta Graph API (IG business account) |
| \`INSTAGRAM_USER_ID\` | Instagram | Your Instagram Business account id |

### Optional repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Meaning |
|---|---|---|
| \`FLP_MODEL\` | \`glm-4.7-flash\` | Story model tried first by freellmpool |
| \`SHEET_ID\` | the Spark sheet | Google Sheet id with the hourly story |
| \`TTS_VOICE_AR\` | \`ar-EG-ShakirNeural\` | Edge-TTS Arabic voice |
| \`ENABLE_AI_IMAGES\` | \`true\` | Keyless AI scene imagery (Pollinations) |
| \`IMAGE_MODEL\` | \`flux\` | Pollinations image model (\`flux\` / \`turbo\`) |
| \`YOUTUBE_PRIVACY\` | \`public\` | \`public\` / \`unlisted\` / \`private\` |
| \`TIKTOK_PRIVACY\` | \`SELF_ONLY\` | \`SELF_ONLY\` until your TikTok app is approved |

## Run it now

Actions tab → **Hourly Story Video** → **Run workflow**.
Every finished run leaves the MP4 + thumbnail in the **hourly-video** artifact (14-day retention).

## Story sheet

${opts.sheetUrl}

The first tab is parsed tolerantly (English or Arabic labels, any column order):
label rows for Title / Logline / Genre / Duration, a scene table whose columns are
detected by keyword (time, visual, prompt, voiceover, sfx — Arabic or English), and an
optional complete-narration section. If parsing finds no scenes, the pipeline falls
back to a keyless AI story so it never breaks.
`
}
