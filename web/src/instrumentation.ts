/**
 * Next.js instrumentation — runs once when the server boots (dev & production).
 * Starts the app-side hourly heartbeat that guarantees video renders even when
 * GitHub's cron scheduler drops ticks.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startHeartbeat } = await import('@/lib/heartbeat')
    startHeartbeat()
  }
}
