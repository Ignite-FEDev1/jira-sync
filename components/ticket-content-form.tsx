'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Copy, Check, Loader2, Sparkles, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

const TICKET_TYPES = [
  { value: 'feature', label: '기능 개발' },
  { value: 'qa-fix', label: 'QA수정' },
  { value: 'ux', label: 'UX 개선' },
  { value: 'improvement', label: '기능 개선' },
  { value: 'refactor', label: '리팩토링' },
  { value: 'config', label: '설정 변경' },
  { value: 'etc', label: '기타' },
];

interface TicketContentFormProps {
  className?: string;
}

export function TicketContentForm({ className }: TicketContentFormProps) {
  // Pre-info options
  const [ticketType, setTicketType] = useState('');
  const [needsNotice, setNeedsNotice] = useState(false);

  // Input fields
  const [background, setBackground] = useState('');
  const [description, setDescription] = useState('');
  const [urls, setUrls] = useState<string[]>(['']);

  // Result
  const [result, setResult] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const addUrl = () => setUrls([...urls, '']);
  const removeUrl = (index: number) =>
    setUrls(urls.filter((_, i) => i !== index));
  const updateUrl = (index: number, value: string) => {
    const updated = [...urls];
    updated[index] = value;
    setUrls(updated);
  };

  const buildPrompt = () => {
    const parts: string[] = [];

    const preInfo: string[] = [];
    if (ticketType) {
      const label =
        TICKET_TYPES.find((t) => t.value === ticketType)?.label || ticketType;
      preInfo.push(`- 티켓 종류: ${label}`);
    }
    preInfo.push(`- 사용자 전달 내용 필요: ${needsNotice ? '예' : '아니오'}`);
    parts.push(`[사전 정보]\n${preInfo.join('\n')}`);

    if (background.trim()) {
      parts.push(`[업무 배경/히스토리]\n${background.trim()}`);
    }

    if (description.trim()) {
      parts.push(`[업무 설명]\n${description.trim()}`);
    }

    const validUrls = urls.filter((u) => u.trim());
    if (validUrls.length > 0) {
      parts.push(
        `[관련 URL]\n${validUrls.map((u) => `- ${u.trim()}`).join('\n')}`
      );
    }

    return parts.join('\n\n');
  };

  const canGenerate = background.trim() || description.trim();

  const handleGenerate = async () => {
    if (!canGenerate) {
      toast.error('업무 배경 또는 업무 설명을 입력해주세요.');
      return;
    }

    setIsLoading(true);
    setResult('');

    try {
      const response = await fetch('/api/generate/ticket-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: buildPrompt() }),
      });

      const data = await response.json();

      if (!data.success) {
        toast.error(data.error || '생성에 실패했습니다.');
        return;
      }

      setResult(data.data);
      toast.success('티켓 내용이 생성되었습니다.');
    } catch {
      toast.error('요청 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(result);
      setIsCopied(true);
      toast.success('클립보드에 복사되었습니다.');
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      toast.error('복사에 실패했습니다.');
    }
  };

  return (
    <div className={className}>
      {/* Pre-info options */}
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">티켓 종류</label>
          <Select
            value={ticketType}
            onValueChange={setTicketType}
            disabled={isLoading}
          >
            <SelectTrigger>
              <SelectValue placeholder="선택하세요" />
            </SelectTrigger>
            <SelectContent>
              {TICKET_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap gap-2">
          <ToggleChip
            checked={needsNotice}
            onChange={setNeedsNotice}
            disabled={isLoading}
          >
            사용자 전달 내용 필요
          </ToggleChip>
        </div>
      </div>

      <div className="my-5 border-t" />

      {/* Input fields */}
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">업무 배경 / 히스토리</label>
            <span className={`text-xs ${background.length > 30000 ? 'text-destructive' : 'text-muted-foreground'}`}>
              {background.length.toLocaleString()} / 30,000
            </span>
          </div>
          <Textarea
            placeholder="슬랙, 두레이 등에서 공유된 내용을 붙여넣으세요."
            value={background}
            onChange={(e) => {
              if (e.target.value.length <= 30000) setBackground(e.target.value);
            }}
            className="min-h-[100px] resize-none"
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">업무 설명</label>
            <span className={`text-xs ${description.length > 5000 ? 'text-destructive' : 'text-muted-foreground'}`}>
              {description.length.toLocaleString()} / 5,000
            </span>
          </div>
          <Textarea
            placeholder="어떤 작업을 해야 하는지 자유롭게 설명해주세요."
            value={description}
            onChange={(e) => {
              if (e.target.value.length <= 5000) setDescription(e.target.value);
            }}
            className="min-h-[100px] resize-none"
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">관련 URL</label>
            <Button
              variant="ghost"
              size="sm"
              onClick={addUrl}
              disabled={isLoading}
              className="h-7 text-xs"
            >
              <Plus className="mr-1 h-3 w-3" />
              추가
            </Button>
          </div>
          <div className="space-y-2">
            {urls.map((url, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  placeholder="기획서, 디자인, 관련 티켓 URL"
                  value={url}
                  onChange={(e) => updateUrl(index, e.target.value)}
                  disabled={isLoading}
                />
                {urls.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeUrl(index)}
                    disabled={isLoading}
                    className="h-9 w-9 flex-shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Generate button */}
      <Button
        onClick={handleGenerate}
        disabled={isLoading || !canGenerate}
        className="w-full mt-5"
      >
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            생성 중...
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-4 w-4" />
            AI로 설명 생성
          </>
        )}
      </Button>

      {/* Result */}
      {(result || isLoading) && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">생성 결과</label>
            {result && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={isCopied}
              >
                {isCopied ? (
                  <>
                    <Check className="mr-2 h-4 w-4" />
                    복사됨
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-4 w-4" />
                    복사
                  </>
                )}
              </Button>
            )}
          </div>
          {result ? (
            <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-4 text-sm font-mono">
              {result}
            </pre>
          ) : (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              생성 중입니다...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToggleChip({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm border transition-colors ${
        checked
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background text-muted-foreground border-input hover:bg-accent'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {children}
    </button>
  );
}
