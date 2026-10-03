import JSZip from 'jszip'
import { buildWorkflowBundle } from '@/lib/workflow-bundle'

export const runtime = 'nodejs'

export async function GET() {
  const files = await buildWorkflowBundle()
  const zip = new JSZip()
  for (const f of files) {
    zip.file(f.path.replace(/^\//, ''), f.content)
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="storypilot-pipeline.zip"',
    },
  })
}
