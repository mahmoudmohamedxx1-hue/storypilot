import { db } from '@/lib/db'

export interface AppSettings {
  chatModel: string
  chatProvider: 'zai' | 'freellmpool'
  flpModel: string
  sheetId: string
  githubToken: string
  githubRepo: string
  youtubeToken: string
  tiktokToken: string
  instagramToken: string
  autoPost: boolean
  voice: string
  /** continuous 24/7 render loop (back-to-back dispatches while stories are pending) */
  continuousMode: boolean
  /** parallel render workers per dispatched run (GitHub Actions matrix) */
  workers: number
  /** keyless AI polish pass (freellmpool on GitHub, GLM-5.3-Flash in the app) */
  aiEnhance: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  chatModel: 'glm-5.3-flash',
  chatProvider: 'zai',
  flpModel: 'glm-4.7-flash',
  sheetId: '1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4',
  githubToken: '',
  githubRepo: 'mahmoudmohamedxx1-hue/storypilot',
  youtubeToken: '',
  tiktokToken: '',
  instagramToken: '',
  autoPost: true,
  voice: 'ar-EG-ShakirNeural',
  continuousMode: true,
  workers: 3,
  aiEnhance: true,
}

const KEYS: (keyof AppSettings)[] = [
  'chatModel',
  'chatProvider',
  'flpModel',
  'sheetId',
  'githubToken',
  'githubRepo',
  'youtubeToken',
  'tiktokToken',
  'instagramToken',
  'autoPost',
  'voice',
  'continuousMode',
  'workers',
  'aiEnhance',
]

export async function getSettings(): Promise<AppSettings> {
  const merged: AppSettings = { ...DEFAULT_SETTINGS }
  // env fallback for github token (kept out of DB by default)
  if (process.env.GITHUB_TOKEN) merged.githubToken = process.env.GITHUB_TOKEN
  if (process.env.GITHUB_REPO) merged.githubRepo = process.env.GITHUB_REPO
  if (process.env.SHEET_ID) merged.sheetId = process.env.SHEET_ID
  try {
    const rows = await db.setting.findMany()
    for (const r of rows) {
      if ((KEYS as string[]).includes(r.key)) {
        const k = r.key as keyof AppSettings
        const target = merged as unknown as Record<string, unknown>
        if (k === 'autoPost' || k === 'continuousMode' || k === 'aiEnhance') {
          target[k] = r.value === 'true'
        } else if (k === 'workers') {
          target[k] = Math.max(1, Math.min(6, parseInt(r.value, 10) || 3))
        } else {
          target[k] = r.value
        }
      }
    }
  } catch {
    // DB not ready yet — fall back to defaults
  }
  return merged
}

export async function setSetting(key: string, value: string) {
  if (!(KEYS as string[]).includes(key)) throw new Error(`Unknown setting: ${key}`)
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

export function maskToken(t: string): string {
  if (!t) return ''
  if (t.length <= 10) return '••••••••'
  return `${t.slice(0, 6)}${'•'.repeat(18)}${t.slice(-4)}`
}

export function publicSettings(s: AppSettings) {
  return {
    ...s,
    githubToken: maskToken(s.githubToken),
    youtubeToken: maskToken(s.youtubeToken),
    tiktokToken: maskToken(s.tiktokToken),
    instagramToken: maskToken(s.instagramToken),
    hasGithubToken: !!s.githubToken,
    hasYoutubeToken: !!s.youtubeToken,
    hasTiktokToken: !!s.tiktokToken,
    hasInstagramToken: !!s.instagramToken,
  }
}
