import { fetchSheetData } from '@/lib/sheet'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET() {
  try {
    const data = await fetchSheetData()
    return Response.json({ ok: true, ...data })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
