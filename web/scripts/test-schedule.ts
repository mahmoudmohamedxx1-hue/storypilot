/* Unit tests for src/lib/schedule.ts (Cairo timezone, no external deps) */
import { parseScheduleHours, formatScheduleHours, cairoSlotKey, isScheduledHour, runSlotKey, nextSlot } from '../src/lib/schedule'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

console.log('== parseScheduleHours ==')
check('default', JSON.stringify(parseScheduleHours(undefined)) === '[11,12,13,15,20]')
check('parses + sorts + dedupes', JSON.stringify(parseScheduleHours('20, 11,11, 13')) === '[11,13,20]')
check('drops invalid', JSON.stringify(parseScheduleHours('x,25,-1,9')) === '[9]')
check('empty -> default', JSON.stringify(parseScheduleHours('')) === '[11,12,13,15,20]')

console.log('== formatScheduleHours ==')
check('formats', formatScheduleHours('11,12,13,15,20') === '11:00, 12:00, 13:00, 15:00, 20:00')

console.log('== Cairo timezone (UTC+3 summer / UTC+2 winter) ==')
// 2026-07-01 08:07 UTC == 11:07 Cairo (DST) -> scheduled hour
check('Jul 08:07 UTC = Cairo slot 11', cairoSlotKey(new Date('2026-07-01T08:07:00Z')) === '2026-07-01T11')
// 2026-12-01 09:07 UTC == 11:07 Cairo (no DST) -> scheduled hour
check('Dec 09:07 UTC = Cairo slot 11', cairoSlotKey(new Date('2026-12-01T09:07:00Z')) === '2026-12-01T11')
// 2026-07-01 10:07 UTC == 13:07 Cairo -> scheduled hour 13
check('Jul 10:07 UTC = Cairo slot 13', cairoSlotKey(new Date('2026-07-01T10:07:00Z')) === '2026-07-01T13')
// 2026-07-01 11:07 UTC == 14:07 Cairo -> NOT scheduled
check('Jul 11:07 UTC = Cairo slot 14', cairoSlotKey(new Date('2026-07-01T11:07:00Z')) === '2026-07-01T14')

console.log('== isScheduledHour ==')
check('11:30 Cairo scheduled', isScheduledHour('11,12,13,15,20', new Date('2026-07-01T08:30:00Z')) === true)
check('14:30 Cairo not scheduled', isScheduledHour('11,12,13,15,20', new Date('2026-07-01T11:30:00Z')) === false)
check('03:00 Cairo night not scheduled', isScheduledHour('11,12,13,15,20', new Date('2026-07-01T00:00:00Z')) === false)
check('20:59 Cairo scheduled', isScheduledHour('11,12,13,15,20', new Date('2026-07-01T17:59:00Z')) === true)
check('winter 11:00 Cairo scheduled (09:00 UTC)', isScheduledHour('11,12,13,15,20', new Date('2026-12-01T09:00:00Z')) === true)

console.log('== runSlotKey ==')
check('run created_at -> Cairo slot', runSlotKey('2026-07-01T08:07:00Z') === '2026-07-01T11')
check('null-safe', runSlotKey(null) === null && runSlotKey('garbage') === null)

console.log('== nextSlot ==')
// 2026-07-01 at 11:10 UTC = 14:10 Cairo; next scheduled hour is 15:00 Cairo = 12:00 UTC
const nx = nextSlot('11,12,13,15,20', new Date('2026-07-01T11:10:00Z'))
check('next slot after 14:10 Cairo is 15:00', nx?.hour === 15, `got ${nx?.hour}`)
// 21:00 Cairo (18:00 UTC) -> next slot is 11:00 TOMORROW
const nx2 = nextSlot('11,12,13,15,20', new Date('2026-07-01T18:00:00Z'))
check('after 20:59 -> next is 11 tomorrow', nx2?.hour === 11, `got ${nx2?.hour}`)
check('next slot is in the future', nx2 ? nx2.at.getTime() > new Date('2026-07-01T18:00:00Z').getTime() : false)
// inside a scheduled hour -> the NEXT slot, not the current one
const nx3 = nextSlot('11,12,13,15,20', new Date('2026-07-01T08:10:00Z')) // 11:10 Cairo
check('inside 11:00 slot -> next is 12:00', nx3?.hour === 12, `got ${nx3?.hour}`)

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} (${pass} passed)`)
process.exit(fail ? 1 : 0)
