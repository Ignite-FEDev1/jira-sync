-- QA Router · 아무도 안 부르는 함수 오버로드 둘을 걷어낸다
--
-- ── 무엇이 남아 있었나 ──────────────────────────────────────────────────────
--
--   public.qa_router_detail_lines  가 두 벌
--   public.qa_router_progress_line 도 두 벌
--
--   같은 이름의 오버로드가 둘이면 인자 수가 겹치는 호출은 어느 쪽인지
--   못 고르고 `function ... is not unique` 로 죽는다. 실제로 그래서
--   2026-09-15 06:59 의 마이그레이션 적용이 중간에 멈췄고, 그 뒤 15개
--   파일이 밀린 채로 있었다.
--
-- ── 왜 생겼나 ───────────────────────────────────────────────────────────────
--
--   적용 순서는 파일명 정렬순이다. 그런데 `20260911_qa_router_message_*`
--   아홉 개는 날짜가 같아서 **주제 이름의 알파벳순**으로 돈다.
--
--     정렬순:   blocks → board_link → grouping → headline → lines → ...
--     실제 순서: lines → ... → board_link → grouping → headline → blocks
--
--   둘이 거의 뒤집혀 있다. 뒤에 올 파일이 먼저 돌면서, 앞 파일이 지웠어야
--   할 옛 시그니처가 지워지지 않고 남았다.
--
-- ── 지워도 되는 근거 ────────────────────────────────────────────────────────
--
--   지금 DB 를 스캔해 확인했다.
--
--     · detail_lines  를 부르는 함수는 `qa_router_daily_summary` 하나뿐이고
--       9개 인자(p_config_name 포함)로 부른다 → 10-arg 는 호출자가 없다
--     · progress_line 은 `qa_router_vars` 와 `qa_router_daily_summary` 가
--       부르고 **둘 다** 채널을 넘긴다(5-arg) → 4-arg 는 호출자가 없다
--     · `p_blocks` 라는 이름이 나오는 함수는 지워질 그 함수 자신뿐이다
--
--   남겨 두면 다음 사람이 "둘 중 어느 게 진짜냐" 를 또 풀어야 한다.
--
-- ── 앞으로 ──────────────────────────────────────────────────────────────────
--
--   같은 날짜에 파일을 둘 이상 만들 때는 순서를 이름에 박는다.
--   `20260915_01_주제.sql` 처럼. 주제 이름이 순서를 정하게 두면 안 된다.
--   (supabase/migrations/README.md 의 "파일 규칙" 참고)

-- message_blocks 가 만든 10-arg. message_blocks 는 이 자리에 오기 전
-- 8-arg 를 지우도록 쓰여 있지만, 정렬순 때문에 8-arg 가 생기기 **전에**
-- 돌아서 그 drop 이 헛돌았다.
drop function if exists public.qa_router_detail_lines(
  uuid, text, date, text, date, date, text, text, text, jsonb
);

-- 채널 인자가 붙기 전의 4-arg. 20260915_qa_router_progress_line_channel 이
-- 5-arg 를 새로 만들면서 옛것을 안 지웠다.
drop function if exists public.qa_router_progress_line(
  jsonb, text, timestamptz, date
);

-- 이름당 하나씩만 남았는지 확인한다. 둘 이상이면 여기서 멈춘다.
do $$
declare
  n int;
  bad text;
begin
  select string_agg(proname || ' × ' || cnt, ', '), max(cnt)
    into bad, n
    from (
      select p.proname, count(*) as cnt
        from pg_proc p
        join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public'
         and p.proname in ('qa_router_detail_lines', 'qa_router_progress_line')
       group by p.proname
      having count(*) > 1
    ) t;

  if n is not null then
    raise exception '오버로드가 아직 남아 있습니다: %', bad;
  end if;
end $$;
