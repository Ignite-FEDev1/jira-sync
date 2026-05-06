-- 휴일/휴가 초기 데이터 시드
-- 기존 Tampermonkey 스크립트(v0.4.1)에 하드코딩되어 있던 데이터 이관
-- 같은 (date, name, type) 조합이 이미 있으면 스킵 (재실행 안전)

insert into public.holidays (date, name, type)
select v.date::date, v.name, v.type
from (values
  -- 공휴일
  ('2026-02-16', '크리스마스', 'holiday'),
  ('2026-02-17', '크리스마스', 'holiday'),
  ('2026-02-18', '크리스마스', 'holiday'),
  ('2026-05-01', '노동절', 'holiday'),
  ('2026-05-05', '어린이날', 'holiday'),
  ('2026-05-25', '부처님오신날 대체휴일', 'holiday'),
  ('2026-06-11', '전사 워크샵', 'holiday'),
  ('2026-06-12', '전사 워크샵', 'holiday'),

  -- 휴가
  ('2026-02-04', '김찬영 휴가', 'vacation'),
  ('2026-02-05', '김찬영 오전반차', 'vacation'),
  ('2026-02-09', '손현지 오후반차', 'vacation'),
  ('2026-02-19', '손현지/조한빈/서성주 휴가', 'vacation'),
  ('2026-02-20', '손현지/조한빈 휴가', 'vacation'),
  ('2026-02-27', '서성주 휴가', 'vacation'),
  ('2026-03-30', '손현지 휴가', 'vacation'),
  ('2026-04-03', '서성주 휴가', 'vacation'),
  ('2026-04-24', '서성주 휴가', 'vacation'),
  ('2026-04-27', '손현지 휴가', 'vacation'),
  ('2026-05-04', '손현지 휴가', 'vacation'),
  ('2026-05-04', '조한빈 휴가', 'vacation'),
  ('2026-05-07', '한준호 오후반차', 'vacation'),
  ('2026-05-11', '한준호 오후반차', 'vacation'),
  ('2026-05-14', '한준호 오후반차', 'vacation'),
  ('2026-05-15', '조한빈 연차', 'vacation')
) as v(date, name, type)
where not exists (
  select 1 from public.holidays h
  where h.date = v.date::date
    and h.name = v.name
    and h.type = v.type
);
