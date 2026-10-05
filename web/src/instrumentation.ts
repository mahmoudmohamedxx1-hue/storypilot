/**
 * Next.js instrumentation — runs once when the server boots (dev & production).
 * Starts the CONTINUOUS RENDER LOOP: while the app runs, it keeps dispatching
 * the render workflow back-to-back whenever pending sheet stories exist, so
 * videos are generated continuously (not just on the hourly cron ticks).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startRenderLoop } = await import('@/lib/render-loop')
    startRenderLoop()
  }
}
