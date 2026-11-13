'use client';

import { useState, useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Upload,
  FileCode,
  Sparkles,
  Check,
  ChevronRight,
  ChevronLeft,
  Loader2,
  X,
  FileUp,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';

interface UploadScriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AnalysisResult {
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
    default?: string;
  }>;
  dependencies: string[];
  usage: string;
  summary: string;
}

const CATEGORIES = [
  'Uncategorized',
  'Automation',
  'Data',
  'Utility',
  'Security',
  'Network',
  'System',
  'Web',
  'Visualization',
  'Structural Biology',
  'Runner',
  'Test',
];

const LANGUAGES = ['python', 'bash', 'shell', 'javascript', 'node'];

export function UploadScriptDialog({ open, onOpenChange }: UploadScriptDialogProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step state
  const [step, setStep] = useState(1);

  // Form state
  const [fileContent, setFileContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  // Metadata
  const [scriptName, setScriptName] = useState('');
  const [scriptDescription, setScriptDescription] = useState('');
  const [scriptCategory, setScriptCategory] = useState('Uncategorized');
  const [scriptLanguage, setScriptLanguage] = useState('python');

  // AI Analysis
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  // AI Analysis mutation
  const analyzeMutation = useMutation({
    mutationFn: async (data: { content: string; filename: string }) => {
      const res = await fetch('/api/ai/analyze-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to analyze script');
      return res.json();
    },
    onSuccess: (data) => {
      setAnalysis(data.analysis);
      if (data.analysis?.description) {
        setScriptDescription(data.analysis.description);
      }
      if (data.analysis?.parameters) {
        // Parameters will be sent as JSON string on save
      }
      setStep(3);
    },
    onError: () => {
      toast.error('AI analysis failed. You can still save the script.');
      setStep(3);
    },
  });

  // Save script mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: scriptName,
          description: scriptDescription,
          filename: fileName,
          content: fileContent,
          category: scriptCategory,
          language: scriptLanguage,
          source: 'upload',
          params: analysis?.parameters ? JSON.stringify(analysis.parameters) : '[]',
        }),
      });
      if (!res.ok) throw new Error('Failed to save script');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Script saved successfully');
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
      handleClose();
    },
    onError: () => {
      toast.error('Failed to save script');
    },
  });

  const handleClose = useCallback(() => {
    setStep(1);
    setFileContent('');
    setFileName('');
    setScriptName('');
    setScriptDescription('');
    setScriptCategory('Uncategorized');
    setScriptLanguage('python');
    setAnalysis(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleFileSelect = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setFileContent(content);
      setFileName(file.name);
      // Auto-detect language from extension
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'py') setScriptLanguage('python');
      else if (ext === 'sh') setScriptLanguage('bash');
      else if (ext === 'js') setScriptLanguage('javascript');
      // Auto-set name from filename
      if (!scriptName) {
        setScriptName(file.name.replace(/\.\w+$/, '').replace(/[-_]/g, ' '));
      }
    };
    reader.readAsText(file);
  }, [scriptName]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleNext = useCallback(() => {
    if (step === 1 && fileContent) {
      setStep(2);
    } else if (step === 2) {
      // Trigger AI analysis
      analyzeMutation.mutate({ content: fileContent, filename: fileName });
    } else if (step === 3) {
      setStep(4);
    }
  }, [step, fileContent, fileName, analyzeMutation]);

  const handleBack = useCallback(() => {
    if (step > 1) setStep(step - 1);
  }, [step]);

  const canProceed = () => {
    if (step === 1) return !!fileContent;
    if (step === 2) return !!scriptName;
    if (step === 3) return true;
    return true;
  };

  const stepIndicator = (currentStep: number) => {
    const steps = [
      { num: 1, label: 'Upload' },
      { num: 2, label: 'Metadata' },
      { num: 3, label: 'AI Analysis' },
      { num: 4, label: 'Confirm' },
    ];
    return (
      <div className="flex items-center gap-1">
        {steps.map((s, i) => (
          <div key={s.num} className="flex items-center">
            <div
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                currentStep >= s.num
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {currentStep > s.num ? (
                <Check className="size-3" />
              ) : (
                <span>{s.num}</span>
              )}
              <span className="hidden sm:inline">{s.label}</span>
            </div>
            {i < steps.length - 1 && (
              <ChevronRight className="size-3 text-muted-foreground mx-0.5" />
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="size-4 text-green-500" />
            Upload Script
          </DialogTitle>
          <DialogDescription>Add a new script to your collection</DialogDescription>
        </DialogHeader>

        {stepIndicator(step)}

        {/* Step 1: Upload file or paste code */}
        {step === 1 && (
          <div className="space-y-3">
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
                isDragOver
                  ? 'border-green-500 bg-green-50 dark:bg-green-900/10'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
            >
              <FileUp className="size-8 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground">
                Drag and drop a file here, or click to browse
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Supports .py, .sh, .js files
              </p>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".py,.sh,.js,.bash,.ts"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">or paste code</span>
              <Separator className="flex-1" />
            </div>

            <Textarea
              placeholder="Paste your script code here..."
              value={fileContent}
              onChange={(e) => {
                setFileContent(e.target.value);
                if (!fileName) setFileName('script.py');
              }}
              className="font-mono text-xs min-h-[150px]"
            />

            {fileName && (
              <div className="flex items-center gap-2">
                <FileCode className="size-4 text-green-500" />
                <span className="text-sm font-medium">{fileName}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setFileContent('');
                    setFileName('');
                  }}
                >
                  <X className="size-3" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Enter metadata */}
        {step === 2 && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="script-name" className="text-xs">
                Script Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="script-name"
                value={scriptName}
                onChange={(e) => setScriptName(e.target.value)}
                placeholder="My awesome script"
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="script-desc" className="text-xs">
                Description
              </Label>
              <Textarea
                id="script-desc"
                value={scriptDescription}
                onChange={(e) => setScriptDescription(e.target.value)}
                placeholder="What does this script do?"
                className="text-xs min-h-[60px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Select value={scriptCategory} onValueChange={(v) => v && setScriptCategory(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Language</Label>
                <Select value={scriptLanguage} onValueChange={(v) => v && setScriptLanguage(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((lang) => (
                      <SelectItem key={lang} value={lang}>
                        {lang}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: AI Analysis */}
        {step === 3 && (
          <div className="space-y-3">
            {analyzeMutation.isPending ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 className="size-8 animate-spin text-green-500" />
                <p className="text-sm text-muted-foreground">Analyzing script with AI...</p>
              </div>
            ) : analysis ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="size-4 text-green-500" />
                  <span className="text-sm font-medium">AI Analysis Results</span>
                </div>

                {analysis.summary && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Summary</Label>
                    <p className="text-sm">{analysis.summary}</p>
                  </div>
                )}

                {analysis.description && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Description</Label>
                    <p className="text-sm">{analysis.description}</p>
                  </div>
                )}

                {analysis.parameters && analysis.parameters.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Parameters</Label>
                    <div className="space-y-1.5">
                      {analysis.parameters.map((param) => (
                        <div
                          key={param.name}
                          className="flex items-center gap-2 text-xs bg-muted/50 rounded-md px-2 py-1.5"
                        >
                          <span className="font-mono font-medium">{param.name}</span>
                          <Badge variant="outline" className="text-[9px]">
                            {param.type}
                          </Badge>
                          {param.required && (
                            <Badge variant="destructive" className="text-[9px]">
                              required
                            </Badge>
                          )}
                          <span className="text-muted-foreground flex-1">
                            {param.description}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.dependencies && analysis.dependencies.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Dependencies</Label>
                    <div className="flex flex-wrap gap-1">
                      {analysis.dependencies.map((dep) => (
                        <Badge key={dep} variant="secondary" className="text-[10px]">
                          {dep}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.usage && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Usage</Label>
                    <code className="block text-xs bg-muted/50 rounded-md p-2 font-mono">
                      {analysis.usage}
                    </code>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
                <p className="text-sm">AI analysis was not available.</p>
                <p className="text-xs">You can still proceed to save the script.</p>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Confirm and save */}
        {step === 4 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <Check className="size-4 text-green-500" />
              <span className="text-sm font-medium">Confirm & Save</span>
            </div>

            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Name</span>
                <span className="font-medium">{scriptName}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Filename</span>
                <span className="font-mono">{fileName}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Category</span>
                <span>{scriptCategory}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Language</span>
                <span>{scriptLanguage}</span>
              </div>
              {scriptDescription && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Description: </span>
                  <span>{scriptDescription}</span>
                </div>
              )}
              {analysis?.parameters && analysis.parameters.length > 0 && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Parameters: </span>
                  <span>{analysis.parameters.length} detected</span>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Script Preview</Label>
              <Textarea
                readOnly
                value={fileContent.slice(0, 500) + (fileContent.length > 500 ? '\n...' : '')}
                className="font-mono text-[10px] min-h-[80px] max-h-[120px] bg-muted/30"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {step > 1 && (
            <Button variant="outline" size="sm" onClick={handleBack}>
              <ChevronLeft className="size-4" />
              Back
            </Button>
          )}
          {step < 4 ? (
            <Button
              size="sm"
              onClick={handleNext}
              disabled={!canProceed() || analyzeMutation.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {step === 2 && !analyzeMutation.isPending ? (
                <>
                  <Sparkles className="size-4" />
                  Analyze with AI
                </>
              ) : analyzeMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  Next
                  <ChevronRight className="size-4" />
                </>
              )}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Check className="size-4" />
                  Save Script
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
