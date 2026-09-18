-- QA Router · 메시지 미리보기
--
-- 화면이 "이 설정이면 이렇게 나갑니다" 를 저장 **전에** 보여줄 수 있어야
-- 한다. 그런데 미리보기를 TS 로 다시 만들면 두 벌이 조용히 어긋난다 —
-- 화면에서는 멀쩡한데 실제로 나간 건 다른 상황이 가장 나쁘다.
--
-- 그래서 크론이 쓰는 조각(progress_line · detail_lines)을 그대로 부른다.
-- 머리글 조립만 여기 한 줄 더 있는데, 그건 크론 쪽과 같은 format 이다.

create or replace function public.qa_router_preview_message(
  p_config_id uuid,
  -- null 이면 저장된 설정으로 그린다. 편집 중이면 저장 전 값이 온다.
  p_blocks jsonb default null,
  p_milestone text default 'QA 종료'
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record; cyc record;
  blocks jsonb; prod_ymd date; qa_end_ymd date;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  total_n int; done_n int; emoji text; title text;
begin
  select c.id, c.qa_thread_channel_id, c.message_blocks,
         s.active_cycle->>'fixVersion' as active_fv
    into r
    from public.qa_router_configs c
    left join public.qa_router_state s on s.config_id = c.id
   where c.id = p_config_id;
  if not found or r.active_fv is null then return null; end if;

  select * into cyc from public.qa_router_cycles
   where config_id = r.id and fix_version = r.active_fv;
  if not found then return null; end if;

  blocks := coalesce(p_blocks, r.message_blocks);
  prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
  qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);

  total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
  done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);
  title := coalesce(cyc.deploy_page_title, r.active_fv);
  emoji := case when total_n > 0 and done_n < total_n
                then ':warning:' else ':date:' end;

  return concat_ws(E'\n',
    format('%s *%s* - `%s`', emoji, title, p_milestone),
    case when coalesce((blocks->>'progress')::boolean, true)
         then public.qa_router_progress_line(
           cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst)
    end,
    public.qa_router_detail_lines(
      r.id, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
      qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id,
      r.qa_thread_channel_id, blocks));
end;
$$;

/*
  어드민은 anon 으로 부른다. 이 함수는 **읽기만** 하고 토큰을 만지지 않아
  노출해도 안전하다 — 같은 값을 이미 화면이 테이블에서 직접 읽고 있다.
*/
grant execute on function public.qa_router_preview_message(uuid, jsonb, text)
  to anon, authenticated;
