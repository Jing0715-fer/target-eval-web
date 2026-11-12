'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Play,
  RotateCcw,
  Download,
  Copy,
  Check,
  Loader2,
  Clock,
  AlertCircle,
  Terminal,
  FileCode,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useScriptStore } from '@/store/script-store';
import { toast } from 'sonner';

interface ScriptParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: string;
}

interface ExecutionLog {
  id: string;
  scriptId: string;
  params: string;
  output: string;
  error: string;
  status: string;
  duration: number;
  createdAt: string;
}

interface ScriptDetail {
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
  executions: ExecutionLog[];
}

export function ScriptExecutionPanel() {
  const queryClient = useQueryClient();
  const { selectedScriptId, setSelectedScript } = useScriptStore();
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  // Fetch script details with execution history
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['script', selectedScriptId],
    queryFn: async () => {
      if (!selectedScriptId) return null;
      const res = await fetch(`/api/scripts/${selectedScriptId}`);
      if (!res.ok) throw new Error('Failed to fetch script');
      return res.json();
    },
    enabled: !!selectedScriptId,
    retry: 2,
    retryDelay: 1000,
  });

  const script: ScriptDetail | null = data?.script || null;

  // Parse params from JSON string
  const parsedParams: ScriptParam[] = (() => {
    try {
      const p = script?.params;
      if (!p || p === '[]') return [];
      return JSON.parse(p);
    } catch {
      return [];
    }
  })();

  // Execute script
  const executeMutation = useMutation({
    mutationFn: async () => {
      if (!selectedScriptId) throw new Error('No script selected');
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedScriptId,
          params: paramValues,
        }),
      });
      if (!res.ok) throw new Error('Failed to execute script');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Script executed successfully');
      queryClient.invalidateQueries({ queryKey: ['script', selectedScriptId] });
    },
    onError: () => {
      toast.error('Script execution failed');
    },
  });

  const handleParamChange = useCallback((name: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleReset = useCallback(() => {
    setParamValues({});
    executeMutation.reset();
  }, [executeMutation]);

  const handleCopy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleDownload = useCallback((content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-output.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const statusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
      case 'error':
        return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
      case 'timeout':
        return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  if (!selectedScriptId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground p-8">
        <Terminal className="size-12 text-muted-foreground/30" />
        <p className="text-sm">Select a script to execute</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !script) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground p-8">
        <AlertCircle className="size-12 text-muted-foreground/30" />
        <p className="text-sm">{isError ? 'Failed to load script' : 'Script not found'}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RotateCcw className="size-3" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        {/* Script Info */}
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-green-500" />
              <CardTitle className="text-sm">{script.name}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {script.description || 'No description'}
            </p>
            <div className="flex items-center gap-2">
              <FileCode className="size-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-mono">
                {script.filename}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Parameters */}
        {parsedParams.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-xs font-medium uppercase text-muted-foreground">
                Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {parsedParams.map((param) => (
                <div key={param.name} className="space-y-1">
                  <Label htmlFor={param.name} className="text-xs">
                    {param.name}
                    {param.required && <span className="text-destructive ml-0.5">*</span>}
                  </Label>
                  <Input
                    id={param.name}
                    placeholder={param.description || param.name}
                    value={paramValues[param.name] ?? param.default ?? ''}
                    onChange={(e) => handleParamChange(param.name, e.target.value)}
                    className="h-7 text-xs"
                  />
                  {param.description && (
                    <p className="text-[10px] text-muted-foreground">{param.description}</p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Execute Button */}
        <div className="flex gap-2">
          <Button
            className="flex-1 bg-green-600 hover:bg-green-700 text-white"
            size="sm"
            onClick={() => executeMutation.mutate()}
            disabled={executeMutation.isPending}
          >
            {executeMutation.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Executing...
              </>
            ) : (
              <>
                <Play className="size-4" />
                Execute
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={handleReset}>
            <RotateCcw className="size-4" />
            Reset
          </Button>
        </div>

        {/* Output */}
        {executeMutation.data && (
          <Card size="sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs font-medium uppercase text-muted-foreground">
                  Output
                </CardTitle>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() =>
                      handleCopy(
                        executeMutation.data.output || executeMutation.data.error || ''
                      )
                    }
                  >
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() =>
                      handleDownload(
                        executeMutation.data.output || executeMutation.data.error || '',
                        script.filename
                      )
                    }
                  >
                    <Download className="size-3" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {executeMutation.data.output && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1">STDOUT</p>
                  <Textarea
                    readOnly
                    value={executeMutation.data.output}
                    className="font-mono text-xs bg-muted/50 min-h-[80px] max-h-[200px]"
                  />
                </div>
              )}
              {executeMutation.data.error && (
                <div>
                  <p className="text-[10px] font-medium text-destructive mb-1">STDERR</p>
                  <Textarea
                    readOnly
                    value={executeMutation.data.error}
                    className="font-mono text-xs bg-destructive/5 text-destructive min-h-[60px] max-h-[150px]"
                  />
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant="secondary"
                  className={statusColor(executeMutation.data.status)}
                >
                  {executeMutation.data.status}
                </Badge>
                <span>Duration: {executeMutation.data.duration}ms</span>
                {executeMutation.data.exitCode !== undefined && (
                  <span>Exit code: {executeMutation.data.exitCode}</span>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Execution History */}
        {script.executions && script.executions.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <div className="flex items-center gap-1.5">
                <Clock className="size-3.5 text-muted-foreground" />
                <CardTitle className="text-xs font-medium uppercase text-muted-foreground">
                  Execution History
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {script.executions.map((exec: ExecutionLog, i: number) => (
                  <div key={exec.id}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          className={`text-[9px] ${statusColor(exec.status)}`}
                        >
                          {exec.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {exec.duration}ms
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(exec.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {exec.output && (
                      <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2 font-mono">
                        {exec.output}
                      </p>
                    )}
                    {i < script.executions.length - 1 && (
                      <Separator className="mt-2" />
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Close button */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => setSelectedScript(null)}
        >
          Close Panel
        </Button>
      </div>
    </ScrollArea>
  );
}
