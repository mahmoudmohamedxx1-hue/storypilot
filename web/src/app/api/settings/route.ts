import { NextRequest } from 'next/server'
import { getSettings, setSetting, publicSettings, DEFAULT_SETTINGS } from '@/lib/settings'

export const runtime = 'nodejs'

export async function GET() {
  const s = await getSettings()
  return Response.json({ settings: publicSettings(s) })
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>
  const updated: string[] = []
  for (const [key, value] of Object.entries(body)) {
    if (key === 'autoPost') {
      await setSetting(key, value ? 'true' : 'false')
      updated.push(key)
    } else if (typeof value === 'string') {
      // ignore masked placeholder values (unchanged tokens)
      if (value.includes('••')) continue
      await setSetting(key, value)
      updated.push(key)
    }
  }
  const s = await getSettings()
  return Response.json({ ok: true, updated, settings: publicSettings(s) })
}

export async function POST(req: NextRequest) {
  // reset to defaults
  const { keys } = (await req.json()) as { keys?: string[] }
  const target = keys || Object.keys(DEFAULT_SETTINGS)
  for (const k of target) {
    await setSetting(k, String((DEFAULT_SETTINGS as Record<string, unknown>)[k]))
  }
  const s = await getSettings()
  return Response.json({ ok: true, settings: publicSettings(s) })
}
