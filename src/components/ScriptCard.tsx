'use client';

import { Terminal, Play, Copy, Trash2, GitBranch, Upload, FileCode } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useScriptStore } from '@/store/script-store';
import { toast } from 'sonner';

export interface ScriptData {
  id: string;
  name: string;
  description: string;
  filename: string;
  content: string;
  category: string;
  language: string;
  source: string;
  sourceUrl: string | null;
  params: string;
  createdAt: string;
  updatedAt: string;
  _count?: {
    executions: number;
  };
}

const categoryColors: Record<string, string> = {
  Uncategorized: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  Automation: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  Data: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  Utility: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  Security: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  Network: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  System: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  Web: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  Visualization: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  'Structural Biology': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  Runner: 'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400',
  Test: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
};

const languageColors: Record<string, string> = {
  python: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  bash: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  shell: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  sh: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  javascript: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  node: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  js: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
};

const sourceIcons: Record<string, React.ReactNode> = {
  github: <GitBranch className="size-3" />,
  manual: <FileCode className="size-3" />,
  upload: <Upload className="size-3" />,
};

interface ScriptCardProps {
  script: ScriptData;
  onDuplicate?: (script: ScriptData) => void;
  onDelete?: (id: string) => void;
}

export function ScriptCard({ script, onDuplicate, onDelete }: ScriptCardProps) {
  const { selectedScriptId, setSelectedScript } = useScriptStore();
  const isSelected = selectedScriptId === script.id;

  const handleExecute = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedScript(script.id);
  };

  const handleDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDuplicate?.(script);
    toast.success(`Duplicated "${script.name}"`);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.(script.id);
  };

  const getCategoryColor = (category: string) => {
    return categoryColors[category] || categoryColors.Uncategorized;
  };

  const getLanguageColor = (language: string) => {
    const key = language?.toLowerCase() || 'python';
    return languageColors[key] || languageColors.python;
  };

  return (
    <Card
      className={`cursor-pointer transition-all hover:shadow-md hover:ring-1 hover:ring-green-500/30 ${
        isSelected ? 'ring-2 ring-green-500 shadow-md' : ''
      }`}
      onClick={() => setSelectedScript(script.id)}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="size-4 shrink-0 text-green-500" />
            <CardTitle className="truncate text-sm">{script.name}</CardTitle>
          </div>
          <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
            {sourceIcons[script.source] || <FileCode className="size-3" />}
            {script.source}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">
          {script.description || 'No description available'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant="secondary"
            className={`text-[10px] ${getCategoryColor(script.category)}`}
          >
            {script.category}
          </Badge>
          <Badge
            variant="secondary"
            className={`text-[10px] ${getLanguageColor(script.language)}`}
          >
            {script.language}
          </Badge>
          {script._count && script._count.executions > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {script._count.executions} run{script._count.executions > 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 pt-1">
          <Button
            variant="ghost"
            size="xs"
            className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-900/20"
            onClick={handleExecute}
          >
            <Play className="size-3" />
            Run
          </Button>
          <Button variant="ghost" size="xs" onClick={handleDuplicate}>
            <Copy className="size-3" />
            Duplicate
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive hover:bg-destructive/10"
            onClick={handleDelete}
          >
            <Trash2 className="size-3" />
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
