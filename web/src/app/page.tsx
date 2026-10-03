'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from '@/components/agent/sidebar'
import { ChatView } from '@/components/agent/chat-view'
import { PipelineView } from '@/components/agent/pipeline-view'
import { LibraryView } from '@/components/agent/library-view'
import { StoriesView } from '@/components/agent/stories-view'
import { PlatformsView } from '@/components/agent/platforms-view'
import { WorkflowsView } from '@/components/agent/workflows-view'
import { SettingsView } from '@/components/agent/settings-view'
import { useApp } from '@/components/agent/store'

export default function Home() {
  const [collapsed, setCollapsed] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const view = useApp((s) => s.view)

  return (
    <div className="h-screen w-screen overflow-hidden flex bg-white relative">
      {/* desktop sidebar */}
      <div className="hidden md:flex h-full">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </div>

      {/* mobile drawer */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-40" role="dialog" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 shadow-2xl">
            <Sidebar collapsed={false} onToggle={() => setDrawer(false)} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      {/* mobile menu button */}
      {!drawer && (
        <button
          onClick={() => setDrawer(true)}
          className="md:hidden absolute top-3 left-3 z-30 w-9 h-9 rounded-full bg-white border border-[#E5E7EB] shadow-sm flex items-center justify-center text-[#4a4f58] hover:border-[#315CEA]/50 hover:text-[#315CEA] transition-colors"
          aria-label="Open navigation"
        >
          <Menu size={17} />
        </button>
      )}

      <main className="flex-1 min-w-0 h-full">
        {view === 'chat' && <ChatView />}
        {view === 'pipeline' && <PipelineView />}
        {view === 'library' && <LibraryView />}
        {view === 'stories' && <StoriesView />}
        {view === 'platforms' && <PlatformsView />}
        {view === 'workflows' && <WorkflowsView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
