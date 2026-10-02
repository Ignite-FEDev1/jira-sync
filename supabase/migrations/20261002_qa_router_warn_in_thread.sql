/*
  일정 경고를 채널이 **실제로 갈릴 때만** 운영 채널로 보낸다.

  ── 왜 ──

  `20260930_qa_router_alert_model.sql` 은 경고를 늘 `ops_channel` 로 보냈다.
  의도는 그 파일 주석에 있다: "QA 스레드는 QA 팀이 읽는 자리고, 이것은 우리
  설정 문제다."

  그런데 `ops_channel` 은 `coalesce(c.slack_ops_channel_id, c.slack_channel_id)`
  이다. 운영 대상 둘 다 `slack_ops_channel_id` 가 null 이라 같은 채널로
  떨어진다 — **"QA 스레드 ≠ 운영 채널" 이라는 가정이 운영에서 한 번도 참인
  적이 없다.** 나누는 이득은 없고, 차수 스레드를 따라가는 사람이 경고를
  못 보는 비용만 남는다.

  채널을 **실제로 나눈** 대상에서는 지금 그대로 운영 채널로 간다. 의도를
  뒤집지 않고 가정을 실제와 맞춘다.

  ── 나가는 글자는 안 바뀐다 ──

  목적지만 바뀐다. 골든 14키는 한 자도 달라지지 않는다.

  ── 트랜잭션은 이 파일이 잡지 않는다 ──

  `db-migrate.sh` 가 `--single-transaction` 으로 감싸서 돈다. 여기서 또
  `begin;` 을 쓰면 경고가 뜨고, `rollback;` 은 DDL 을 되돌리면서 `_migrations`
  insert 는 남겨 "적용 안 됐는데 적용됨" 을 만든다.

  ── 시그니처는 그대로다 ──

  인자 없는 `qa_router_alerts()` 를 `create or replace` 만 한다. 인자를
  하나라도 더하면 오버로드가 생겨 크론의 옛 호출이 `is not unique` 로
  죽는다 — 이 레포가 두 번 겪은 사고다.

  본문은 `20260930_qa_router_alert_model.sql` 의 것을 그대로 옮기고,
  `scheduleUnusable` 갈래의 목적지 한 자리만 바꿨다.
*/

-- ── 디스패처 ────────────────────────────────────────────────────────────
/*
  10분마다 깨어나 대상마다 "지금 보낼 규칙" 을 묻고, 종류대로 본문을 만들어
  보내고, 보낸 규칙의 날짜를 적는다.

  ── 종류마다 다른 것 셋을 보존한다 ──

                 보내는 자리                     억제                 thread_ts
    anchor       스레드 있으면 채널, 없으면 운영  없음                 붙인다
    schedule…    채널이 갈리면 운영, 아니면 채널  should_warn +        갈릴 때만 뺀다
                                                 schedule_warned_on
    activeCycle  스레드 있으면 채널, 없으면 운영  daily_summary_digest 스레드면 붙인다

  경고만 운영 채널을 보던 이유는 옛 주석에 적혀 있다: "QA 스레드는 QA 팀이
  읽는 자리고, 이것은 우리 설정 문제다". 그 분리는 두 채널이 **실제로
  다를 때만** 뜻이 있으므로, 이제 다를 때만 한다 (파일 머리 주석 참고).
  `alert_sent_on` 은 `should_warn` 과 지문 억제를 **대체하지 않는다.**
  그것들은 "오늘 보냈나" 보다 좁은 조건이라 둘 다 통과해야 나간다.

  ── 왜 놓친 시각이 사라지나 ──

  09:10 크론이 늦으면 그날 알림이 통째로 없었다. "오늘 이 규칙을 보냈나" 를
  `alert_sent_on` 에 적으므로, 09:40 에 깨어나도 그날 몫이 나간다.

  ── qa_router_hit_rule 은 안 건드린다 ──

  그 함수는 "오늘 어느 앵커 규칙이 걸리나" 만 답하고 시각은 여기서 먼저
  거른다. 인자를 늘리면 오버로드가 생겨 옛 호출부가 `is not unique` 로
  죽는데, 이 레포는 그 함정을 두 번 겪었다. 대신 **앵커 규칙만 옛 모양으로
  되감아** 넘긴다 - 넘기는 값이 전과 똑같으므로 답도 똑같다.
*/
create or replace function public.qa_router_alerts()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  now_hm text := to_char(now() at time zone 'Asia/Seoul', 'HH24:MI');
  cyc record;
  win record;
  prod_day date;
  rules jsonb; anchor_rules jsonb; hit jsonb;
  when_ok jsonb; due jsonb; rid text; rule jsonb; kind text;
  judged int; failed int; reassigned int;
  stalled boolean; head_kind text;
  progress_line text; detail_lines text; schedule_note text; digest text;
  vars jsonb; body text; target text; payload jsonb;
  -- 경고를 스레드 안으로 보낼지. 채널이 실제로 갈릴 때만 거짓이 된다.
  in_thread boolean;
begin
  select decrypted_secret into token from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  if token is null then return; end if;

  for r in
    select c.id, c.name, c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           c.alert_rules, c.qa_schedule_rule,
           s.last_poll_at, s.consecutive_fails, s.daily_summary_digest,
           coalesce(s.alert_sent_on, '{}'::jsonb) as alert_sent_on,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    -- 보고 있는 차수가 없으면 세 종류 모두 할 말이 없다.
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    rules := public.qa_router_alert_rules_for(cyc.alert_rules_override,
                                              r.alert_rules);

    -- 사다리가 이 차수의 QA 기간을 정한다
    select * into win from public.qa_router_qa_window(
      cyc.qa_start_ymd_manual, cyc.qa_end_ymd_manual,
      cyc.qa_start_ymd,        cyc.qa_end_ymd,
      cyc.prod_ymd,            cyc.deploy_ymd,
      r.qa_schedule_rule);

    -- 운영 배포일은 제목과 본문 중 늦은 쪽 (TS prodDayOf 와 같다).
    prod_day := greatest(cyc.deploy_ymd, coalesce(cyc.prod_ymd, cyc.deploy_ymd));

    /*
      앵커 규칙만 옛 모양으로 되감아 `qa_router_hit_rule` 에 넘긴다. 그
      함수가 고르는 **한 개**가 오늘의 날짜 알림이다. 마감선 계산도 그
      안에 있으므로 넘기는 배열이 전과 같아야 답이 같다.
    */
    anchor_rules := (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id',      e.value->>'id',
          'anchor',  e.value#>>'{when,anchor}',
          'offset',  (e.value#>>'{when,offset}')::int,
          'shift',   e.value#>>'{when,shift}',
          'label',   e.value->>'label',
          'enabled', (e.value->>'enabled')::boolean)
        || case when e.value ? 'template'
                then jsonb_build_object('template', e.value->>'template')
                else '{}'::jsonb end
        order by e.ordinality), '[]'::jsonb)
        from jsonb_array_elements(rules) with ordinality e
       where e.value#>>'{when,kind}' = 'anchor');

    hit := public.qa_router_hit_rule(
             anchor_rules, win.qa_start, win.qa_end, prod_day, today_kst);

    /*
      규칙 id → when 이 참인가.

      · anchor          오늘 걸린 그 한 개인가
      · activeCycle     차수가 아직 안 지났나 (옛 `continue when
                        cyc.deploy_ymd < today_kst` 와 같다)
      · scheduleUnusable 창이 없거나 어긋나고, QA 알림을 쓰는 대상이고,
                        **오늘이 경고 차례인가**

      ── 억제는 고른 **뒤**가 아니라 고르기 **전에** 봐야 한다 ──

      `qa_router_due_rules` 는 같은 `at` 에서 목록 앞엣것 하나만 남긴다.
      경고의 "처음 1회 + 그 뒤 월요일"(`qa_router_should_warn`)을 고른
      뒤에 보면, 화요일의 09:10 은 **경고가 자리만 차지하고 아무것도 안
      나가는** 시각이 된다 - 같은 09:10 에 있던 다른 규칙(마이그레이션이
      경고를 목록 끝에 붙이므로 사람이 새로 만든 날짜 알림이 그 뒤에
      온다)이 통째로 굶는다. `alert_sent_on` 도 안 적히니 10분 뒤에도
      같은 판단을 반복해 그날은 조용하다.

      그래서 억제를 `when` 쪽으로 올린다. 억제된 경고는 애초에 "지금 보낼
      규칙" 이 아니므로 자리를 안 잡고, 뒤엣것이 그 시각을 가져간다.
      `schedule_warned_on` 을 적는 자리는 실제로 보내는 아래 갈래 그대로다.
    */
    when_ok := (
      select coalesce(jsonb_object_agg(e.value->>'id',
        case e.value#>>'{when,kind}'
          when 'anchor' then (hit is not null and hit->>'id' = e.value->>'id')
          when 'activeCycle' then cyc.deploy_ymd >= today_kst
          when 'scheduleUnusable' then
            win.source in ('none', 'invalid')
            and public.qa_router_wants_qa_alerts(rules)
            and public.qa_router_should_warn(cyc.schedule_warned_on, today_kst)
        end), '{}'::jsonb)
        from jsonb_array_elements(rules) e);

    due := public.qa_router_due_rules(
             rules, today_kst, now_hm, r.alert_sent_on, when_ok);

    for rid in select jsonb_array_elements_text(due) loop
      select e.value into rule
        from jsonb_array_elements(rules) with ordinality e
       where e.value->>'id' = rid
       order by e.ordinality limit 1;
      kind := rule#>>'{when,kind}';

      if kind = 'anchor' then
        /*
          울릴 날을 정한 값과 **같은 값**으로 본문을 만든다. `hit` 는
          `{days}` 를 이미 바꾼 문구를 들고 있다.
        */
        body := public.qa_router_render(
          coalesce(hit->>'template', public.qa_router_default_template()),
          public.qa_router_vars(r.id, r.active_fv, hit->>'label', today_kst,
                                win.qa_start, win.qa_end, prod_day));
        continue when body is null;
        target := case when r.thread_ts is not null
                       then r.slack_channel_id else r.ops_channel end;
        payload := jsonb_build_object('channel', target, 'text', body);
        if r.thread_ts is not null then
          payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
        end if;

      elsif kind = 'scheduleUnusable' then
        /*
          "처음 1회 + 그 뒤 월요일"(`qa_router_should_warn`)은 위
          `when_ok` 에서 이미 봤다. 여기서 한 번 더 `continue` 하면 그
          09:10 자리를 차지만 하고 아무것도 안 보내 **뒤엣 규칙을
          굶긴다** - 그래서 억제는 고르기 전에만 있다.
        */
        vars := public.qa_router_vars(r.id, r.active_fv, null, today_kst,
                                      win.qa_start, win.qa_end, prod_day)
                || jsonb_build_object(
                     '기호', ':warning:',
                     '대상이름', r.name,
                     -- 옛 문장이 차수를 대장 제목의 날짜로 불렀다
                     '차수', to_char(cyc.deploy_ymd, 'MM/DD'),
                     '일정경고이유', coalesce(
                       win.why, 'QA 시작·종료일을 어디에서도 못 읽었습니다'));
        body := public.qa_router_render(
          coalesce(rule->>'template',
                   public.qa_router_schedule_warning_template()), vars);
        continue when body is null;

        /*
          채널을 실제로 나눈 대상만 운영 채널로 보낸다. 안 나눈 대상에서는
          `ops_channel` 이 `slack_channel_id` 로 떨어져 같은 채널이므로,
          분리의 이득 없이 스레드 맥락만 끊긴다.
        */
        if r.ops_channel is distinct from r.slack_channel_id then
          target := r.ops_channel;
          in_thread := false;
        else
          target := r.slack_channel_id;
          in_thread := r.thread_ts is not null;
        end if;
        payload := jsonb_build_object('channel', target, 'text', body);
        if in_thread then
          payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
        end if;

        update public.qa_router_cycles set schedule_warned_on = today_kst
         where config_id = r.id and deploy_ymd = cyc.deploy_ymd;

      elsif kind = 'activeCycle' then
        select
          count(*) filter (where e.classification <> 'system'),
          count(*) filter (where e.error is not null),
          count(*) filter (where e.reassigned)
          into judged, failed, reassigned
        from public.qa_router_events e
        where e.config_id = r.id
          and (e.created_at at time zone 'Asia/Seoul')::date = today_kst;

        stalled := r.last_poll_at is null
                   or r.last_poll_at < now() - interval '1 hour';

        /*
          머리말의 **종류**를 따로 들고 있는다. 지문에도 이것이 들어가고
          (글자가 아니라 종류라 실패 건수가 3→5 로 바뀌어도 같은 칸이다),
          "경고면 무조건 보낸다" 판정도 이것으로 한다.
        */
        head_kind := case
          when stalled then 'stalled'
          when coalesce(failed, 0) > 0 then 'failed'
          when coalesce(r.consecutive_fails, 0) > 0 then 'streak'
          else 'ok' end;

        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.plan_collected_at, today_kst);

        /*
          `none` 과 `invalid` 은 **다른 문장**이다. 템플릿에는 조건이 없어
          고르기를 못 하므로, 고른 결과를 `{일정경고이유}` 에 통째로 담는다.
          QA 시작·종료 알림을 끈 대상은 조르지 않는다.
        */
        schedule_note := case
          when not public.qa_router_wants_qa_alerts(rules) then null
          when win.source = 'invalid' then
            format(':warning: QA 일정이 서로 어긋납니다 · %s · 차수 화면에서 고쳐 주세요',
                   win.why)
          when win.source = 'none' then
            ':warning: 이 차수의 QA 시작·종료일이 아직 없습니다 · 차수 화면에서 넣거나 배포대장에 적어 주세요'
          end;

        vars := public.qa_router_vars(r.id, r.active_fv, null, today_kst,
                                      win.qa_start, win.qa_end, prod_day)
                || jsonb_strip_nulls(jsonb_build_object(
                     -- 이 알림의 머리 기호는 진행률이 아니라 상태가 정한다
                     '기호', case when head_kind = 'ok'
                                  then ':crescent_moon:' else ':warning:' end,
                     '대상이름', r.name,
                     '상태문구', case head_kind
                       when 'stalled' then '오늘 마감 · 확인이 멈춰 있습니다'
                       when 'failed'  then format('오늘 마감 · 실패 %s건', failed)
                       when 'streak'  then format('오늘 마감 · 연속 실패 %s회',
                                                  r.consecutive_fails)
                       else '오늘 마감' end,
                     -- 괄호까지 한 변수에 담는 이유는 템플릿 함수 주석 참고
                     '알림건수', format('%s건%s', coalesce(judged, 0),
                       case when coalesce(reassigned, 0) > 0
                            then format(' (Jira 변경 %s건)', reassigned)
                            else '' end),
                     '재배정건수', case when coalesce(reassigned, 0) > 0
                                        then reassigned::text end,
                     '마지막확인', coalesce(
                       to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
                       '기록 없음'),
                     '일정경고이유', schedule_note,
                     /*
                       이 알림의 상세 링크는 날짜 알림과 **글자가 다르다.**
                       `qa_router_detail_lines` 가 "대상 &gt; 차수" 로 적는다.
                     */
                     '상세링크', case when cyc.deploy_ymd is not null then
                       format('<%s/admin/qa-router/%s/cycles/%s|%s &gt; %s>',
                              public.qa_router_admin_base(), r.id, cyc.deploy_ymd,
                              public.qa_router_esc(r.name),
                              public.qa_router_esc(coalesce(
                                cyc.deploy_page_title, r.active_fv))) end));

        /*
          일정·참고 블록은 **스레드 밖일 때만** 싣는다. 스레드 안이면 같은
          내용이 루트 메시지에 이미 있어 한 번 올려다보면 된다 — 옛 함수의
          `if r.thread_ts is null then detail_lines := … else null end` 과
          같은 판단이고, 활성 차수에는 늘 스레드가 있으므로 **이쪽이 평소**다.

          머리말 둘은 안 넣는 것으로, 내용 다섯은 키를 **지우는 것**으로
          비운다. `jsonb_strip_nulls` 로 덮으면 위 `qa_router_vars` 가 넣어 둔
          값이 그대로 남으므로 지우는 쪽이어야 한다. 그러면 여섯 줄이
          `qa_router_render` 의 빈 변수 규칙에 걸려 통째로 빠진다.
        */
        if r.thread_ts is null then
          vars := vars || jsonb_build_object(
            '일정머리말', '*일정*', '참고머리말', '*참고*');
        else
          vars := vars - array['QA종료일', '운영배포일', '상세링크',
                               '배포대장링크', 'fixVersion'];
        end if;

        body := public.qa_router_render(
          coalesce(rule->>'template',
                   public.qa_router_daily_summary_template()), vars);
        continue when body is null;

        /*
          지문은 옛 재료 그대로 만든다. 본문 전체로 지문을 뜨면
          `마지막 확인 17:59` 가 매일 달라 지문이 늘 바뀌고, "달라진 게
          없으면 건너뛴다" 가 한 번도 발동하지 않는다. 그래서 `detail_lines`
          도 지문을 위해서만 한 번 더 부른다 - 스레드 안인지가 지문에
          들어가 있던 것을 그대로 지킨다.
        */
        if r.thread_ts is null then
          detail_lines := public.qa_router_detail_lines(
            r.id, r.name, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
            win.qa_end, prod_day, cyc.deploy_page_id);
        else
          detail_lines := null;
        end if;

        digest := md5(concat_ws('|',
          r.active_fv,
          head_kind,
          case when stalled then 'stale' else 'live' end,
          coalesce(progress_line, ''),
          coalesce(judged, 0)::text,
          coalesce(reassigned, 0)::text,
          coalesce(schedule_note, ''),
          coalesce(detail_lines, '')));

        -- 문제가 있는 날은 지문과 무관하게 보낸다.
        continue when head_kind = 'ok'
                  and schedule_note is null
                  and r.daily_summary_digest is not distinct from digest;

        target := case when r.thread_ts is not null
                       then r.slack_channel_id else r.ops_channel end;
        payload := jsonb_build_object('channel', target, 'text', body);
        if r.thread_ts is not null then
          payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
        end if;

        insert into public.qa_router_state (config_id, daily_summary_digest)
        values (r.id, digest)
        on conflict (config_id) do update
          set daily_summary_digest = excluded.daily_summary_digest;

      else
        continue;
      end if;

      perform net.http_post(
        url := 'https://slack.com/api/chat.postMessage',
        headers := jsonb_build_object('Authorization', 'Bearer ' || token,
                                      'Content-Type', 'application/json'),
        body := payload);

      /*
        보낸 것을 적는다. `net.http_post` 는 큐에 넣고 바로 돌아오므로
        이것은 "보냈다" 가 아니라 **"보내려 했다"** 다 - 옛 지문과 같은
        한계이고, 같은 거래를 받아들인다.
      */
      insert into public.qa_router_state (config_id, alert_sent_on)
      values (r.id, jsonb_build_object(rid, today_kst::text))
      on conflict (config_id) do update
        set alert_sent_on = coalesce(qa_router_state.alert_sent_on, '{}'::jsonb)
                            || excluded.alert_sent_on;
    end loop;
  end loop;
end;
$$;

comment on function public.qa_router_alerts() is
  '알림 디스패처. 10분마다 돌며 alert_rules 의 at·when 을 보고 그날 몫을 보낸다.';

revoke execute on function public.qa_router_alerts()
  from public, anon, authenticated;
