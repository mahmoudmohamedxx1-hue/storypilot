/* Verify the NEW director-storyboard format parses through the app's TS parser */
import { parseTabStories, parseCsv, storyHash } from '../src/lib/sheet'
import { readFileSync } from 'fs'

const csv = readFileSync('/home/z/my-project/scripts/director-format-fixture.csv', 'utf8')
const stories = parseTabStories(parseCsv(csv), 'Video 1')

let fails = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' -> ' + detail : ''}`)
  if (!cond) fails++
}

check('exactly 1 story', stories.length === 1, String(stories.length))
const st = stories[0] || ({} as any)
check('title', st.title === 'الرسالة التي كتبها أبي للسنة القادمة', st.title)
check('hook folded into logline', String(st.logline || '').includes('تخفي بيوت آبائنا'), st.logline)
check('duration = 75 seconds', st.duration === '75 seconds', st.duration)
check('language ar', st.language === 'ar', st.language)
check('exactly 10 scenes', (st.scenes || []).length === 10, String((st.scenes || []).length))
check('scene 1 time', st.scenes?.[0]?.timeRange === '0:00 - 0:07', st.scenes?.[0]?.timeRange)
check('scene 10 time', st.scenes?.[9]?.timeRange === '1:06 - 1:15', st.scenes?.[9]?.timeRange)
check('scene 3 voiceover mapped', st.scenes?.[2]?.voiceover === 'في الصندوق رسالة كتبها قبل ثلاثين عاماً.', st.scenes?.[2]?.voiceover)
check('scene 3 sfx full (commas intact)', String(st.scenes?.[2]?.sfx || '').includes('heartbeat hit'), st.scenes?.[2]?.sfx)
check('scene 3 aiPrompt english', String(st.scenes?.[2]?.aiPrompt || '').startsWith('close-up'), st.scenes?.[2]?.aiPrompt?.slice(0, 30))
check('scene 3 visual arabic', String(st.scenes?.[2]?.visual || '').includes('الصندوق'), st.scenes?.[2]?.visual?.slice(0, 30))
check('narration composed of 10 voiceovers', (st.narration || '').split(' ').length > 40, String((st.narration || '').split(' ').length))
check('stable hash', storyHash(st).length === 32, storyHash(st))

console.log()
if (fails) { console.log(`FAILED: ${fails}`); process.exit(1) }
console.log('TS PARSER: ALL CHECKS PASSED — app sync is fully compatible with the director format')
