'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Copy, Check, Plus, FileText } from 'lucide-react';
import { toast } from 'sonner';

import type { DeployFormData, ProjectType, DeployType } from './types';
import {
  PROJECT_OPTIONS,
  DEPLOY_TYPE_OPTIONS,
  DEPLOY_TYPE_DISPLAY,
  MR_FIELDS_BY_PROJECT,
  INITIAL_FORM_DATA,
} from './constants';

export default function TemplatesPage() {
  // 폼 데이터 상태
  const [formData, setFormData] = useState<DeployFormData>(INITIAL_FORM_DATA);

  // Select 리셋을 위한 키 (초기화 시 Select 컴포넌트 리마운트용)
  const [resetKey, setResetKey] = useState(0);

  // 결과물 상태
  const [generatedTemplate, setGeneratedTemplate] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // CPO 추가 메시지 복사 상태
  const [copiedMessages, setCopiedMessages] = useState<Record<string, boolean>>(
    {}
  );

  // 프로젝트 선택 핸들러
  const handleProjectChange = useCallback((value: string) => {
    setFormData({
      ...INITIAL_FORM_DATA,
      project: value as ProjectType,
    });
    setGeneratedTemplate('');
  }, []);

  // 배포 종류 선택 핸들러
  const handleDeployTypeChange = useCallback((value: string) => {
    setFormData((prev) => ({
      ...prev,
      deployType: value as DeployType,
      deployDocLink: '',
      mrLinks: {},
    }));
    setGeneratedTemplate('');
  }, []);

  // 배포대장 링크 변경 핸들러
  const handleDeployDocLinkChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({
        ...prev,
        deployDocLink: e.target.value,
      }));
    },
    []
  );

  // MR 링크 변경 핸들러
  const handleMRLinkChange = useCallback((fieldId: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      mrLinks: {
        ...prev.mrLinks,
        [fieldId]: value,
      },
    }));
  }, []);

  // 템플릿 생성 핸들러
  const handleGenerate = useCallback(() => {
    // TODO: 실제 템플릿 생성 로직은 추후 추가 예정
    const template = generateTemplate(formData);
    setGeneratedTemplate(template);
    toast.success('템플릿이 생성되었습니다!');
  }, [formData]);

  // 복사 핸들러
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generatedTemplate);
      setCopied(true);
      toast.success('템플릿이 복사되었습니다!', {
        description: 'Slack에 붙여넣으면 URL이 자동으로 링크로 변환됩니다.',
        duration: 3000,
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('복사에 실패했습니다.');
    }
  }, [generatedTemplate]);

  // CPO 추가 메시지 복사 핸들러
  const handleCopyMessage = useCallback(
    async (messageId: string, content: string) => {
      try {
        await navigator.clipboard.writeText(content);
        setCopiedMessages((prev) => ({ ...prev, [messageId]: true }));
        toast.success('메시지가 복사되었습니다!');
        setTimeout(() => {
          setCopiedMessages((prev) => ({ ...prev, [messageId]: false }));
        }, 2000);
      } catch {
        toast.error('복사에 실패했습니다.');
      }
    },
    []
  );

  // 초기화 핸들러
  const handleReset = useCallback(() => {
    setFormData(INITIAL_FORM_DATA);
    setGeneratedTemplate('');
    setCopiedMessages({});
    setResetKey((prev) => prev + 1); // Select 컴포넌트 리마운트
  }, []);

  // 현재 프로젝트의 MR 필드 설정 가져오기
  const currentMRFields = formData.project
    ? MR_FIELDS_BY_PROJECT[formData.project]
    : [];

  // 완료 버튼 활성화 조건
  const isFormValid =
    formData.project &&
    formData.deployType &&
    formData.deployDocLink.trim() !== '' &&
    currentMRFields.every((field) => formData.mrLinks[field.id]?.trim() !== '');

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">배포 템플릿</h1>
            <p className="text-sm text-muted-foreground">
              배포 프로세스 체크리스트를 Slack에서 사용할 수 있습니다
            </p>
          </div>
          <Link href="/create-ticket">
            <Button size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              티켓 생성
            </Button>
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              배포 템플릿 생성
            </CardTitle>
            <CardDescription>
              프로젝트와 배포 정보를 입력하면 체크리스트 템플릿이 자동으로
              생성됩니다
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            {/* Step 1: 프로젝트 선택 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                배포 대상 프로젝트를 선택하세요
              </label>
              <Select
                key={`project-${resetKey}`}
                value={formData.project ?? undefined}
                onValueChange={handleProjectChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="프로젝트 선택" />
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Step 2: 배포 종류 선택 (프로젝트 선택 후 노출) */}
            {formData.project && (
              <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                <label className="text-sm font-medium">
                  배포 종류를 선택해주세요
                </label>
                <Select
                  key={`deploy-type-${formData.project}-${resetKey}`}
                  value={formData.deployType ?? undefined}
                  onValueChange={handleDeployTypeChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="배포 종류 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPLOY_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Step 3: 배포대장 링크 입력 (배포 종류 선택 후 노출) */}
            {formData.deployType && (
              <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                <label className="text-sm font-medium">
                  배포대장 링크를 입력해주세요
                </label>
                <Input
                  type="url"
                  placeholder="https://hmg.atlassian.net/wiki/..."
                  value={formData.deployDocLink}
                  onChange={handleDeployDocLinkChange}
                />
              </div>
            )}

            {/* Step 4: MR 링크 입력 (배포 종류 선택 후 노출) */}
            {formData.deployType && (
              <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                <label className="text-sm font-medium">
                  MR 링크를 입력해주세요
                </label>
                <div className="space-y-3">
                  {currentMRFields.map((field) => (
                    <div key={field.id} className="space-y-1">
                      <label className="text-xs text-muted-foreground">
                        {field.label}
                      </label>
                      <Input
                        type="url"
                        placeholder={field.placeholder}
                        value={formData.mrLinks[field.id] ?? ''}
                        onChange={(e) =>
                          handleMRLinkChange(field.id, e.target.value)
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Step 5: 완료 버튼 (배포 종류 선택 후 노출) */}
            {formData.deployType && (
              <div className="flex gap-2 pt-4 animate-in fade-in slide-in-from-top-2 duration-300">
                <Button
                  onClick={handleGenerate}
                  disabled={!isFormValid}
                  className="flex-1"
                >
                  완료
                </Button>
                <Button variant="outline" onClick={handleReset}>
                  초기화
                </Button>
              </div>
            )}

            {/* Step 6: 결과물 표시 */}
            {generatedTemplate && (
              <div className="space-y-4 pt-4 border-t animate-in fade-in slide-in-from-top-2 duration-300">
                {/* 메인 템플릿 */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">생성된 템플릿</label>
                    <Button
                      onClick={handleCopy}
                      variant={copied ? 'outline' : 'default'}
                      size="sm"
                    >
                      {copied ? (
                        <>
                          <Check className="mr-2 h-4 w-4" />
                          복사됨!
                        </>
                      ) : (
                        <>
                          <Copy className="mr-2 h-4 w-4" />
                          복사
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="p-4 bg-muted/50 rounded-lg border max-h-96 overflow-y-auto">
                    <TemplatePreview content={generatedTemplate} />
                  </div>
                </div>

                {/* 추가 알림 메시지 */}
                {formData.deployType && (
                  <div className="space-y-3 pt-4 border-t">
                    <label className="text-sm font-medium text-muted-foreground">
                      배포 진행 중 사용할 알림 메시지
                    </label>
                    {getNotificationMessages(formData.deployType).map(
                      (message) => (
                        <div
                          key={message.id}
                          className="p-3 bg-muted/30 rounded-lg border"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs flex-1">{message.content}</p>
                            <Button
                              onClick={() =>
                                handleCopyMessage(message.id, message.content)
                              }
                              variant={
                                copiedMessages[message.id] ? 'outline' : 'ghost'
                              }
                              size="sm"
                              className="shrink-0"
                            >
                              {copiedMessages[message.id] ? (
                                <>
                                  <Check className="mr-1 h-3 w-3" />
                                  복사됨
                                </>
                              ) : (
                                <>
                                  <Copy className="mr-1 h-3 w-3" />
                                  복사
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

// 알림 메시지 생성 함수
function getNotificationMessages(deployType: DeployType) {
  const deployDisplay = DEPLOY_TYPE_DISPLAY[deployType];

  return [
    {
      id: 'merge-request',
      content: `각 담당자분들께서는 배포대장, 배포 전 할 일, 각 작업분 ${deployDisplay.branch} 머지 여부 확인 부탁드립니다. (완료시 따봉)`,
    },
    {
      id: 'main-merge',
      content:
        'main 머지가 완료되었습니다. 각 담당자분들께서는 main 로컬 구동 테스트 부탁드립니다. (완료시 따봉)',
    },
    {
      id: 'deploy-complete',
      content:
        '운영계 배포 완료되었습니다. 각 담당자분들께서는 운영계 모니터링 부탁드립니다. (완료시 따봉)',
    },
  ];
}

// 템플릿 생성 함수
function generateTemplate(formData: DeployFormData): string {
  if (!formData.project || !formData.deployType) return '';

  const deployDisplay = DEPLOY_TYPE_DISPLAY[formData.deployType];

  // 프로젝트별 템플릿 생성
  switch (formData.project) {
    case 'cpo':
      return generateCPOTemplate(formData, deployDisplay);
    case 'groupware':
      return generateGroupwareTemplate(formData, deployDisplay);
    case 'hmg-board':
      return generateHMGBoardTemplate(formData, deployDisplay);
    default:
      return '';
  }
}

// CPO 템플릿 생성
function generateCPOTemplate(
  formData: DeployFormData,
  deployDisplay: { title: string; branch: string }
): string {
  const { deployDocLink, mrLinks } = formData;

  return `🚀 CPO BO ${deployDisplay.title}
1. 배포대장 및 배포 전 할 일 확인 (${deployDocLink})
2. feature -> ${deployDisplay.branch} 머지 확인
   • BO: ${mrLinks.bo ?? ''}
   • 프라이싱: ${mrLinks.pricing ?? ''}
   • 평가사: ${mrLinks.evaluator ?? ''}
3. ${deployDisplay.branch} -> main 머지
4. main 로컬 구동 모니터링
5. 배포 태그 발행
6. 배포 후 운영계 모니터링
7. 배포 후 할 일 확인
8. main -> stage, dev 현행화
9. 배포 완료`;
}

// 그룹웨어 템플릿 생성
function generateGroupwareTemplate(
  formData: DeployFormData,
  deployDisplay: { title: string; branch: string }
): string {
  const { deployDocLink, mrLinks } = formData;

  return `🚀 그룹웨어 ${deployDisplay.title}
1. 배포대장 및 배포 전 할 일 확인 (${deployDocLink})
2. feature -> ${deployDisplay.branch} 머지 확인
   • ${mrLinks.main ?? ''}
3. ${deployDisplay.branch} -> main 머지
4. main 로컬 구동 모니터링
5. 배포 태그 발행
6. 배포 후 운영계 모니터링
7. 배포 후 할 일 확인
8. main -> stage, dev 현행화
9. 배포 완료`;
}

// HMG Board 템플릿 생성
function generateHMGBoardTemplate(
  formData: DeployFormData,
  deployDisplay: { title: string; branch: string }
): string {
  const { deployDocLink, mrLinks } = formData;

  return `🚀 HMG Board ${deployDisplay.title}
1. 배포대장 및 배포 전 할 일 확인 (${deployDocLink})
2. feature -> ${deployDisplay.branch} 머지 확인
   • ${mrLinks.main ?? ''}
3. ${deployDisplay.branch} -> main 머지
4. main 로컬 구동 모니터링
5. 배포 태그 발행
6. 배포 후 운영계 모니터링
7. 배포 후 할 일 확인
8. main -> stage, dev 현행화
9. 배포 완료`;
}

// 템플릿 미리보기 컴포넌트
function TemplatePreview({ content }: { content: string }) {
  return (
    <div className="text-xs whitespace-pre-wrap space-y-1">
      {content.split('\n').map((line, idx) => {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const parts = line.split(urlRegex);

        return (
          <div key={idx} className="leading-relaxed">
            {parts.map((part, partIdx) => {
              if (part.match(urlRegex)) {
                return (
                  <a
                    key={partIdx}
                    href={part}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline font-medium"
                  >
                    {part.length > 60 ? `${part.substring(0, 60)}...` : part}
                  </a>
                );
              }
              return <span key={partIdx}>{part}</span>;
            })}
          </div>
        );
      })}
    </div>
  );
}
