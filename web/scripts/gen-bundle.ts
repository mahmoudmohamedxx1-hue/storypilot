import { buildWorkflowBundle } from '../src/lib/workflow-bundle'
import { writeFileSync, mkdirSync } from 'fs'
const outDir = process.env.OUT_DIR || '/home/z/my-project/scripts/bundle-out'
const files = await buildWorkflowBundle()
for (const f of files) {
  const p = outDir + '/' + f.path
  mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true })
  writeFileSync(p, f.content)
  console.log('wrote', p, f.content.length, 'bytes')
}
