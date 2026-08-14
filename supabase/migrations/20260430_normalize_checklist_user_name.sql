-- deploy_room_checklist_user_status.user_name 정규화
-- '홍길동' / '홍길동/책임' 같은 표기 차이로 같은 사용자에 대해 row가 둘 이상 적재된 경우를 정리한다.
-- 정책: (session_id, checklist_item_id, normalized_name) 기준 가장 최신 updated_at row만 남기고 나머지 삭제.
-- 정규화 후 user_name은 항상 정규화된 형태로 저장된다.
-- 멱등성: 정규화 후 동일 데이터에 대해 재실행해도 결과 동일.

-- 1) "/" 앞부분만 취하고 trim — utils.ts의 normalizeName과 동일 정의
--    (현재 데이터에는 영문이 거의 없어 lower()는 생략. 필요 시 lower(...)로 확장)
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
