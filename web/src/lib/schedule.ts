/**
 * Video schedule helpers (SCHEDULE_HOURS, Africa/Cairo).
 *
 * Videos are made ONLY at scheduled hours - default 11:00, 12:00, 13:00,
 * 15:00, 20:00 Africa/Cairo (the user's timezone). The hours live in the
 * `scheduleHours` app setting and are pushed to the repo as the
 * SCHEDULE_HOURS Actions variable on deploy, so the pipeline gate
 * (scripts/schedule_gate.py) and this app heartbeat always agree.
 */

export const SCHEDULE_TZ = 'Africa/Cairo'
export const DEFAULT_SCHEDULE_HOURS = '11,12,13,15,20'

/** "11,12, 13" -> [11,12,13] (invalid entries dropped, sorted, deduped). */
export function parseScheduleHours(raw: string | undefined | null): number[] {
  const hours = new Set<number>()
  for (const part of String(raw ?? '').split(',')) {
    const h = Number.parseInt(part.trim(), 10)
    if (Number.isInteger(h) && h >= 0 && h <= 23) hours.add(h)
  }
  if (hours.size === 0) return parseScheduleHours(DEFAULT_SCHEDULE_HOURS)
  return [...hours].sort((a, b) => a - b)
}

/** "11,12,13,15,20" -> "11:00, 12:00, 13:00, 15:00, 20:00" */
export function formatScheduleHours(raw: string | undefined | null): string {
  return parseScheduleHours(raw).map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')
}

interface CairoParts {
  year: number
  month: number
  day: number
  hour: number
}

/** Wall-clock parts of a Date in Africa/Cairo (no external deps). */
function cairoParts(d: Date): CairoParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
  }
}

/** Slot key of "now" in Cairo: "YYYY-MM-DDTHH" (matches schedule_gate.py). */
export function cairoSlotKey(d: Date = new Date()): string {
  const p = cairoParts(d)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}`
}

/** Is the given moment inside a scheduled hour (Cairo time)? */
export function isScheduledHour(hoursRaw: string | undefined | null, d: Date = new Date()): boolean {
  return parseScheduleHours(hoursRaw).includes(cairoParts(d).hour)
}

/** Slot key of a run's created_at in Cairo (null for unparseable dates). */
export function runSlotKey(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return null
  return cairoSlotKey(d)
}

/**
 * Next scheduled slot at/after `from` (Cairo). Returns the Cairo wall-clock
 * hour and its UTC Date, or null when the schedule is empty (never).
 */
export function nextSlot(
  hoursRaw: string | undefined | null,
  from: Date = new Date()
): { hour: number; at: Date } | null {
  const hours = parseScheduleHours(hoursRaw)
  if (hours.length === 0) return null
  const p = cairoParts(from)
  // walk forward hour by hour (max 24h) until we land in a scheduled hour;
  // "at" starts strictly after `from` so the current slot isn't returned
  for (let i = 0; i <= 24; i++) {
    const probe = new Date(from.getTime() + i * 3600_000 + (i === 0 ? 60_000 : 0))
    const pp = cairoParts(probe)
    const sameSlot = pp.year === p.year && pp.month === p.month && pp.day === p.day && pp.hour === p.hour
    if (sameSlot) continue
    if (hours.includes(pp.hour)) return { hour: pp.hour, at: probe }
  }
  return null
}
