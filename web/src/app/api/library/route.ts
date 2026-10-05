import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { buildLibrary, renderStoryById, renderAllPending } from '@/lib/library'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET() {
  try {
    const payload = await buildLibrary()
    return Response.json(payload)
  } catch (e) {
    return Response.json({ ok: false, items: [], error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { action, storyId, jobId } = (await req.json()) as { action: string; storyId?: string; jobId?: string }
  try {
    if (action === 'render' && storyId) {
      const result = await renderStoryById(storyId)
      return Response.json(result, { status: result.ok ? 200 : 400 })
    }
    if (action === 'renderAll') {
      const result = await renderAllPending()
      return Response.json(result, { status: result.ok ? 200 : 400 })
    }
    if (action === 'delete' && jobId) {
      const job = await db.videoJob.findUnique({ where: { id: jobId } })
      if (job?.storyRecordId && ['done', 'failed'].includes(job.status)) {
        await db.storyRecord.update({ where: { id: job.storyRecordId }, data: { status: 'new' } }).catch(() => {})
      }
      await db.videoJob.delete({ where: { id: jobId } })
      return Response.json({ ok: true, message: 'Removed from library' })
    }
    return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
