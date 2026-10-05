'use client'

// Global client error boundary — keeps the app alive if any view throws unexpectedly.
// The user should NEVER see the white "Application error" dead screen.

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // surface it in the console for debugging
    console.error('[StoryPilot] view crashed, recovered by error boundary:', error)
  }, [error])

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-[#E5E7EB] bg-white p-8 text-center shadow-sm">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#FFF4E5] text-[#b45309]">
          <AlertTriangle size={22} />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-[#1a1c20]">Something hiccuped</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-[#6b7280]">
          A part of the app hit an unexpected error and was safely contained — the rest of
          StoryPilot is still running. Your data and the hourly pipeline are not affected.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button size="sm" className="gap-1.5 bg-[#315CEA] hover:bg-[#2a50d4]" onClick={reset}>
            <RefreshCw size={13} /> Try again
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              window.location.href = '/'
            }}
          >
            Back to chat
          </Button>
        </div>
        {error?.message && (
          <p className="mt-4 truncate rounded-lg bg-[#F9FAFB] px-3 py-2 font-mono text-[10.5px] text-[#9aa0ab]">
            {error.message}
          </p>
        )}
      </div>
    </div>
  )
}
