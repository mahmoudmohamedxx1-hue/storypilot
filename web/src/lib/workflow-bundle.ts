import { GENERATE_VIDEO_PY } from '@/lib/bundle/generate-video-py'
import { GENERATE_STORY_PY } from '@/lib/bundle/generate-story-py'
import { POST_VIDEO_PY } from '@/lib/bundle/post-video-py'
import { RENDER_PENDING_PY } from '@/lib/bundle/render-pending-py'
import { AI_FORGE_PY } from '@/lib/bundle/ai-forge-py'
import { SCHEDULE_GATE_PY } from '@/lib/bundle/schedule-gate-py'
import { FACTORY_PY } from '@/lib/bundle/factory-py'
import { FACTORY_YAML } from '@/lib/bundle/factory-yaml'
import { ENSURE_FACTORY_YAML } from '@/lib/bundle/ensure-factory-yml'
import { DRIVE_SYNC_PY } from '@/lib/bundle/drive-sync-py'
import { DRIVE_WEBAPP_JS } from '@/lib/bundle/drive-webapp-js'
import { buildWorkflowYaml, buildSetupMd, REQUIREMENTS_TXT } from '@/lib/bundle/workflow-yaml'
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
      path: '.github/workflows/factory.yml',
      language: 'yaml',
      description: 'SCHEDULED Video Factory: hourly :07 tick + schedule gate (SCHEDULE_HOURS, Africa/Cairo) + capped slot - NO chaining, NO continuous loop',
      content: FACTORY_YAML,
    },
    {
      path: '.github/workflows/hourly-video.yml',
      language: 'yaml',
      description: 'Manual/on-demand workflow: single story / batch catch-up on 3 parallel workers (no cron - the schedule owns automatic generation)',
      content: buildWorkflowYaml({ sheetId: s.sheetId, flpModel: s.flpModel, voice: s.voice }),
    },
    {
      path: '.github/workflows/ensure-factory.yml',
      language: 'yaml',
      description: 'Ensure Scheduled Slot: at :37 every hour re-dispatches the factory ONLY when the current scheduled hour produced nothing (heals dropped ticks)',
      content: ENSURE_FACTORY_YAML,
    },
    {
      path: 'scripts/factory.py',
      language: 'python',
      description: 'Scheduled factory supervisor: one slot renders up to MAX_VIDEOS_PER_SLOT videos (pending stories first, ONE AI-invented story when empty), records the slot, then STOPS',
      content: FACTORY_PY,
    },
    {
      path: 'scripts/schedule_gate.py',
      language: 'python',
      description: 'The schedule gate: hour check (Africa/Cairo) + slot dedup + manual/agent bypass - what turns hourly ticks into videos at 11:00, 12:00, 13:00, 15:00, 20:00',
      content: SCHEDULE_GATE_PY,
    },
    {
      path: 'scripts/drive_sync.py',
      language: 'python',
      description: 'Hourly Google Drive sync: uploads every finished video to your Drive via your Apps Script web app (deduped, never blocks rendering)',
      content: DRIVE_SYNC_PY,
    },
    {
      path: 'scripts/drive_webapp.js',
      language: 'javascript',
      description: 'One-time setup: the Apps Script you paste at script.google.com so the factory can upload into your Drive',
      content: DRIVE_WEBAPP_JS,
    },
    {
      path: 'scripts/ai_forge.py',
      language: 'python',
      description: 'AI Hyperframe Forge: the KEYLESS AI writes the renderer code per story (freellmpool -> Pollinations), sandbox-runs it, self-repairs, built-in fallback',
      content: AI_FORGE_PY,
    },
    {
      path: 'scripts/generate_story.py',
      language: 'python',
      description: 'Story source: Google Sheet (Gemini Spark) → keyless freellmpool → fallback',
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
