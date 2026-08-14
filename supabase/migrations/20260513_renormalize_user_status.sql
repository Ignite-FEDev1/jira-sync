-- 운영 DB에 정규화 안 된 row가 잔존하는 문제 정리 (20260430 마이그레이션 재실행).
-- "홍길동/FE1/이그나이트" 같은 raw row가 "홍길동" row와 공존하면서
-- namesMatch + 최신 updatedAt 로직에서 raw row가 화면 표시를 가로채는 버그 수정.
-- 정책: (session_id, checklist_item_id, normalized_name) 기준 가장 최신 row만 남기고 나머지 삭제.

-- 1) 중복 row 제거 — 같은 (session, item, normalized_user)에 대해 가장 최신 updated_at만 유지
with ranked as (
  select
    id,
    btrim(split_part(user_name, '/', 1)) as norm_name,
    row_number() over (
      partition by session_id, checklist_item_id, btrim(split_part(user_name, '/', 1))
      order by updated_at desc, id desc
    ) as rn
  from public.deploy_room_checklist_user_status
)
delete from public.deploy_room_checklist_user_status
where id in (select id from ranked where rn > 1);

-- 2) 남은 row의 user_name을 정규화된 형태로 갱신
update public.deploy_room_checklist_user_status
set user_name = btrim(split_part(user_name, '/', 1))
where user_name <> btrim(split_part(user_name, '/', 1));

-- 3) 향후 같은 사고 방지를 위한 트리거: insert/update 시 user_name을 자동 정규화
create or replace function public.normalize_deploy_room_user_status_name()
returns trigger as $$
begin
  new.user_name = btrim(split_part(new.user_name, '/', 1));
  return new;
end;
$$ language plpgsql;

drop trigger if exists tr_normalize_deploy_room_user_status_name
  on public.deploy_room_checklist_user_status;

create trigger tr_normalize_deploy_room_user_status_name
before insert or update on public.deploy_room_checklist_user_status
for each row execute function public.normalize_deploy_room_user_status_name();
