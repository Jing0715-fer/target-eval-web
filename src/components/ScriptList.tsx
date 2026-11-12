'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutGrid,
  List,
  GitBranch,
  Upload,
  Loader2,
  FileQuestion,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScriptCard, type ScriptData } from '@/components/ScriptCard';
import { useScriptStore } from '@/store/script-store';
import { toast } from 'sonner';

interface ScriptListProps {
  onUploadClick: () => void;
}

export function ScriptList({ onUploadClick }: ScriptListProps) {
  const queryClient = useQueryClient();
  const { searchQuery, selectedCategory, viewMode, setSelectedScript } = useScriptStore();
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch scripts
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['scripts', selectedCategory],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedCategory && selectedCategory !== 'All') {
        params.set('category', selectedCategory);
      }
      const res = await fetch(`/api/scripts?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch scripts');
      return res.json();
    },
  });

  // Seed from GitHub
  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/seed');
      if (!res.ok) throw new Error('Failed to import scripts');
      return res.json();
    },
    onSuccess: (data) => {
      toast.success(data.message || `Imported ${data.imported} scripts`);
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
    onError: () => {
      toast.error('Failed to import scripts from GitHub');
    },
  });

  // Delete script
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/scripts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete script');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Script deleted');
      setSelectedScript(null);
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
    onError: () => {
      toast.error('Failed to delete script');
    },
  });

  // Duplicate script
  const duplicateMutation = useMutation({
    mutationFn: async (script: ScriptData) => {
      const res = await fetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${script.name} (copy)`,
          description: script.description,
          filename: script.filename.replace(/(\.\w+)$/, '-copy$1'),
          content: script.content,
          category: script.category,
          language: script.language,
          source: 'manual',
          params: script.params,
        }),
      });
      if (!res.ok) throw new Error('Failed to duplicate script');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Script duplicated');
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
    onError: () => {
      toast.error('Failed to duplicate script');
    },
  });

  // Filter scripts by search query
  const scripts: ScriptData[] = (data?.scripts || []).filter((script: ScriptData) => {
    if (!debouncedSearch) return true;
    const q = debouncedSearch.toLowerCase();
    return (
      script.name.toLowerCase().includes(q) ||
      script.description?.toLowerCase().includes(q) ||
      script.filename.toLowerCase().includes(q) ||
      script.category.toLowerCase().includes(q)
    );
  });

  // Skeleton loading
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <div className="h-8 w-20 animate-pulse rounded-lg bg-muted" />
          <div className="h-8 w-20 animate-pulse rounded-lg bg-muted" />
          <div className="flex-1" />
          <div className="h-8 w-20 animate-pulse rounded-lg bg-muted" />
        </div>
        <div
          className={
            viewMode === 'grid'
              ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'
              : 'flex flex-col gap-3'
          }
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Compact toolbar - no duplicate search or category tabs */}
      <div className="flex items-center gap-2">
        <Button
          variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => useScriptStore.getState().setViewMode('grid')}
          title="Grid view"
        >
          <LayoutGrid className="size-4" />
        </Button>
        <Button
          variant={viewMode === 'list' ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => useScriptStore.getState().setViewMode('list')}
          title="List view"
        >
          <List className="size-4" />
        </Button>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="xs"
          onClick={() => seedMutation.mutate()}
          disabled={seedMutation.isPending}
        >
          {seedMutation.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <GitBranch className="size-3" />
          )}
          Import
        </Button>
        <Button variant="outline" size="xs" onClick={onUploadClick}>
          <Upload className="size-3" />
          Upload
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => refetch()} title="Refresh">
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {/* Error state */}
      {isError && (
        <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <p>Failed to load scripts.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!isError && scripts.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <FileQuestion className="size-12 text-muted-foreground/50" />
          <div className="text-center">
            <p className="font-medium">No scripts found</p>
            <p className="text-sm mt-1">
              {debouncedSearch
                ? 'Try a different search query'
                : 'Import from GitHub or upload a script to get started'}
            </p>
          </div>
          {!debouncedSearch && (
            <div className="flex gap-2 mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => seedMutation.mutate()}
                disabled={seedMutation.isPending}
              >
                <GitBranch className="size-4" />
                Import from GitHub
              </Button>
              <Button variant="outline" size="sm" onClick={onUploadClick}>
                <Upload className="size-4" />
                Upload Script
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Script grid/list */}
      {!isError && scripts.length > 0 && (
        <div
          className={
            viewMode === 'grid'
              ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'
              : 'flex flex-col gap-3'
          }
        >
          {scripts.map((script) => (
            <ScriptCard
              key={script.id}
              script={script}
              onDuplicate={(s) => duplicateMutation.mutate(s)}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
