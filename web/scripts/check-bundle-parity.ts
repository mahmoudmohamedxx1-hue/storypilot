/* Verify app bundle templates produce files identical to the live repo */
import { buildWorkflowYaml, REQUIREMENTS_TXT } from '../src/lib/bundle/workflow-yaml'
import { GENERATE_VIDEO_PY } from '../src/lib/bundle/generate-video-py'
import { GENERATE_STORY_PY } from '../src/lib/bundle/generate-story-py'
import { POST_VIDEO_PY } from '../src/lib/bundle/post-video-py'
import { RENDER_PENDING_PY } from '../src/lib/bundle/render-pending-py'
import { AI_FORGE_PY } from '../src/lib/bundle/ai-forge-py'
import { FACTORY_PY } from '../src/lib/bundle/factory-py'
import { FACTORY_YAML } from '../src/lib/bundle/factory-yaml'
import { ENSURE_FACTORY_YAML } from '../src/lib/bundle/ensure-factory-yml'
import { DRIVE_SYNC_PY } from '../src/lib/bundle/drive-sync-py'
import { DRIVE_WEBAPP_JS } from '../src/lib/bundle/drive-webapp-js'
import { readFileSync } from 'fs'

const repo = '/home/z/my-project/storypilot-live'
const settings = {
  sheetId: '1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4',
  flpModel: 'auto',
  voice: 'ar-EG-ShakirNeural',
}

const pairs: Array<[string, string]> = [
  [`${repo}/.github/workflows/factory.yml`, FACTORY_YAML],
  [`${repo}/.github/workflows/ensure-factory.yml`, ENSURE_FACTORY_YAML],
  [`${repo}/.github/workflows/hourly-video.yml`, buildWorkflowYaml(settings)],
  [`${repo}/generate_video.py`, GENERATE_VIDEO_PY],
  [`${repo}/scripts/factory.py`, FACTORY_PY],
  [`${repo}/scripts/ai_forge.py`, AI_FORGE_PY],
  [`${repo}/scripts/drive_sync.py`, DRIVE_SYNC_PY],
  [`${repo}/scripts/drive_webapp.js`, DRIVE_WEBAPP_JS],
  [`${repo}/scripts/render_pending.py`, RENDER_PENDING_PY.replace(/__SHEET_ID__/g, settings.sheetId).replace(/__FLP_MODEL__/g, settings.flpModel)],
  [`${repo}/scripts/generate_story.py`, GENERATE_STORY_PY.replace(/__SHEET_ID__/g, settings.sheetId).replace(/__FLP_MODEL__/g, settings.flpModel)],
  [`${repo}/post_video.py`, POST_VIDEO_PY],
  [`${repo}/requirements.txt`, REQUIREMENTS_TXT],
]

let fail = 0
for (const [path, generated] of pairs) {
  const onDisk = readFileSync(path, 'utf8')
  const same = onDisk === generated
  if (!same) {
    fail++
    console.log('DIFF:', path)
    const a = onDisk.split('\n'); const b = generated.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.log(`  line ${i + 1}: repo="${a[i]?.slice(0, 80)}" | app="${b[i]?.slice(0, 80)}"`); break }
    }
  } else {
    console.log('MATCH:', path)
  }
}
console.log(fail ? `${fail} DIFF(S) FOUND` : `all ${pairs.length} bundle files match the live repo`)
process.exit(fail ? 1 : 0)
