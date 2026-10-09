import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'

/**
 * Serverless-resilient Prisma client.
 *
 * - Local dev: uses DATABASE_URL as before (e.g. file:./db/custom.db) whenever
 *   the target file exists — behaviour is unchanged for existing setups.
 * - Vercel / serverless: the deployment bundle is read-only and no db file
 *   ships with the repo, so the client falls back to a writable SQLite file in
 *   /tmp and bootstraps the schema itself (idempotent CREATE TABLE IF NOT
 *   EXISTS) before the first query. Ephemeral per-instance data is fine here:
 *   the Library rebuilds from GitHub artifacts and the sheet, so the source of
 *   truth is the repo + the sheet, never this SQLite file.
 */

const TMP_DB_PATH = '/tmp/storypilot.db'

/**
 * Exact DDL produced by `prisma migrate diff --from-empty` for prisma/schema.prisma
 * (SQLite provider), made idempotent with IF NOT EXISTS. Keep in sync with the
 * schema: regenerate with
 *   bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
 */
const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "Chat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tools" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "VideoJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "storyTitle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "source" TEXT NOT NULL DEFAULT 'sheet',
    "language" TEXT NOT NULL DEFAULT 'en',
    "platforms" TEXT NOT NULL DEFAULT '[]',
    "videoUrl" TEXT,
    "runId" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "storyRecordId" TEXT,
    "tabName" TEXT,
    "artifactId" TEXT,
    "artifactEntry" TEXT,
    "sizeBytes" INTEGER,
    "durationSec" REAL,
    "fps" INTEGER,
    "renderedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VideoJob_storyRecordId_fkey" FOREIGN KEY ("storyRecordId") REFERENCES "StoryRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "StoryRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tabGid" TEXT NOT NULL,
    "tabName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "logline" TEXT NOT NULL DEFAULT '',
    "genre" TEXT NOT NULL DEFAULT '',
    "duration" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'en',
    "scenes" INTEGER NOT NULL DEFAULT 0,
    "words" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "storyJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'new',
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "tabsFound" INTEGER NOT NULL DEFAULT 0,
    "storiesNew" INTEGER NOT NULL DEFAULT 0,
    "storiesSeen" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT
)`,
  `CREATE TABLE IF NOT EXISTS "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
)`,
]

/** Pick the SQLite file to use: the configured one when it exists, else a
 *  writable /tmp copy (Vercel functions only allow writes to /tmp). */
function resolveDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL || ''
  if (configured && !configured.startsWith('file:')) return configured
  const rel = (configured ? configured.slice('file:'.length) : './db/custom.db').split('?')[0]
  const abs = rel.startsWith('/') ? rel : path.join(process.cwd(), rel)
  try {
    if (fs.existsSync(abs)) return configured || `file:${rel.split('\\').join('/')}`
  } catch {
    // ignore FS errors and fall through to the serverless path
  }
  try {
    if (!fs.existsSync(TMP_DB_PATH)) fs.closeSync(fs.openSync(TMP_DB_PATH, 'w'))
    return `file:${TMP_DB_PATH}`
  } catch {
    // last resort: return the configured value and let Prisma surface the error
    return configured || 'file:./db/custom.db'
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createDb> | undefined
}

function createDb() {
  const url = resolveDatabaseUrl()
  const isDev = process.env.NODE_ENV === 'development'
  const base = new PrismaClient({
    datasources: { db: { url } },
    log: isDev ? ['query', 'error', 'warn'] : ['error'],
  })

  // Schema bootstrap for ephemeral serverless SQLite. Memoized; a failed
  // attempt clears the promise so the next operation retries.
  let schemaReady: Promise<void> | null = null
  const ensureSchema = (): Promise<void> => {
    if (!schemaReady) {
      schemaReady = (async () => {
        for (const stmt of SCHEMA_DDL) await base.$executeRawUnsafe(stmt)
      })().catch((e) => {
        schemaReady = null
        throw e
      })
    }
    return schemaReady
  }

  // Warm the schema right away at cold start (errors surface via the
  // middleware below, never as unhandled rejections).
  ensureSchema().catch(() => {})

  // Every model operation awaits the schema first — this closes the race
  // between the first incoming request and the DDL bootstrap.
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ query, args }) {
          await ensureSchema()
          return query(args)
        },
      },
    },
  })
}

export const db = globalForPrisma.prisma ?? createDb()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
