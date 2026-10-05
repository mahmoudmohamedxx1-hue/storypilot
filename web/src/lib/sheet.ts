import { createHash } from 'crypto'
import { getSettings } from '@/lib/settings'

export interface Scene {
  index: number
  timeRange: string
  heading?: string
  visual: string
  aiPrompt: string
  voiceover: string
  sfx: string
}

export interface Story {
  title: string
  logline: string
  genre: string
  duration: string
  scenes: Scene[]
  narration: string
  language: string
  totalWords: number
}

export interface SheetTab {
  gid: string
  name: string
}

export interface SheetData {
  stories: Story[]
  pythonCode: string
  codeMeta: Record<string, string>
  fetchedAt: string
}

export const CODE_TAB_NAME = 'كود بايثون - المولد الآلي'

/* ------------------------------ low-level csv ------------------------------ */

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StoryPilotAgent/1.0)' },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status}). Make sure the sheet is shared as "Anyone with the link".`)
  return res.text()
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else inQuotes = false
      } else cell += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/* ------------------------------- helpers ---------------------------------- */

export function detectLanguage(t: string): string {
  const arabic = (t.match(/[\u0600-\u06FF]/g) || []).length
  const latin = (t.match(/[a-zA-Z]/g) || []).length
  return arabic > latin ? 'ar' : 'en'
}

function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function clean(s: string, max = 900): string {
  const t = stripHtml(String(s || ''))
    .replace(/\\n/g, ' ')
    .replace(/[\u0000-\u001F]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

const TIME_RE = /^\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}$/
function looksLikeTime(s: string): boolean {
  return TIME_RE.test((s || '').trim().replace(/\s+/g, ' '))
}

function timeRangeToSec(label: string): number {
  const m = (label || '').match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/)
  if (!m) return 0
  const toSec = (mm: string, ss: string) => parseInt(mm, 10) * 60 + parseInt(ss, 10)
  return Math.max(0, toSec(m[3], m[4]) - toSec(m[1], m[2]))
}

function durationFromRanges(scenes: { timeRange: string }[]): string {
  const total = scenes.reduce((acc, s) => acc + timeRangeToSec(s.timeRange), 0)
  return total > 0 ? `${total} seconds` : ''
}

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex')
}

/* --------------------------- tab discovery -------------------------------- */

/** Lists every tab of the sheet (keyless, via the public htmlview page). */
export async function listTabs(sheetIdOverride?: string): Promise<SheetTab[]> {
  const settings = await getSettings()
  const sheetId = sheetIdOverride || settings.sheetId
  const html = await fetchCsv(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`)
  const tabs: SheetTab[] = []
  const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:[^"]*"[^"]*gid=(\d+)",\s*gid:\s*"(\d+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const name = m[1]
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .trim()
    if (name) tabs.push({ gid: m[2], name })
  }
  if (!tabs.length) tabs.push({ gid: '0', name: 'Sheet' })
  return tabs
}

export function isCodeTab(name: string): boolean {
  const n = (name || '').trim()
  return n === CODE_TAB_NAME || n.includes('كود بايثون') || n.includes('المولد الآلي') || /python code/i.test(n)
}

export async function fetchTabCsv(sheetId: string, gid: string): Promise<string> {
  return fetchCsv(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`)
}

/* ------------------------ universal story parser --------------------------- */

const META_MAP: Record<string, string> = {
  'story title': 'title', 'العنوان': 'title', 'video title': 'title',
  'title': 'title', 'عنوان الفيديو': 'title',
  'logline': 'logline', 'الفقرة التعريفية': 'logline',
  'genre': 'genre', 'النوع': 'genre',
  'target duration': 'duration', 'المدة المستهدفة': 'duration', 'المدة': 'duration', 'duration': 'duration',
  'hook': 'hook', 'الخطاف الجاذب': 'hook', 'الخطاف': 'hook',
  'core lesson': 'lesson', 'الدرس الأساسي': 'lesson', 'الدرس': 'lesson',
  'complete voiceover narration': 'narration', 'التعليق الصوتي الكامل': 'narration',
}

interface StoryDraft {
  title: string
  logline: string
  genre: string
  duration: string
  hook: string
  lesson: string
  narration: string
  scenes: Scene[]
  narrationAnchor: boolean
}

function newDraft(): StoryDraft {
  return { title: '', logline: '', genre: '', duration: '', hook: '', lesson: '', narration: '', scenes: [], narrationAnchor: false }
}

function normalizeDraft(d: StoryDraft): Story | null {
  if (!d.scenes.length) return null
  const title = clean(d.title, 160) || 'Untitled Story'
  const logline = clean(d.hook || d.logline || d.lesson, 400)
  const narration = d.narration || d.scenes.map((s) => s.voiceover).filter(Boolean).join(' ')
  return {
    title,
    logline,
    genre: clean(d.genre, 80),
    duration: d.duration || durationFromRanges(d.scenes) || '60 Seconds',
    scenes: d.scenes.map((s, i) => ({ ...s, index: i + 1 })),
    narration: clean(narration, 4000),
    language: detectLanguage(`${title} ${narration}`),
    totalWords: narration.split(/\s+/).filter(Boolean).length,
  }
}

/** meta key:value hidden in adjacent cells of a row */
function rowMeta(cells: string[]): { key: string; value: string } | null {
  for (let i = 0; i < cells.length - 1; i++) {
    const label = cells[i].replace(/[::\s]+$/, '').trim().toLowerCase()
    if (label && META_MAP[label] && cells[i + 1]) return { key: META_MAP[label], value: cells[i + 1].trim() }
  }
  return null
}

/** concatenated labels in one cell + concatenated values in the next (Arabic/batch tabs) */
function rowConcatMeta(cells: string[]): { key: string; value: string } | null {
  for (let i = 0; i < cells.length - 1; i++) {
    const low = cells[i].toLowerCase()
    const hasTitle = /عنوان الفيديو|story title/.test(low) || /^title:/.test(low)
    const joinedLabels = (low.match(/عنوان|duration|hook|المدة|الخطاف|الدرس|title/g) || []).length
    if (hasTitle && joinedLabels >= 3 && cells[i + 1] && cells[i + 1].length > 3) {
      return { key: 'title', value: cells[i + 1].trim() }
    }
  }
  return null
}

/** tracker section anchor: "The Magic of Compound Interest (150 seconds (2.5 mins))" */
function rowSectionAnchor(cells: string[]): { title: string; duration: string } | null {
  const nonEmpty = cells.filter(Boolean)
  if (nonEmpty.length > 2) return null
  for (const c of nonEmpty) {
    const m = c.match(/^(.{4,120}?)\s*\((\d+(?:\.\d+)?\s*(?:seconds?|ثانية|mins?|minutes?|دقيقة)[\s\S]*?)\)$/i)
    if (m && !/^\d/.test(m[1].trim())) return { title: m[1].trim(), duration: m[2].trim() }
  }
  return null
}

function splitConcatValue(value: string): { title: string; duration: string; hook: string } {
  const durM = value.match(/(\d+)\s*(?:ثانية|seconds?)\s*(?:\(([^)]*)\))?/i)
  let title = value
  let duration = ''
  let hook = ''
  if (durM) {
    title = value.slice(0, durM.index ?? 0).trim()
    duration = durM[0].trim()
    hook = clean(value.slice((durM.index ?? 0) + durM[0].length), 400)
  } else {
    title = clean(value, 160)
  }
  return { title, duration, hook }
}

type SceneFormat = 'story' | 'numbered' | 'tracker' | 'arabic'

function detectSceneHeader(cells: string[]): SceneFormat | null {
  const joined = cells.join(' ').toLowerCase()
  if (cells.some((c) => c === 'Scene #' || c === 'المشهد')) return 'story'
  if (cells.includes('Time / Scene') || (joined.includes('scene title') && joined.includes('voiceover'))) return 'tracker'
  if (cells.includes('التوقيت') && joined.includes('عنوان المشهد')) return 'arabic'
  if (joined.includes('visual scene description') && joined.includes('duration')) return 'story'
  return null
}

function parseSceneRow(cells: string[], fmt: SceneFormat): Scene | null {
  const c = cells.map((x) => x.trim())
  if (fmt === 'story') {
    if (!c[0] || !/^scene\s*\d+$|^المشهد\s*\d*$/i.test(c[0]) || !looksLikeTime(c[1] || '')) return null
    return {
      index: 0, timeRange: c[1], visual: clean(c[2], 900), aiPrompt: clean(c[3], 600),
      voiceover: clean(c[4], 1400), sfx: clean(c[5], 120),
    }
  }
  if (fmt === 'numbered' || fmt === 'arabic') {
    const i = c.findIndex((x) => x !== '')
    if (i < 0 || !/^\d{1,2}$/.test(c[i]) || !looksLikeTime(c[i + 1] || '')) return null
    return {
      index: parseInt(c[i], 10), timeRange: c[i + 1], heading: clean(c[i + 2], 120),
      visual: clean(c[i + 3], 900), aiPrompt: clean(c[i + 2], 600), voiceover: clean(c[i + 4], 1400), sfx: '',
    }
  }
  // tracker: [time, scene title, visual, voiceover]
  const i = c.findIndex((x) => x !== '')
  if (i < 0 || !looksLikeTime(c[i])) return null
  return {
    index: 0, timeRange: c[i], heading: clean(c[i + 1], 120),
    visual: clean(c[i + 2], 900), aiPrompt: clean(c[i + 1], 600), voiceover: clean(c[i + 3], 1400), sfx: '',
  }
}

const PURE_DURATION_RE = /^(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|ثانية)\s*(?:\([^)]*\))?$/i

/**
 * Parses ANY story tab into one or more stories.
 * Handles: Story format, Batch format (EN/AR), multi-video trackers.
 */
export function parseTabStories(rows: string[][], _tabName: string): Story[] {
  const drafts: StoryDraft[] = []
  let cur = newDraft()
  let fmt: SceneFormat | null = null
  let inNarration = false

  // orphan section rows (title-only / duration-only / hook / lesson) between videos
  let pendingTitle: string | null = null
  let pendingDuration: string | null = null
  let pendingHook: string | null = null
  let pendingLesson: string | null = null

  const resetPendings = () => {
    pendingTitle = null; pendingDuration = null; pendingHook = null; pendingLesson = null
  }

  const pendingsReady = () => pendingTitle !== null || pendingDuration !== null

  const finalize = () => {
    if (cur.title || cur.scenes.length) drafts.push(cur)
    cur = newDraft()
  }

  /** a new video section begins — apply collected orphan rows, then start fresh */
  const startSection = () => {
    finalize()
    if (pendingTitle) cur.title = clean(pendingTitle, 160)
    if (pendingDuration) cur.duration = clean(pendingDuration, 60)
    if (pendingHook) cur.hook = clean(pendingHook, 400)
    if (pendingLesson) cur.lesson = clean(pendingLesson, 400)
    resetPendings()
  }

  for (const rawRow of rows) {
    const cells = rawRow.map((x) => String(x || '').trim())

    // narration continuation (Story format: rows after the "Complete Voiceover Narration" label)
    if (inNarration) {
      const line = cells.filter(Boolean).join(' ').trim()
      if (line) {
        cur.narration = (cur.narration ? cur.narration + ' ' : '') + clean(line, 800)
        continue
      }
      inNarration = false
    }

    // concatenated meta FIRST (labels + values joined in single cells — these rows often
    // also contain scene-header words and must not be eaten by the header detector)
    const concat = rowConcatMeta(cells)
    if (concat) {
      if (cur.scenes.length > 0 || pendingsReady()) startSection()
      const { title, duration, hook } = splitConcatValue(concat.value)
      if (title) cur.title = clean(title, 160)
      if (duration) cur.duration = clean(duration, 60)
      if (hook) cur.hook = clean(hook, 400)
      continue
    }

    // scene table header
    const headerFmt = detectSceneHeader(cells)
    if (headerFmt) {
      if (pendingsReady()) startSection()
      fmt = headerFmt
      inNarration = false
      continue
    }

    // scene row (known format, or sniffed for headerless batch tabs)
    let scene: Scene | null = fmt ? parseSceneRow(cells, fmt) : null
    if (!scene) {
      const sniff = parseSceneRow(cells, 'numbered') || parseSceneRow(cells, 'tracker')
      if (sniff) {
        scene = sniff
        if (!fmt) fmt = 'numbered'
      }
    }
    if (scene) {
      if (pendingsReady()) startSection()
      cur.scenes.push(scene)
      continue
    }

    // adjacent-cell meta (explicit "Label: value" rows — never treat these as anchors)
    const meta = rowMeta(cells)
    if (meta) {
      if ((meta.key === 'title' || meta.key === 'hook') && cur.scenes.length > 0) {
        finalize()
        resetPendings()
      }
      if (meta.key === 'title') cur.title = clean(meta.value, 160)
      else if (meta.key === 'logline') cur.logline = clean(meta.value, 400)
      else if (meta.key === 'genre') cur.genre = clean(meta.value, 80)
      else if (meta.key === 'duration') cur.duration = clean(meta.value, 60)
      else if (meta.key === 'hook') cur.hook = clean(meta.value, 400)
      else if (meta.key === 'lesson') cur.lesson = clean(meta.value, 400)
      else if (meta.key === 'narration') {
        inNarration = true
        if (meta.value && !/^[-–—:]*$/.test(meta.value)) cur.narration = clean(meta.value, 800)
      }
      continue
    }

    // tracker section anchor "Title (duration)"
    const anchor = rowSectionAnchor(cells)
    if (anchor) {
      if (cur.scenes.length || cur.title || pendingsReady()) startSection()
      cur.title = clean(anchor.title, 160)
      cur.duration = clean(anchor.duration, 60)
      continue
    }

    // tracker top-list rows: ["", "Some Title", "150 seconds (2.5 mins)"] → pre-register the video
    const nonEmptyRaw = cells.filter(Boolean)
    if (nonEmptyRaw.length === 2) {
      const durIdx = cells.findIndex((x) => /^\d+\s*(?:seconds?|ثانية)/i.test(x) || /^\d+\s*(?:mins?|minutes?|دقيقة)/i.test(x))
      if (durIdx > 0 && cells[durIdx - 1] && !looksLikeTime(cells[durIdx - 1])) {
        if (cur.scenes.length) { finalize(); resetPendings() }
        cur.title = clean(cells[durIdx - 1], 160)
        cur.duration = clean(cells[durIdx], 60)
        continue
      }
    }

    // orphan single-text rows between videos: title / duration / hook / lesson
    if (nonEmptyRaw.length === 1) {
      const raw = nonEmptyRaw[0]
      // skip HTML / animation-code blocks (HyperFrames cues, gsap scripts, svg)
      if (/<\/?[a-z][\s>]|gsap\.|@keyframes|[{};]|\.svg/i.test(raw)) continue
      const txt = clean(raw, 500)
      if (!txt) continue
      if (PURE_DURATION_RE.test(txt)) {
        if (!pendingDuration) pendingDuration = txt
      } else if (!looksLikeTime(txt) && txt.length >= 4) {
        if (pendingTitle === null) pendingTitle = txt
        else if (pendingHook === null) pendingHook = txt
        else if (pendingLesson === null) pendingLesson = txt
      }
      continue
    }
  }
  finalize()

  // normalize + dedupe by title (prefer drafts with scenes)
  const byTitle = new Map<string, Story>()
  for (const d of drafts) {
    const st = normalizeDraft(d)
    if (!st) continue
    const key = st.title.toLowerCase().replace(/\s+/g, ' ').trim()
    const prev = byTitle.get(key)
    if (!prev || st.scenes.length > prev.scenes.length) byTitle.set(key, st)
  }
  return [...byTitle.values()]
}

/* ----------------------------- code tab ----------------------------------- */

function parseCodeTab(rows: string[][]): { code: string; meta: Record<string, string> } {
  const meta: Record<string, string> = {}
  let codeStart = -1
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map((c) => c.trim())
    if (!r[1]) continue
    if (r[1].startsWith('import ') || r[1].startsWith('#!')) { codeStart = i; break }
    if (r[0]) meta[r[0].replace(/:$/, '')] = r[1]
  }
  let code = ''
  if (codeStart >= 0) {
    const lines: string[] = []
    for (let i = codeStart; i < rows.length; i++) {
      const r = rows[i]
      const line = r.length > 1 ? r.slice(1).join(',') : (r[0] || '')
      lines.push(line)
    }
    code = lines.join('\n')
  }
  return { code, meta }
}

/* --------------------------- public endpoints ------------------------------ */

/** Back-compat: current story (first tab) + generator code tab. */
export async function fetchSheetData(sheetIdOverride?: string): Promise<SheetData> {
  const settings = await getSettings()
  const sheetId = sheetIdOverride || settings.sheetId
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}`
  const [storyCsv, codeCsv] = await Promise.all([
    fetchCsv(`${base}/export?format=csv`),
    fetchCsv(`${base}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CODE_TAB_NAME)}`).catch(() => ''),
  ])
  const stories = parseTabStories(parseCsv(storyCsv), 'Story 1')
  let pythonCode = ''
  let codeMeta: Record<string, string> = {}
  if (codeCsv) {
    const parsed = parseCodeTab(parseCsv(codeCsv))
    pythonCode = parsed.code
    codeMeta = parsed.meta
  }
  return {
    stories: stories.length ? stories : [{
      title: 'Untitled Story', logline: '', genre: '', duration: '60 Seconds',
      scenes: [], narration: '', language: 'en', totalWords: 0,
    }],
    pythonCode,
    codeMeta,
    fetchedAt: new Date().toISOString(),
  }
}

/** Stable content hash used to detect story changes between syncs. */
export function storyHash(st: {
  title: string
  duration?: string
  scenes: Array<{ timeRange: string; heading?: string; visual: string; voiceover: string }>
}): string {
  const norm = JSON.stringify({
    t: st.title.toLowerCase().replace(/\s+/g, ' ').trim(),
    d: (st.duration || '').toLowerCase(),
    s: (st.scenes || []).map((x) => [
      x.timeRange, (x.heading || '').toLowerCase(), x.visual.toLowerCase(), x.voiceover.toLowerCase(),
    ]),
  })
  return md5(norm)
}
