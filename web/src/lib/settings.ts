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
        if (k === 'autoPost') (merged as Record<string, unknown>)[k] = r.value === 'true'
        else (merged as Record<string, unknown>)[k] = r.value
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
