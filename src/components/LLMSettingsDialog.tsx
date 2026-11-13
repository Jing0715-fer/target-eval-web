'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings,
  Plus,
  Trash2,
  Star,
  Loader2,
  Key,
  Globe,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';

interface LlmConfig {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LLMSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PROVIDERS = ['z-ai', 'openai-compatible', 'claude-code'];

export function LLMSettingsDialog({ open, onOpenChange }: LLMSettingsDialogProps) {
  const queryClient = useQueryClient();
  const [showAddForm, setShowAddForm] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('z-ai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [isDefault, setIsDefault] = useState(false);

  // Fetch configs
  const { data, isLoading } = useQuery({
    queryKey: ['llm-configs'],
    queryFn: async () => {
      const res = await fetch('/api/llm-config');
      if (!res.ok) throw new Error('Failed to fetch LLM configs');
      return res.json();
    },
  });

  const configs: LlmConfig[] = data?.configs || [];

  // Create config
  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, provider, apiKey, baseUrl, model, isDefault }),
      });
      if (!res.ok) throw new Error('Failed to create LLM config');
      return res.json();
    },
    onSuccess: () => {
      toast.success('LLM config created');
      queryClient.invalidateQueries({ queryKey: ['llm-configs'] });
      resetForm();
    },
    onError: () => {
      toast.error('Failed to create LLM config');
    },
  });

  // Delete config
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/llm-config/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete LLM config');
      return res.json();
    },
    onSuccess: () => {
      toast.success('LLM config deleted');
      queryClient.invalidateQueries({ queryKey: ['llm-configs'] });
    },
    onError: () => {
      toast.error('Failed to delete LLM config');
    },
  });

  // Set default config
  const setDefaultMutation = useMutation({
    mutationFn: async ({ id, isDefault: newDefault }: { id: string; isDefault: boolean }) => {
      const res = await fetch(`/api/llm-config/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: newDefault }),
      });
      if (!res.ok) throw new Error('Failed to update LLM config');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-configs'] });
    },
    onError: () => {
      toast.error('Failed to update default config');
    },
  });

  const resetForm = () => {
    setName('');
    setProvider('z-ai');
    setApiKey('');
    setBaseUrl('');
    setModel('');
    setIsDefault(false);
    setShowAddForm(false);
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  const providerBadgeColor = (prov: string) => {
    switch (prov) {
      case 'z-ai':
        return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
      case 'openai-compatible':
        return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
      case 'claude-code':
        return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
      default:
        return '';
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="size-4 text-green-500" />
            LLM Configuration
          </DialogTitle>
          <DialogDescription>
            Manage your AI model configurations for script analysis
          </DialogDescription>
        </DialogHeader>

        {/* Existing configs */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground uppercase">Configurations</Label>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setShowAddForm(!showAddForm)}
            >
              <Plus className="size-3" />
              Add
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : configs.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              No LLM configurations yet. Add one to enable AI analysis.
            </div>
          ) : (
            <ScrollArea className="max-h-[200px]">
              <div className="space-y-2">
                {configs.map((config) => (
                  <div
                    key={config.id}
                    className="flex items-center justify-between gap-2 rounded-lg border p-2.5"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Switch
                          checked={config.isDefault}
                          onCheckedChange={(checked) =>
                            setDefaultMutation.mutate({ id: config.id, isDefault: checked })
                          }
                        />
                        {config.isDefault && (
                          <Star className="size-3 text-amber-500 fill-amber-500" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">{config.name}</span>
                          <Badge
                            variant="secondary"
                            className={`text-[9px] ${providerBadgeColor(config.provider)}`}
                          >
                            {config.provider}
                          </Badge>
                        </div>
                        {config.model && (
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {config.model}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => deleteMutation.mutate(config.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Add new config form */}
        {showAddForm && (
          <>
            <Separator />
            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground uppercase">
                New Configuration
              </Label>

              <div className="space-y-1">
                <Label htmlFor="config-name" className="text-xs">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="config-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My LLM Config"
                  className="h-8"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Provider</Label>
                  <Select value={provider} onValueChange={(v) => v && setProvider(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((prov) => (
                        <SelectItem key={prov} value={prov}>
                          {prov}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Model</Label>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="gpt-4, claude-3..."
                    className="h-8"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="config-apikey" className="text-xs flex items-center gap-1">
                  <Key className="size-3" />
                  API Key
                </Label>
                <Input
                  id="config-apikey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="h-8"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="config-baseurl" className="text-xs flex items-center gap-1">
                  <Globe className="size-3" />
                  Base URL
                </Label>
                <Input
                  id="config-baseurl"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="h-8"
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch checked={isDefault} onCheckedChange={setIsDefault} />
                <Label className="text-xs">Set as default configuration</Label>
              </div>
            </div>
          </>
        )}

        <DialogFooter>
          {showAddForm ? (
            <>
              <Button variant="outline" size="sm" onClick={resetForm}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={!name || createMutation.isPending}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {createMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Plus className="size-4" />
                    Add Config
                  </>
                )}
              </Button>
            </>
          ) : (
            <DialogClose render={<Button variant="outline" size="sm" />}>
              Close
            </DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
