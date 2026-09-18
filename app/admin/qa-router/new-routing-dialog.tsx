'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusLed } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import type { TriageGuessView } from './[id]/pipeline';
import type {
  ChannelCheck,
  DeployRootCheck,
  FilterPreview,
} from '@/lib/services/qa-router/checks';

/** `/api/qa-router/preview` 응답. 안 넣은 칸은 아예 없다. */
interface PreviewResult {
  filter?: { ok: true; value: FilterPreview } | { ok: false; error: string };
  deployRoot?:
    | { ok: true; value: DeployRootCheck }
    | { ok: false; error: string };
  channel?: { ok: true; value: ChannelCheck } | { ok: false; error: string };
}

/**
 * 라우팅 대상 만들기.
 *
 * ── 왜 두 걸음인가 ──
 *
 * 마지막 칸(처음 받는 사람)은 **필터를 읽어야 고를 수 있다.** 사람이 외워서
 * 넣는 값이 아니라 그 필터의 담당자 명단 안에 있는 사람이고, 명단에 없는
 * 사람을 넣으면 봇이 찾을 티켓이 영영 0건이 된다 — 오류 없이 알림만 안 온다.
 *
 * 그래서 칸을 다 보여주고 마지막에 검사하지 않는다. 필터를 먼저 읽고
 * **고를 수 있는 것만** 보여준다.
 *
 * ── 필수는 이름 하나다 ──
 *
 * 나머지는 비운 채로 만들고 설정 화면에서 채울 수 있다. 필터 주소를 아직
 * 못 받았거나 채널이 안 정해진 상태에서도 자리를 잡아 둘 수 있어야 한다.
 * 덜 찬 대상은 **켜지지 않는다** — DB 제약이 막는다.
 */
export function NewRoutingDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [name, setName] = useState('');
  const [filterUrl, setFilterUrl] = useState('');
  const [deployRoot, setDeployRoot] = useState('');
  const [channel, setChannel] = useState('');

  const [members, setMembers] = useState<
    { accountId: string; name: string }[] | null
  >(null);
  const [filterName, setFilterName] = useState('');
  /** 대시보드 주소로 들어와 찾아낸 필터 번호. 직접 필터를 넣었으면 null. */
  const [viaGadget, setViaGadget] = useState<string | null>(null);
  /** 변경이력이 말하는 창구. 근거를 못 찾으면 null 이다. */
  const [guess, setGuess] = useState<TriageGuessView | null>(null);
  const [triage, setTriage] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * 서버가 짚어 준 문제. **칸 옆에 붙인다.**
   *
   * 전에는 토스트로만 띄웠다. 고칠 칸은 모달 안에 있는데 무엇이 틀렸는지는
   * 바깥에서 말하는 셈이라, 그 토스트를 치우려고 Esc 를 누르면 모달이 닫히고
   * 입력이 통째로 날아갔다 (재현 확인).
   */
  const [errField, setErrField] = useState<string | null>(null);
  const [errText, setErrText] = useState<string | null>(null);

  /**
   * 붙여넣은 값이 각각 무엇인지. 설정 화면이 칸마다 하는 확인을 여기서도 한다.
   *
   * 없으면 [만들기] 를 누르기 전까지 **그게 유의미한 경로인지 알 수 없다.**
   * 틀린 채로 만들면 설정 화면에 가서야 알게 되고, 그때는 왜 그 주소를
   * 골랐는지 이미 잊는다.
   */
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [checking, setChecking] = useState(false);

  /*
    타이핑이 멈춘 뒤에 묻는다. 글자마다 부르면 Jira 를 수십 번 두드리고,
    그 답들이 뒤섞여 도착해 마지막 것이 먼저 온 답에 덮인다.
  */
  useEffect(() => {
    const filled = filterUrl.trim() || deployRoot.trim() || channel.trim();
    if (!open || members || !filled) {
      setPreview(null);
      return;
    }
    let alive = true;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/qa-router/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jiraFilterId: filterUrl,
            confluenceDeployRootId: deployRoot,
            slackChannelId: channel,
          }),
        });
        // 늦게 온 답이 새 입력의 답을 덮지 않게 한다.
        if (alive) setPreview(await res.json());
      } catch {
        if (alive) setPreview(null);
      } finally {
        if (alive) setChecking(false);
      }
    }, 700);
    return () => {
      alive = false;
      clearTimeout(t);
      setChecking(false);
    };
  }, [open, members, filterUrl, deployRoot, channel]);

  function reset() {
    setName('');
    setFilterUrl('');
    setDeployRoot('');
    setChannel('');
    setMembers(null);
    setFilterName('');
    setViaGadget(null);
    setGuess(null);
    setTriage('');
    setBusy(false);
    setErrField(null);
    setErrText(null);
    setPreview(null);
  }

  /** 만들고 나서 설정 화면으로. 남은 칸은 거기서 채운다. */
  function goToSettings(body: {
    id: string;
    name: string;
    missing?: string[];
  }) {
    const missing = body.missing ?? [];
    toast.success(`${body.name} 을(를) 만들었습니다`, {
      description: missing.length
        ? `${missing.join(', ')} 을(를) 채워야 켤 수 있습니다`
        : '꺼진 상태입니다. 확인하고 켜 주세요',
    });
    setOpen(false);
    reset();
    router.push(`/admin/qa-router/${body.id}/settings`);
  }

  /**
   * @param withTriage  고른 사람. 빈 문자열이면 "명단을 달라" 는 뜻이다.
   * @param skipFilter  필터를 비운 채로 만든다 (건너뛰기).
   */
  async function submit(withTriage: string, skipFilter = false) {
    setBusy(true);
    setErrField(null);
    setErrText(null);
    try {
      const res = await fetch('/api/qa-router', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          jiraFilterId: skipFilter ? '' : filterUrl,
          slackChannelId: channel,
          confluenceDeployRootId: deployRoot,
          ...(withTriage ? { triageAccountId: withTriage } : {}),
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        /*
          칸을 짚어 주면 그 칸 아래 적고, 못 짚으면 폼 머리에 적는다.
          어느 쪽이든 **모달 안**이라 고치는 동안 입력이 살아 있다.
        */
        setErrField(body.field ?? null);
        setErrText(body.error ?? '만들지 못했습니다');
        return;
      }

      // 아직 못 고른 단계 — 명단을 받아 두 번째 걸음으로 간다.
      if (body.needsTriage) {
        setMembers(body.members);
        setFilterName(body.filterName ?? '');
        setViaGadget(body.resolvedFilterId ?? null);
        setGuess(body.triageGuess ?? null);
        /*
          추천이 있으면 미리 골라 둔다. 대부분 그대로 쓰는 값이라 한 번 더
          누르게 할 이유가 없다. 추천은 이력에서 나온 것이라, 창구가 바뀌면
          다음에 만들 때 저절로 따라간다.
        */
        setTriage(body.triageGuess?.accountId ?? '');
        return;
      }

      goToSettings(body);
    } catch (e) {
      setErrField(null);
      setErrText((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 미리보기가 이미 읽어 둔 것으로 두 번째 걸음(처음 받는 사람)으로 간다.
   *
   * 전에는 여기서 서버를 한 번 더 불렀다. 그런데 그 호출이 새로 가져오는
   * 것은 창구 추천 하나뿐이고, 그걸 위해 필터·JQL·사용자 명단을 통째로
   * 다시 읽었다 — 실측으로 미리보기 2.8초 뒤 `다음` 이 4.5초를 더 썼다.
   * 추천을 미리보기에 얹은 지금은 **네트워크 없이** 넘어간다.
   *
   * `다음` 은 확인이 끝나고 성공했을 때만 눌리므로, 여기 도달했다는 것은
   * 지금 주소에 대한 답이 손에 있다는 뜻이다.
   */
  function goToTriageStep() {
    const f = preview?.filter;
    if (!f?.ok) return;
    setMembers(f.value.members);
    setFilterName(f.value.filterName);
    setViaGadget(f.value.resolvedFilterId);
    setGuess(f.value.triageGuess);
    setTriage(f.value.triageGuess?.accountId ?? '');
    setErrField(null);
    setErrText(null);
  }

  /** 이름만 있으면 만들 수 있다. 나머지는 설정에서 채운다. */
  const canCreate = !!name.trim();
  /** 필터가 있으면 처음 받는 사람까지 골라 두는 게 낫다. */
  const hasFilter = !!filterUrl.trim();
  /*
    아직 안 채운 것. 켜기를 막는 셋만 센다 (DB 제약과 같은 기준이다) —
    배포대장은 없어도 켜지므로 여기 안 넣는다. 못 켜는 이유만 말해야
    "채우라는 건가 말라는 건가" 가 안 생긴다.
  */
  const missingNow = [
    hasFilter ? null : '필터',
    hasFilter ? null : '처음 받는 사람',
    channel.trim() ? null : '알림 채널',
  ].filter((x): x is string => !!x);
  /*
    필터를 못 읽었다. `다음` 은 이 값을 다시 읽는 일이라 눌러도 같은 실패가
    한 번 더 날 뿐이다. 그때 나갈 길은 `나중에 채우기` 쪽이다.
  */
  const filterFailed = preview?.filter?.ok === false;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        /*
          닫아도 **비우지 않는다.**

          Esc 나 바깥 클릭은 "그만두겠다" 가 아니라 대개 손이 미끄러진
          것이다. 여기서 비우면 주소를 다시 찾아와야 한다 — 실제로 안내
          토스트를 치우려던 Esc 한 번에 네 칸이 전부 날아갔다.
          비우는 것은 [취소] 와 만들기 성공, 둘뿐이다.
        */
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
              : '이름만 넣어도 만들어집니다. 나머지는 설정에서 채울 수 있습니다.'}
          </DialogDescription>
        </DialogHeader>

        {/* 칸을 못 짚은 오류는 폼 머리에. 어디든 모달 안이다. */}
        {errText && !errField && (
          <p className="rounded-md border border-red-200 bg-red-50/60 px-2.5 py-2 text-[11.5px] leading-snug text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errText}
          </p>
        )}

        {members ? (
          <div className="space-y-1">
            {/*
              대시보드 주소를 넣었으면 무엇으로 해석했는지 먼저 말한다.
              사람이 넣은 것과 봇이 볼 것이 다른 유일한 순간이라, 여기서
              안 보여주면 나중에 설정 화면의 필터 번호를 보고 놀란다.
            */}
            {viaGadget && (
              <p className="mb-2 rounded-md bg-muted px-3 py-2 text-[11.5px] leading-snug text-muted-foreground">
                대시보드 차트가 보는 필터 <strong>{viaGadget}</strong> 번을
                찾았습니다. 이 필터로 만듭니다.
              </p>
            )}
            {/*
              고르는 즉시 만들지 않는다. 추천이 이미 골라져 있어서, 그대로
              쓸 사람은 아래 `만들기` 만 누르면 된다. 즉시 만들기로 두면
              추천을 확인만 하려던 사람이 실수로 만들게 된다.
            */}
            {members.map((m) => {
              const picked = triage === m.accountId;
              const recommended = guess?.accountId === m.accountId;
              return (
                <button
                  key={m.accountId}
                  type="button"
                  disabled={busy}
                  onClick={() => setTriage(m.accountId)}
                  aria-pressed={picked}
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm disabled:opacity-60 ${
                    picked ? 'border-primary bg-primary/10' : 'hover:bg-muted'
                  }`}
                >
                  <span className="font-medium">{m.name}</span>
                  {recommended && (
                    <span className="text-[11px] text-muted-foreground">
                      이력
                    </span>
                  )}
                </button>
              );
            })}
            {/*
              추천의 **근거**를 같이 적는다. "이력" 배지만 있으면 왜 이 사람인지
              모르는 채로 누르게 된다.
            */}
            <p className="pt-1 text-[11.5px] leading-snug text-muted-foreground">
              {guess?.why ??
                '변경이력에서 근거를 찾지 못했습니다. 직접 골라 주세요.'}
            </p>
            {errField === 'triageAccountId' && errText && (
              <p className="text-[11.5px] leading-snug text-red-600 dark:text-red-400">
                {errText}
              </p>
            )}
          </div>
        ) : (
          /* 칸이 넷이고 확인 결과가 붙으면 작은 화면에서 넘친다. 여기만 스크롤한다. */
          <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            <Field
              label="이름"
              hints={['목록에서 이 대상을 부르는 이름']}
              error={errField === 'name' ? errText : null}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: GW QA (개발)"
              />
            </Field>

            <Field
              label="Jira 필터 또는 대시보드 차트 주소"
              hints={[
                '공유받은 대시보드 주소를 그대로',
                '차트를 펼친 주소(?maximized=…)여야 그 차트의 필터를 찾습니다',
                'Ignite, HMG 둘 다',
              ]}
              optional
              error={errField === 'jiraFilterId' ? errText : null}
              result={
                <Checked
                  busy={checking && !!filterUrl.trim()}
                  res={preview?.filter}
                >
                  {(v) => {
                    /*
                      차수 조건은 **없어도 판정은 돈다.** 없다고 빨갛게 칠하면
                      "못 쓴다" 로 읽혀서, 차수를 안 쓰는 팀이 멀쩡한 필터를
                      버리게 된다. 무엇이 빠지는지만 적는다.
                    */
                    const warns = [
                      v.projectKey
                        ? null
                        : '프로젝트를 못 읽어 판정이 멎습니다',
                      v.members.length === 0
                        ? '담당자 조건이 없어 팀원을 못 만듭니다'
                        : null,
                      v.memberFunctions.length > 0
                        ? `담당자가 그룹(${v.memberFunctions.join(', ')})이라 명단을 못 펼칩니다`
                        : null,
                      v.fixVersion
                        ? null
                        : '차수 조건이 없어 배포대장·진행률·아침 요약이 나가지 않습니다',
                    ].filter((x): x is string => !!x);
                    const blocking = !v.projectKey || v.members.length === 0;
                    return (
                      <Found
                        tone={blocking ? 'bad' : warns.length ? 'warn' : 'ok'}
                        title={v.filterName}
                        badge={
                          v.resolvedFilterId
                            ? `차트 → 필터 ${v.resolvedFilterId}`
                            : null
                        }
                        facts={[
                          v.projectKey,
                          v.issueType,
                          v.excludeStatuses.length
                            ? `제외 ${v.excludeStatuses.join(' ')}`
                            : null,
                          v.fixVersion,
                        ]}
                        people={v.members.map((m) => m.name)}
                        warns={warns}
                      />
                    );
                  }}
                </Checked>
              }
            >
              <FillableInput
                value={filterUrl}
                onChange={setFilterUrl}
                placeholder="https://hmg.atlassian.net/jira/dashboards/10542?maximized=17305"
                /* 주소는 끝이 중요하다(필터·페이지 번호). 고정폭이면 더 들어간다. */
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label="배포대장 루트 페이지"
              hints={[
                '차수 목록이 여기서 나옵니다',
                '월 페이지들을 담고 있는 맨 위 페이지',
              ]}
              optional
              error={errField === 'confluenceDeployRootId' ? errText : null}
              result={
                <Checked
                  busy={checking && !!deployRoot.trim()}
                  res={preview?.deployRoot}
                >
                  {(v) => {
                    const skipped = v.scannedCount - v.cycleCount;
                    const found = v.preview.filter((c) => 'fixVersion' in c);
                    return (
                      <Found
                        tone={v.problems.length ? 'warn' : 'ok'}
                        title={v.title}
                        badge={`차수 ${v.cycleCount}건`}
                        facts={[
                          `월 ${v.monthCount}개`,
                          `최근 ${v.months.length}개를 봄`,
                          skipped > 0 ? `${skipped}건 건너뜀` : null,
                        ]}
                        /*
                          실물을 보여준다. "차수 2건" 만으로는 그 둘이 무엇인지
                          배치가 한 번 돌 때까지 알 수 없다.
                        */
                        /*
                          제목을 나열하면 두 줄로 흐른다 (실측: `배포 관리 -
                          2026-08-27(정기배포) 멀티테넌트 전개`). 여기서 알고
                          싶은 것은 "어느 날짜가 잡히나" 뿐이라 날짜만 쓴다.
                        */
                        people={found
                          .slice(0, 4)
                          .map((c) => String(c.deployYmd ?? '').slice(5))
                          .filter(Boolean)}
                        peopleLabel="잡히는 차수"
                        warns={v.problems}
                      />
                    );
                  }}
                </Checked>
              }
            >
              <FillableInput
                value={deployRoot}
                onChange={setDeployRoot}
                placeholder="https://hmg.atlassian.net/wiki/spaces/SPC2/pages/167518624"
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label="판정 알림 채널"
              hints={['C 로 시작하는 채널 ID', '없으면 켤 수 없습니다']}
              optional
              error={errField === 'slackChannelId' ? errText : null}
              result={
                <Checked
                  busy={checking && !!channel.trim()}
                  res={preview?.channel}
                >
                  {(v) => (
                    <Found
                      tone={v.problem ? 'warn' : v.unknown ? 'off' : 'ok'}
                      title={v.name ? `#${v.name}` : v.id}
                      facts={[
                        v.archived ? '보관된 채널' : null,
                        v.notInChannel ? '봇이 없음' : null,
                      ]}
                      warns={[
                        v.problem,
                        v.unknown,
                        v.notInChannel
                          ? '봇을 이 채널에 초대해야 알림이 나갑니다'
                          : null,
                      ].filter((x): x is string => !!x)}
                    />
                  )}
                </Checked>
              }
            >
              <FillableInput
                value={channel}
                onChange={setChannel}
                placeholder="C0BVDJEJ19C"
                className="font-mono text-xs"
              />
            </Field>
          </div>
        )}

        {/*
          ── 지금 만들면 어떻게 되는가 ──

          빈 칸을 남겨 둘 수 있게 열어 놓으면, 만든 뒤에야 "왜 안 켜지지" 를
          묻게 된다. 누르기 **전에** 결과를 말한다. 빈 칸이 없으면 이 줄도
          없다 — 할 말이 없을 때 자리를 차지하지 않는다.
        */}
        {!members && missingNow.length > 0 && (
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            지금 만들면 <span className="text-foreground">꺼진 상태</span>로
            생성됩니다. {missingNow.join(', ')}을(를) 채워야 켤 수 있습니다.
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          {members ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setMembers(null)}
              >
                뒤로
              </Button>
              <Button
                size="sm"
                disabled={!triage || busy}
                onClick={() => void submit(triage)}
              >
                {busy && <Loader2 className="animate-spin" />}
                {busy ? '만드는 중' : '만들기'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                취소
              </Button>
              <div className="flex items-center gap-1">
                {/*
                  으뜸 버튼은 **하나**다.

                  전에는 `건너뛰고 만들기` 와 `다음` 이 나란히 진한 테두리로
                  서 있어, 둘 다 "앞으로 가는 길" 로 보였다. 필터를 넣었으면
                  다음 걸음(처음 받는 사람)이 있는 게 맞는 길이고, 건너뛰기는
                  그걸 미루는 선택이다. 미루는 쪽을 조용하게 둔다.

                  필터가 없으면 고를 명단이 없다. 그때는 건너뛰기가 유일한
                  길이므로 그 자리가 으뜸이 된다.
                */}
                {hasFilter ? (
                  <>
                    {/*
                      확인 중에도 **막지 않는다.**

                      이 버튼의 뜻은 "지금 이걸 붙들고 있을 여유가 없으니
                      만들어 두고 설정에서 하겠다" 다. 확인을 기다리라고
                      막으면 버튼의 존재 이유와 모순된다. 필터는 어차피
                      안 실려 간다 (skipFilter).
                    */}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canCreate || busy}
                      onClick={() => void submit('', true)}
                    >
                      나중에 채우기
                    </Button>
                    {/*
                      이쪽은 막는다. 이 버튼이 하는 일이 **지금 확인 중인 그
                      필터**를 읽는 것이라, 답을 보기 전에 넘어가면 미리보기를
                      붙인 의미가 없다. 확인이 실패로 끝났을 때도 막는다 —
                      눌러 봤자 같은 실패를 한 번 더 보게 된다. 그때 나갈 길은
                      옆의 `나중에 채우기` 다.

                      막기만 하면 왜 안 눌리는지 모른다. 글자로 말하게 한다.
                    */}
                    <Button
                      size="sm"
                      disabled={!canCreate || busy || checking || filterFailed}
                      onClick={goToTriageStep}
                    >
                      {(busy || checking) && (
                        <Loader2 className="animate-spin" />
                      )}
                      {checking ? '확인하는 중' : '다음'}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={!canCreate || busy}
                    onClick={() => void submit('', true)}
                  >
                    {busy && <Loader2 className="animate-spin" />}
                    {busy ? '만드는 중' : '만들기'}
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 칸 하나. 설명은 **불릿로 끊어 적는다.**
 *
 * 한 문장으로 이어 붙였더니 `팀에서 공유받은 대시보드 주소를 그대로 넣어도
 * 됩니다. 차트를 펼친 주소(?maximized=…)면 그 차트가 보는 필터를 찾아
 * 씁니다. Ignite, HMG 둘 다 됩니다` 처럼 세 줄이 됐다. 읽는 사람은 이 중
 * **자기에게 해당하는 한 줄**만 필요한데, 그걸 찾으려면 전부 읽어야 한다.
 */
function Field({
  label,
  hints,
  optional,
  error,
  result,
  children,
}: {
  label: string;
  hints: string[];
  /** 비워도 되는 칸. 적어 두지 않으면 사람이 다 채워야 하는 줄 안다. */
  optional?: boolean;
  /** 서버가 이 칸을 짚었을 때의 문구. */
  error?: string | null;
  /** 붙여넣은 값이 무엇인지에 대한 답. */
  result?: React.ReactNode;
  children: React.ReactNode;
}) {
  /*
    설명은 **아직 안 넣었을 때만** 보여준다.

    넣고 나면 그 자리에 답이 온다. 답과 설명을 같이 쌓으면 "이 칸에 무엇을
    넣어야 하나" 와 "내가 넣은 게 무엇인가" 가 나란히 놓여, 지금 읽어야 할
    쪽이 어느 것인지 흐려진다. 설명은 길잡이지 결과가 아니다.
  */
  const answered = !!result || !!error;
  return (
    <div>
      <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
        {label}
        {optional && <span className="ml-1 font-normal opacity-70">선택</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-[11.5px] leading-snug text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : (
        result
      )}
      {!answered && (
        <ul className="mt-1 space-y-0.5">
          {hints.map((h) => (
            <li
              key={h}
              className="text-[11.5px] leading-snug text-muted-foreground"
            >
              · {h}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 빈 칸에서 Tab 을 누르면 예시값이 들어가는 입력란.
 *
 * ── 왜 이게 말이 되나 ──
 *
 * 여기 placeholder 는 지어낸 예시가 아니라 **실제로 쓰는 값**이다
 * (그룹웨어 대시보드·배포대장·CPO 알림 채널). 매번 다른 탭에서 찾아와
 * 붙여넣던 주소라 한 번에 넣을 수 있으면 실수도 준다.
 *
 * ── Tab 을 가로채는 건 위험하다 ──
 *
 * Tab 은 초점을 옮기는 키다. 아무 때나 가로채면 키보드로만 쓰는 사람이
 * 폼을 빠져나갈 수 없다. 그래서 **빈 칸일 때만** 가로챈다.
 *   · 값이 있으면 그대로 다음 칸으로 간다 (잃을 게 없을 때만 개입)
 *   · 채운 뒤에는 칸이 더 이상 비어 있지 않으므로 다음 Tab 은 넘어간다
 *   · Shift+Tab(뒤로 가기)은 절대 안 건드린다
 *
 * 그리고 **보이게 한다.** 오른쪽 `Tab` 칩이 없으면 이 동작을 아무도 모른다.
 */
function FillableInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 그대로 값이 될 수 있는 것만 넣는다. `예: …` 같은 설명은 안 된다. */
  placeholder: string;
  className?: string;
}) {
  const empty = !value;
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(empty && 'pr-12', className)}
        onKeyDown={(e) => {
          if (e.key !== 'Tab' || e.shiftKey || !empty) return;
          e.preventDefault();
          onChange(placeholder);
        }}
        aria-describedby={empty ? 'tab-to-fill' : undefined}
      />
      {empty && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            Tab
          </span>
          <span id="tab-to-fill" className="sr-only">
            Tab 키를 누르면 예시 주소가 채워집니다
          </span>
        </>
      )}
    </div>
  );
}

/**
 * 붙여넣은 주소가 **무엇에 닿았는지**.
 *
 * ── 왜 이 모양인가 ──
 *
 * 처음에는 회색 네 줄이었다. 필터 이름도, 팀원 명단도, "차수 조건 없음" 도
 * 같은 크기·같은 색이라 **무엇이 중요한지 눈으로 못 갈랐다.** 다 읽어야
 * 문제가 있는지 알 수 있으면 아무도 안 읽는다.
 *
 * 세 층으로 나눈다.
 *   ① 찾은 것의 이름   가장 크게. "내가 맞는 걸 넣었나" 의 답이다
 *   ② 딸려 오는 사실   작게 한 줄로. 맞다는 걸 확인하는 근거다
 *   ③ 그대로 두면 곤란한 것  amber 로 따로. 색만으로 구분하지 않도록 문장으로 적는다
 *
 * ── 왜 LED 인가 ──
 *
 * 목록 화면이 대상의 건강을 `StatusLed` 로 말한다. 만들기 시점에도 같은
 * 기호를 쓰면, 만들기 전에 이미 그 대상의 상태를 보는 셈이 된다. 새 기호를
 * 지어내면 같은 뜻을 두 가지로 배워야 한다.
 */
function Found({
  tone,
  title,
  badge,
  facts,
  people,
  peopleLabel = '팀원',
  warns,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'off';
  title: string;
  /** 해석 결과처럼 **사람이 안 넣은 값**. 어디서 왔는지 드러낸다. */
  badge?: string | null;
  facts: (string | null | undefined)[];
  people?: string[];
  peopleLabel?: string;
  warns: string[];
}) {
  const shown = facts.filter(Boolean) as string[];
  return (
    <div className="mt-1.5 space-y-1 rounded-md border bg-muted/40 px-2.5 py-2">
      <div className="flex items-start gap-1.5">
        <StatusLed tone={tone} className="mt-[5px]" />
        <p className="min-w-0 flex-1 text-xs font-semibold leading-snug">
          {title}
        </p>
        {/*
          `info`(파랑)로 뒀더니 화면에서 가장 먼저 눈에 띄었다. 이건 부가
          정보고, 시선을 가져가야 하는 것은 amber 경고다. 한 단 낮춘다.
        */}
        {badge && (
          <Badge variant="muted" className="shrink-0 font-normal">
            {badge}
          </Badge>
        )}
      </div>

      {shown.length > 0 && (
        <p className="pl-3.5 text-[11.5px] leading-snug text-muted-foreground">
          {shown.join(' · ')}
        </p>
      )}

      {people && people.length > 0 && (
        <p className="pl-3.5 text-[11.5px] leading-snug text-muted-foreground">
          <span className="text-foreground/70">
            {peopleLabel} {people.length}
          </span>
          {' · '}
          {people.join(', ')}
        </p>
      )}

      {/* 색에만 기대지 않는다. 문장이 무엇이 곤란한지 그대로 말한다. */}
      {warns.map((w) => (
        <p
          key={w}
          className="pl-3.5 text-[11.5px] leading-snug text-amber-700 dark:text-amber-400"
        >
          {w}
        </p>
      ))}
    </div>
  );
}

/**
 * 붙여넣은 값 하나에 대한 확인 결과.
 *
 * 세 상태를 한 자리에서 보여준다.
 *   · 묻는 중   무엇이 걸려 있는지 알 수 없어 기다리는 중
 *   · 읽었다    무엇으로 해석됐는지
 *   · 못 읽었다 왜 못 읽었는지
 *
 * 마지막이 중요하다. 전에는 못 읽어도 아무 말이 없어서, [만들기] 를 누를
 * 때까지 주소가 틀린 줄 몰랐다.
 */
function Checked<T>({
  busy,
  res,
  children,
}: {
  /**
   * **이 칸**을 지금 확인하고 있는가.
   *
   * 확인은 세 칸을 한 번에 묻지만, 진행 표시는 칸마다 따로다. 전역
   * `checking` 을 그대로 넘겼더니 **값이 없는 칸까지** "확인하는 중" 이
   * 떴다 — 배포대장을 치는데 판정 알림 칸이 확인 중이라고 말했다.
   * 빈 칸은 물어본 적도 없으니 아무 말도 하면 안 된다.
   */
  busy: boolean;
  res?: { ok: true; value: T } | { ok: false; error: string };
  children: (value: T) => React.ReactNode;
}) {
  if (busy && !res) {
    return (
      <p className="mt-1 flex items-center gap-1 text-[11.5px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        확인하는 중
      </p>
    );
  }
  if (!res) return null;
  if (!res.ok) {
    return (
      <p className="mt-1 rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-[11.5px] leading-snug text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        {res.error}
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-0.5 border-l-2 border-muted-foreground/25 pl-2">
      {children(res.value)}
    </div>
  );
}
