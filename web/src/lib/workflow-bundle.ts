import { GENERATE_VIDEO_PY } from '@/lib/bundle/generate-video-py'
import { GENERATE_STORY_PY } from '@/lib/bundle/generate-story-py'
import { POST_VIDEO_PY } from '@/lib/bundle/post-video-py'
import { RENDER_PENDING_PY } from '@/lib/bundle/render-pending-py'
import { buildWorkflowYaml, buildEnsureHourlyYaml, buildSetupMd, REQUIREMENTS_TXT } from '@/lib/bundle/workflow-yaml'
import { getSettings } from '@/lib/settings'

export interface BundleFile {
  path: string
  content: string
  language: string
  description: string
}

export async function buildWorkflowBundle(): Promise<BundleFile[]> {
  const s = await getSettings()
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${s.sheetId}/edit`
  return [
    {
      path: '.github/workflows/hourly-video.yml',
      language: 'yaml',
      description: 'Hourly GitHub Actions workflow: story → MP4 → YouTube/TikTok/Instagram',
      content: buildWorkflowYaml({ sheetId: s.sheetId, flpModel: s.flpModel, voice: s.voice }),
    },
    {
      path: '.github/workflows/ensure-hourly.yml',
      language: 'yaml',
      description: 'Self-healing watcher: re-dispatches the render workflow when GitHub cron drops an hourly tick',
      content: buildEnsureHourlyYaml(),
    },
    {
      path: 'scripts/generate_story.py',
      language: 'python',
      description: 'Story source: Google Sheet (Gemini Spark) → keyless freellmpool GLM → fallback',
      content: GENERATE_STORY_PY.replace(/__SHEET_ID__/g, s.sheetId).replace(/__FLP_MODEL__/g, s.flpModel),
    },
    {
      path: 'scripts/render_pending.py',
      language: 'python',
      description: 'Batch catch-up queue: renders EVERY pending sheet story per run (state committed to the repo)',
      content: RENDER_PENDING_PY.replace(/__SHEET_ID__/g, s.sheetId).replace(/__FLP_MODEL__/g, s.flpModel),
    },
    {
      path: 'generate_video.py',
      language: 'python',
      description: 'Renders story.json → 1080×1920 MP4 with Edge-TTS voiceover (evolved from the sheet code)',
      content: GENERATE_VIDEO_PY,
    },
    {
      path: 'post_video.py',
      language: 'python',
      description: 'Posts the MP4 to YouTube, TikTok and Instagram Reels',
      content: POST_VIDEO_PY,
    },
    {
      path: 'requirements.txt',
      language: 'text',
      description: 'Python dependencies (all free / keyless)',
      content: REQUIREMENTS_TXT,
    },
    {
      path: 'STORYPILOT.md',
      language: 'markdown',
      description: 'Setup guide: secrets, variables, how to run',
      content: buildSetupMd({ repo: s.githubRepo, sheetUrl }),
    },
  ]
}
