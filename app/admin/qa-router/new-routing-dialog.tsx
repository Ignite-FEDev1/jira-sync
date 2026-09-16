'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * 라우팅 대상 만들기.
 *
 * ── 왜 두 걸음인가 ──
 *
 * 마지막 칸(처음 받는 사람)은 **필터를 읽어야 고를 수 있다.** 사람이 외워서
 * 넣는 값이 아니라 그 필터의 담당자 명단 안에 있는 사람이고, 명단에 없는
 * 사람을 넣으면 봇이 찾을 티켓이 영영 0건이 된다 — 오류 없이 알림만 안 온다.
 *
 * 그래서 칸을 다 보여주고 마지막에 검사하지 않는다. 앞의 셋을 받아 필터를
 * 먼저 읽고, **고를 수 있는 것만** 보여준다.
 */
export function NewRoutingDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [name, setName] = useState('');
  const [filterUrl, setFilterUrl] = useState('');
  const [channel, setChannel] = useState('');

  const [members, setMembers] = useState<
    { accountId: string; name: string }[] | null
  >(null);
  const [filterName, setFilterName] = useState('');
  const [triage, setTriage] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setName('');
    setFilterUrl('');
    setChannel('');
    setMembers(null);
    setFilterName('');
    setTriage('');
    setBusy(false);
  }

  async function submit(withTriage: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/qa-router', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          jiraFilterId: filterUrl,
          slackChannelId: channel,
          ...(withTriage ? { triageAccountId: withTriage } : {}),
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        toast.error(body.error ?? '만들지 못했습니다');
        return;
      }

      // 아직 못 고른 단계 — 명단을 받아 두 번째 걸음으로 간다.
      if (body.needsTriage) {
        setMembers(body.members);
        setFilterName(body.filterName ?? '');
        return;
      }

      toast.success(`${body.name} 을(를) 만들었습니다`, {
        description: '꺼진 상태입니다. 남은 설정을 채우고 켜 주세요',
      });
      setOpen(false);
      reset();
      router.push(`/admin/qa-router/${body.id}/settings`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const step1Ready = name.trim() && filterUrl.trim() && channel.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          라우팅 추가하기
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {members ? '처음 받는 사람 고르기' : '라우팅 대상 만들기'}
          </DialogTitle>
          <DialogDescription>
            {members
              ? `${filterName || '이 필터'} 의 담당자입니다. QA 가 티켓을 만들 때 배정하는 사람을 고르세요.`
              : 'QA 티켓이 쌓이는 Jira 필터와 알릴 Slack 채널이 필요합니다.'}
          </DialogDescription>
        </DialogHeader>

        {members ? (
          <div className="space-y-1">
            {/*
              라디오가 아니라 목록 버튼이다. 고르는 즉시 만든다 — 고른 뒤
              한 번 더 누르게 하면, 명단이 한 명일 때도 두 번 눌러야 한다.
            */}
            {members.map((m) => (
              <button
                key={m.accountId}
                type="button"
                disabled={busy}
                onClick={() => {
                  setTriage(m.accountId);
                  void submit(m.accountId);
                }}
                className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-60"
              >
                <span className="font-medium">{m.name}</span>
                {busy && triage === m.accountId && (
                  <Loader2 className="size-4 animate-spin" />
                )}
              </button>
            ))}
            <p className="pt-1 text-[11.5px] leading-snug text-muted-foreground">
              틀리면 봇이 찾을 티켓이 0건이 됩니다. 나중에 설정에서 바꿀 수
              있습니다.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="이름" hint="목록에서 이 대상을 부르는 이름입니다">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: GW QA (개발)"
              />
            </Field>

            <Field
              label="Jira 필터 주소"
              hint="필터를 연 뒤 주소창을 그대로 붙여넣으세요. Ignite · HMG 둘 다 됩니다"
            >
              <Input
                value={filterUrl}
                onChange={(e) => setFilterUrl(e.target.value)}
                placeholder="https://hmg.atlassian.net/issues?filter=12571"
              />
            </Field>

            <Field label="판정 알림 채널" hint="C 로 시작하는 채널 ID 입니다">
              <Input
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder="C0BVDJEJ19C"
              />
            </Field>
          </div>
        )}

        <DialogFooter>
          {members ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setMembers(null)}
            >
              뒤로
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!step1Ready || busy}
              onClick={() => void submit('')}
            >
              {busy && <Loader2 className="animate-spin" />}
              {busy ? '필터를 읽는 중' : '다음'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
