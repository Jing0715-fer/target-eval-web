import { create } from 'zustand';

interface ScriptStore {
  selectedScriptId: string | null;
  searchQuery: string;
  selectedCategory: string;
  viewMode: 'grid' | 'list';
  sidebarOpen: boolean;
  setSelectedScript: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: string) => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  toggleSidebar: () => void;
}

export const useScriptStore = create<ScriptStore>((set) => ({
  selectedScriptId: null,
  searchQuery: '',
  selectedCategory: 'All',
  viewMode: 'grid',
  sidebarOpen: true,
  setSelectedScript: (id) => set({ selectedScriptId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedCategory: (category) => set({ selectedCategory: category }),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));
