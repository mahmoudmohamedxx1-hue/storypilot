import fs from 'fs'
import { GENERATE_VIDEO_PY } from '../src/lib/bundle/generate-video-py'
import { GENERATE_STORY_PY } from '../src/lib/bundle/generate-story-py'
import { POST_VIDEO_PY } from '../src/lib/bundle/post-video-py'
import { buildWorkflowYaml, buildSetupMd, REQUIREMENTS_TXT } from '../src/lib/bundle/workflow-yaml'

const sheetId = '1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4'
const files: Record<string, string> = {
  '/tmp/eval_generate_video.py': GENERATE_VIDEO_PY,
  '/tmp/eval_generate_story.py': GENERATE_STORY_PY.replace(/__SHEET_ID__/g, sheetId).replace(/__FLP_MODEL__/g, 'glm-5.3-flash'),
  '/tmp/eval_post_video.py': POST_VIDEO_PY,
  '/tmp/eval_workflow.yml': buildWorkflowYaml({ sheetId, flpModel: 'glm-5.3-flash', voice: 'ar-EG-ShakirNeural' }),
  '/tmp/eval_setup.md': buildSetupMd({ repo: 'x/y', sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` }),
  '/tmp/eval_requirements.txt': REQUIREMENTS_TXT,
}
for (const [p, c] of Object.entries(files)) {
  fs.writeFileSync(p, c)
  console.log(`wrote ${p} (${c.length} chars)`)
}
