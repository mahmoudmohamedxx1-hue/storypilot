import { NextRequest } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  const jobs = await db.videoJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
  return Response.json({ jobs })
}

export async function POST(req: NextRequest) {
  const { storyTitle, platforms, runId, status, videoUrl } = (await req.json()) as {
    storyTitle?: string
    platforms?: string[]
    runId?: string
    status?: string
    videoUrl?: string
  }
  const job = await db.videoJob.create({
    data: {
      title: `Hourly video · ${storyTitle || 'untitled'}`,
      storyTitle: storyTitle || null,
      platforms: JSON.stringify((platforms || []).map(p => ({ platform: p, status: 'pending' }))),
      runId: runId || null,
      status: status || 'queued',
      videoUrl: videoUrl || null,
    },
  })
  return Response.json({ job })
}

export async function PATCH(req: NextRequest) {
  const { id, status, videoUrl, platformResults } = (await req.json()) as {
    id: string
    status?: string
    videoUrl?: string
    platformResults?: Array<{ platform: string; status: string; url?: string }>
  }
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })
  const job = await db.videoJob.update({
    where: { id },
    data: {
      ...(status ? { status } : {}),
      ...(videoUrl ? { videoUrl } : {}),
      ...(platformResults ? { platforms: JSON.stringify(platformResults) } : {}),
    },
  })
  return Response.json({ job })
}
