import { buildWorkflowBundle } from '@/lib/workflow-bundle'

export const runtime = 'nodejs'

export async function GET() {
  const files = await buildWorkflowBundle()
  return Response.json({ ok: true, files })
}
