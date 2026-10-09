/**
 * Serverless DB bootstrap test — run with: bun scripts/test-db-serverless.ts
 *
 * Simulates a Vercel-style cold start: DATABASE_URL points at a MISSING file
 * (and no db/ dir contents), so the client must fall back to a writable /tmp
 * SQLite, create the schema idempotently, and serve normal queries.
 */
import fs from 'fs'

;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
process.env.DATABASE_URL = 'file:./db/does-not-exist.db'
try {
  fs.rmSync('/tmp/storypilot.db')
} catch {
  // not there yet — fine
}

async function main() {
  const { db } = await import('../src/lib/db')

  const setting = await db.setting.create({ data: { key: 'selftest', value: 'ok' } })
  console.log('1. create setting:', setting.key, '=', setting.value)
  const found = await db.setting.findUnique({ where: { key: 'selftest' } })
  if (!found || found.value !== 'ok') throw new Error('setting roundtrip failed')

  const chat = await db.chat.create({ data: { title: 'selftest chat' } })
  await db.message.create({ data: { chatId: chat.id, role: 'user', content: 'hi' } })
  const n = await db.message.count()
  console.log('2. chat + message count:', n)
  if (n < 1) throw new Error('message count failed')

  const story = await db.storyRecord.create({
    data: { tabGid: '0', tabName: 'selftest', title: 't', contentHash: 'h1' },
  })
  await db.videoJob.create({
    data: { title: 'v', storyRecordId: story.id, status: 'done' },
  })
  const withStory = await db.videoJob.findFirst({
    where: { storyRecordId: story.id },
    include: { story: true },
  })
  console.log('3. videoJob -> story relation:', withStory?.story?.title)
  if (withStory?.story?.title !== 't') throw new Error('relation query failed')

  await db.syncLog.create({ data: { tabsFound: 1, storiesSeen: 1 } })
  console.log('4. syncLog ok')

  if (!fs.existsSync('/tmp/storypilot.db')) throw new Error('expected /tmp/storypilot.db to exist')
  console.log('5. /tmp/storypilot.db exists — serverless fallback active')

  console.log('ALL DB SELFTESTS PASSED')
  process.exit(0)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
