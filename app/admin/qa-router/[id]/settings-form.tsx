'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import { SettingRow, SettingRows } from './setting-row';
import type { ConfigField } from '@/app/api/qa-router/[id]/config/route';
import { jiraBaseUrl } from '@/lib/constants/jira';
import { parseFilterUrl } from '@/lib/services/qa-router/derive';
import type { QaRouterConfig } from '@/lib/services/qa-router/types';

/**
 * 이 봇이 갖는 설정의 편집 폼.
 *
 * Jira 필터에서 읽어오는 값(프로젝트·담당자 등)은 여기 없다. 그건 필터가
 * 진실이고, 여기서 고칠 수 있게 하면 두 값이 어긋난 뒤 어느 쪽이 맞는지
 * 아무도 모르게 된다.
 *
 * 저장은 API Route 를 거친다 — 필터를 바꾸면 파생 캐시를 함께 버려야 하는데
 * 그 테이블은 브라우저 권한으로 못 지운다.
 */

export interface SettingsFormProps {
  config: QaRouterConfig;
  onCancel: () => void;
  /** 저장 성공 후. 부모가 다시 읽어 화면을 갱신한다. */
  onSaved: () => void;
}

export function SettingsForm({ config, onCancel, onSaved }: SettingsFormProps) {
  const [name, setName] = useState(config.name);
  // 저장은 숫자 ID 지만 사람은 URL 로 다룬다. 편집을 열면 지금 값을 URL 로
  // 되살려 보여줘야, 붙여넣기와 직접 수정이 같은 형태로 다뤄진다.
  const [filterUrl, setFilterUrl] = useState(
    `${jiraBaseUrl(config.jiraInstance)}/issues?filter=${config.jiraFilterId}`
  );
  const [channel, setChannel] = useState(config.slackChannelId);
  const [startHour, setStartHour] = useState(
    String(config.quietHours.startHour)
  );
  const [endHour, setEndHour] = useState(String(config.quietHours.endHour));
  const [skipWeekend, setSkipWeekend] = useState(config.quietHours.skipWeekend);
  const [saving, setSaving] = useState(false);
  // 서버가 알려준 문제 칸. 메시지만 토스트로 띄우면 여섯 칸 중 어디를 고칠지
  // 사용자가 직접 찾아야 한다.
  const [errorField, setErrorField] = useState<ConfigField | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  // 붙여넣은 URL 에서 뽑은 ID 가 기존과 다르면 파생 캐시가 비워진다.
  const parsedFilter = parseFilterUrl(filterUrl);
  const filterChanged =
    !!parsedFilter && parsedFilter.filterId !== config.jiraFilterId;

  const save = async () => {
    setSaving(true);
    setErrorField(null);
    setErrorText(null);
    try {
      const res = await fetch(`/api/qa-router/${config.id}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 편집을 시작한 시점의 값. 그 사이 누가 저장했으면 서버가 409 를 준다.
          expectedUpdatedAt: config.updatedAt,
          name,
          jiraFilterId: filterUrl,
          slackChannelId: channel,
          quietHours: {
            startHour: Number(startHour),
            endHour: Number(endHour),
            skipWeekend,
          },
        }),
      });
      const body = await res.json();

      if (res.status === 409) {
        // 값이 어긋난 상태에서는 어느 칸을 고쳐도 소용이 없다.
        // 폼을 닫고 부모가 다시 읽게 해서, 최신 값 위에서 다시 편집하게 한다.
        toast.error(body.error, { duration: 8000 });
        onSaved();
        return;
      }
      if (!res.ok) {
        // 문제 칸을 표시하고 그 칸으로 포커스를 옮긴다.
        // 토스트는 사라지지만 칸 아래 문구는 고칠 때까지 남는다.
        setErrorField(body.field ?? null);
        setErrorText(body.error ?? '저장에 실패했습니다');
        toast.error(body.error ?? '저장에 실패했습니다');
        if (body.field) {
          const el = document.querySelector<HTMLElement>(
            `[data-field="${body.field}"] input, [data-field="${body.field}"] [role="combobox"]`
          );
          el?.focus();
        }
        return;
      }
      if (body.warning) {
        toast.warning(body.warning);
      } else if (body.filterChanged) {
        toast.success('저장했습니다', {
          description:
            '필터가 바뀌어 읽어온 값을 비웠습니다. 지금 실행을 누르면 새 필터로 다시 읽습니다.',
        });
      } else {
        toast.success('저장했습니다');
      }
      onSaved();
    } catch (e) {
      toast.error(`저장 실패: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (f: ConfigField) =>
    errorField === f ? (errorText ?? undefined) : undefined;

  return (
    <div className="text-sm">
      {/* 읽기 상태와 같은 묶음, 같은 순서다 (page.tsx SettingsView 참고). */}
      <SettingRows>
        <Field
          label="이름"
          field="name"
          error={fieldError('name')}
          hint="어드민 목록과 Slack 알림 첫 줄에 이 이름이 나옵니다."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="max-w-[280px]"
            />
          )}
        </Field>

        <Field
          label="대상 필터"
          field="jiraFilterId"
          error={fieldError('jiraFilterId')}
          danger={filterChanged}
          hint={
            filterChanged
              ? `필터 ${parsedFilter?.filterId} 로 바꿉니다. 지금 읽어둔 프로젝트·담당자를 비우고 새 필터에서 다시 읽습니다.`
              : 'Jira 에서 필터를 열고 주소창을 그대로 붙여넣으세요. Ignite Jira 만 지원합니다.'
          }
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={filterUrl}
              onChange={(e) => setFilterUrl(e.target.value)}
              placeholder="https://ignitecorp.atlassian.net/issues?filter=12571"
              className="text-xs"
            />
          )}
        </Field>

        <Field
          label="알림 채널"
          field="slackChannelId"
          error={fieldError('slackChannelId')}
          hint="Slack 채널 이름을 우클릭하고 링크를 복사하면 끝의 C… 부분이 채널 ID 입니다."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="C0BVDJEJ19C"
              className="max-w-[220px] font-mono"
            />
          )}
        </Field>

        <Field
          label="동작 시간"
          field="quietHours"
          error={fieldError('quietHours')}
          hint="이 시간대에만 1분마다 확인합니다. 시간 밖에서는 티켓이 생겨도 알리지 않습니다."
        >
          {({ id, describedBy, invalid }) => (
            <div className="flex items-center gap-2">
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={startHour}
                onChange={(e) => setStartHour(e.target.value)}
                inputMode="numeric"
                className="w-14 text-center tabular-nums"
                aria-label="시작 시간"
              />
              <span className="whitespace-nowrap text-muted-foreground">
                시 ~
              </span>
              <Input
                value={endHour}
                onChange={(e) => setEndHour(e.target.value)}
                inputMode="numeric"
                className="w-14 text-center tabular-nums"
                aria-label="종료 시간"
              />
              <span className="text-muted-foreground">시</span>
              <label className="ml-1 flex items-center gap-1.5 whitespace-nowrap">
                <Switch
                  checked={skipWeekend}
                  onCheckedChange={setSkipWeekend}
                />
                <span className="text-muted-foreground">주말 제외</span>
              </label>
            </div>
          )}
        </Field>
      </SettingRows>

      {/*
        읽기 화면과 같은 문구를 같은 자리에 둔다. 편집할 수 없는 사실이다.
        선을 붙이지 않는다 — 바로 아래 버튼 줄에도 선이 있어 두 줄이 겹쳐 보였다.
      */}
      <p className="mt-4 text-xs text-muted-foreground">
        알림만 보냅니다. Jira 담당자는 바꾸지 않습니다.
      </p>

      <div className="mt-2 flex justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          취소
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? '저장 중' : '저장'}
        </Button>
      </div>
    </div>
  );
}

/**
 * 편집 줄. 읽기 상태와 같은 SettingRow 를 쓴다 — 라벨 폭과 값 시작점이
 * 같아야 편집을 눌렀을 때 방금 보던 값을 같은 자리에서 찾을 수 있다.
 *
 * 라벨은 반드시 입력과 연결한다. 눈으로는 옆에 붙어 있어도 htmlFor 가 없으면
 * 스크린리더는 그냥 "편집 텍스트"라고만 읽는다. 설명(hint)도 aria-describedby
 * 로 이어 붙여 같이 읽히게 한다.
 */
function Field({
  label,
  hint,
  danger,
  error,
  field,
  children,
}: {
  label: string;
  hint?: string;
  danger?: boolean;
  /** 서버가 이 칸을 문제로 지목했을 때의 메시지 */
  error?: string;
  /** 저장 실패 시 포커스를 찾기 위한 표식 */
  field?: string;
  children: (props: {
    id: string;
    describedBy?: string;
    invalid?: boolean;
  }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div data-field={field}>
      <SettingRow label={label} htmlFor={id} align="top">
        {/*
          폭은 입력마다 스스로 정한다. 여기서 320px 로 한꺼번에 묶으면 채널 ID
          11자짜리 칸과 60자 넘는 필터 URL 칸이 같은 폭이 되고, 긴 쪽은 붙여넣은
          값의 뒷부분이 보이지 않는다.
        */}
        <div>
          {children({
            id,
            // 에러가 있으면 그것부터 읽히게 순서를 둔다.
            describedBy:
              [errorId, hintId].filter(Boolean).join(' ') || undefined,
            invalid: !!error,
          })}
          {/*
            설명은 입력 아래에 둔다. 라벨 밑에 두면 좌측 열 높이가 늘어나
            읽기 상태와 행 위치가 어긋난다.
          */}
          {error ? (
            <p
              id={errorId}
              role="alert"
              className="mt-1 text-xs text-destructive"
            >
              {error}
            </p>
          ) : (
            hint && (
              <p
                id={hintId}
                className={`mt-1 text-xs ${danger ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
              >
                {hint}
              </p>
            )
          )}
        </div>
      </SettingRow>
    </div>
  );
}
