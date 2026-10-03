import { NextRequest } from 'next/server'
import { syncSheet, getSyncState } from '@/lib/sync'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET() {
  try {
    const state = await getSyncState()
    return Response.json({ ok: true, ...state })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

/** POST = run a sync now (rate-limited server-side to 1 per 25s). */
export async function POST(_req: NextRequest) {
  try {
    const result = await syncSheet(false)
    const state = await getSyncState()
    return Response.json({ ok: result.ok, result, state, error: result.error })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
