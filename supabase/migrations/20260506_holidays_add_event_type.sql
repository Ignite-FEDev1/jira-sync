-- 'event' type 추가 (사내 이벤트: 워크샵, 행사 등)
-- 기존 holidays 테이블의 check constraint를 확장하고
-- 이미 시드된 '전사 워크샵' 항목을 event 타입으로 이전

-- 1) check constraint 갱신
alter table public.holidays
  drop constraint if exists holidays_type_check;

alter table public.holidays
  add constraint holidays_type_check
  check (type in ('holiday', 'vacation', 'event'));

-- 2) 기존 워크샵 항목을 event로 이전 (이름에 '워크샵' 포함된 holiday만)
update public.holidays
set type = 'event'
where type = 'holiday'
  and name like '%워크샵%';
