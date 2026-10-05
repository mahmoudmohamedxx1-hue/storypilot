'use client'

import { create } from 'zustand'

export type View = 'chat' | 'pipeline' | 'library' | 'stories' | 'platforms' | 'workflows' | 'settings'

export interface ChatListItem {
  id: string
  title: string
  updatedAt: string
}

interface AppState {
  view: View
  activeChatId: string | null
  chats: ChatListItem[]
  chatsVersion: number
  modelLabel: string
  syncVersion: number
  setView: (v: View) => void
  setActiveChat: (id: string | null) => void
  setChats: (chats: ChatListItem[]) => void
  bumpChats: () => void
  setModelLabel: (m: string) => void
  bumpSync: () => void
}

export const useApp = create<AppState>((set) => ({
  view: 'chat',
  activeChatId: null,
  chats: [],
  chatsVersion: 0,
  modelLabel: 'GLM-5.3-Flash',
  syncVersion: 0,
  setView: (view) => set({ view }),
  setActiveChat: (activeChatId) => set({ activeChatId }),
  setChats: (chats) => set({ chats }),
  bumpChats: () => set((s) => ({ chatsVersion: s.chatsVersion + 1 })),
  setModelLabel: (modelLabel) => set({ modelLabel }),
  bumpSync: () => set((s) => ({ syncVersion: s.syncVersion + 1 })),
}))
