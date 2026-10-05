import { NextRequest } from 'next/server'
import { getArtifactMp4, findArtifactForJob } from '@/lib/library'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Streams the rendered MP4 for a library video.
 * Extracts output.mp4 from the GitHub artifact zip once, then serves from disk cache.
 * Supports HTTP Range so <video> seeking works.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await ctx.params
    const found = await findArtifactForJob(jobId)
    if (!found) {
      return Response.json({ ok: false, error: 'No artifact for this video (yet)' }, { status: 404 })
    }
    const mp4 = await getArtifactMp4(found.artifactId, found.entry)

    const range = req.headers.get('range')
    const total = mp4.length
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    }

    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/)
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0
        const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1
        if (start <= end && start < total) {
          const chunk = mp4.subarray(start, end + 1)
          return new Response(new Uint8Array(chunk), {
            status: 206,
            headers: {
              ...baseHeaders,
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Content-Length': String(chunk.length),
            },
          })
        }
      }
    }

    return new Response(new Uint8Array(mp4), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) },
    })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
