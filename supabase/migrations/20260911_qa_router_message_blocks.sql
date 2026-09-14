-- QA Router · 요약 메시지를 블록으로 고칠 수 있게
--
-- 지금 나가는 메시지는 이렇게 생겼다.
--
--   :date: *Dev) 배포 - 2026-09-14(정기)* - `QA 종료`   ← 머리글
--   >*FE1 담당 기획건 7건 모두 QA 완료* _(09-10 부 확인)_  ← 진행률
--   *일정*
--   • QA 종료일 : 09-09(수)
--   • 운영 배포일 : 09-10(목)
--   *참고*
--   • QA 라우터 상세 : …
--   • QA 스레드 : …
--   • 배포대장 : …
--   • fixVersion : `release_20260914`
--
-- 머리글 문구는 이미 alert_rules 의 label 로 고친다. 나머지는 코드에 박혀
-- 있어서, 줄 하나 빼려면 이 함수를 다시 써야 했다.
--
-- ── 왜 자유 텍스트 템플릿이 아닌가 ──
--
-- `{{제목}}` 같은 치환 문법을 열면 템플릿 언어를 하나 들이는 셈이 된다.
-- 그러면 오타 난 템플릿이 **배치가 도는 새벽에** 터지고, 그때 화면은 이미
-- 저장을 받아 준 뒤다. 여기서는 **어떤 줄을 어떤 순서로 넣을지**만 정한다 —
-- 실제로 고치고 싶었던 것도 그것이었다("fixVersion 줄은 필요 없다" 같은).
--
-- 배열인 이유: 순서와 on/off 를 한 값으로 말한다. 빠진 항목은 안 나가고,
-- 빈 배열이면 그 블록이 통째로 사라진다.

alter table public.qa_router_configs
  add column if not exists message_blocks jsonb not null default jsonb_build_object(
    'progress', true,
    'schedule', jsonb_build_array('qaEnd', 'prod'),
    'refs', jsonb_build_array('detail', 'thread', 'deployPage', 'fixVersion')
  );

alter table public.qa_router_configs
  alter column message_blocks set default jsonb_build_object(
    'progress', true,
    'schedule', jsonb_build_array('qaEnd', 'prod'),
    'refs', jsonb_build_array('detail', 'thread', 'deployPage', 'fixVersion')
  );

comment on column public.qa_router_configs.message_blocks is
  '요약 메시지에 넣을 줄과 그 순서. 빠진 항목은 안 나간다.';

create or replace function public.qa_router_valid_blocks(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and jsonb_typeof(p->'schedule') = 'array'
     and jsonb_typeof(p->'refs') = 'array'
     and not exists (
       select 1 from jsonb_array_elements_text(p->'schedule') t
        where t not in ('qaEnd', 'prod')
     )
     and not exists (
       select 1 from jsonb_array_elements_text(p->'refs') t
        where t not in ('detail', 'thread', 'deployPage', 'fixVersion')
     );
$$;

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_message_blocks_check;
alter table public.qa_router_configs
  add constraint qa_router_configs_message_blocks_check
  check (public.qa_router_valid_blocks(message_blocks));

-- ── 일정·참고 줄 ───────────────────────────────────────────────────────────
/*
  **먼저 9인자 판을 지운다.** `create or replace` 는 인자가 늘면 교체가
  아니라 새 함수를 만든다. 기본값이 있어도 두 판 다 맞아 호출이
  `function is not unique` 로 터진다 — 같은 함정을 이 파일에서 두 번째로
  밟았다(첫 번째는 8→9인자).
*/
drop function if exists public.qa_router_detail_lines(
  uuid, text, date, text, date, date, text, text, text);

/*
  설정이 고른 항목만, 고른 순서대로 낸다.

  `with ordinality` 로 배열 순서를 끌고 와 그대로 정렬한다 — 사람이 화면에서
  끌어 놓은 순서가 메시지 순서와 같아야 한다.
*/
create or replace function public.qa_router_detail_lines(
  p_config_id uuid, p_fix_version text, p_deploy_ymd date,
  p_deploy_title text, p_qa_end date, p_prod date,
  p_thread_ts text, p_page_id text,
  p_qa_channel text default null,
  -- 기본값은 지금 동작 그대로다. 안 넘기면 네 줄이 다 나간다.
  p_blocks jsonb default '{"schedule":["qaEnd","prod"],"refs":["detail","thread","deployPage","fixVersion"]}'::jsonb
)
returns text
language sql
stable
set search_path = ''
as $$
  with sched as (
    select string_agg(line, E'\n' order by ord) as block
      from (
        select k.ordinality as ord,
          case k.value
            when 'qaEnd' then
              case when p_qa_end is not null then
                '• QA 종료일 : ' || to_char(p_qa_end, 'MM-DD')
                || '(' || (array['일','월','화','수','목','금','토'])[
                     extract(dow from p_qa_end)::int + 1] || ')' end
            when 'prod' then
              case when p_prod is not null then
                '• 운영 배포일 : ' || to_char(p_prod, 'MM-DD')
                || '(' || (array['일','월','화','수','목','금','토'])[
                     extract(dow from p_prod)::int + 1] || ')' end
          end as line
        from jsonb_array_elements_text(
               coalesce(p_blocks->'schedule', '[]'::jsonb)) with ordinality k
      ) t
     where line is not null
  ),
  refs as (
    select string_agg(line, E'\n' order by ord) as block
      from (
        select k.ordinality as ord,
          case k.value
            when 'detail' then
              case when p_deploy_ymd is not null then
                -- 값은 "거기서 무엇을 보나". 차수 제목은 머리글이 이미 말했다.
                format('• QA 라우터 상세 : <%s/admin/qa-router/%s/cycles/%s|판정 기록 · 기획티켓 진행>',
                       public.qa_router_admin_base(), p_config_id, p_deploy_ymd) end
            when 'thread' then
              case when p_thread_ts is not null and p_qa_channel is not null then
                format(
                  '• QA 스레드 : <https://ignite0830.slack.com/archives/%s/p%s|%s 정기배포 QA>',
                  p_qa_channel, replace(p_thread_ts, '.', ''),
                  to_char(p_prod, 'MM/DD')) end
            when 'deployPage' then
              case when p_page_id is not null then
                format(
                  '• 배포대장 : <https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s|%s>',
                  p_page_id,
                  public.qa_router_esc(coalesce(p_deploy_title, '문서 열기'))) end
            when 'fixVersion' then
              case when p_fix_version is not null then
                format('• fixVersion : `%s`', p_fix_version) end
          end as line
        from jsonb_array_elements_text(
               coalesce(p_blocks->'refs', '[]'::jsonb)) with ordinality k
      ) t
     where line is not null
  )
  select nullif(concat_ws(E'\n',
    case when sched.block is not null then '*일정*' || E'\n' || sched.block end,
    case when refs.block is not null then '*참고*' || E'\n' || refs.block end
  ), '')
  from sched, refs;
$$;
