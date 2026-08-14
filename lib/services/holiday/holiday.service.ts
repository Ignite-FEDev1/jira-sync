import { dbServer } from '@/lib/db';

export type HolidayType = 'holiday' | 'vacation' | 'event';

export const HOLIDAY_TYPES: readonly HolidayType[] = ['holiday', 'vacation', 'event'] as const;

export interface Holiday {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  type: HolidayType;
  createdAt: string;
}

type HolidayRow = {
  id: string;
  date: string;
  name: string;
  type: HolidayType;
  created_at: string;
};

function toHoliday(row: HolidayRow): Holiday {
  return {
    id: row.id,
    date: row.date,
    name: row.name,
    type: row.type,
    createdAt: row.created_at,
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(date: string) {
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`날짜 형식이 올바르지 않습니다: ${date} (YYYY-MM-DD)`);
  }
}

function assertType(type: string): asserts type is HolidayType {
  if (!HOLIDAY_TYPES.includes(type as HolidayType)) {
    throw new Error(`type은 ${HOLIDAY_TYPES.join(', ')} 중 하나여야 합니다: ${type}`);
  }
}

export async function listHolidays(): Promise<Holiday[]> {
  const { data, error } = await dbServer
    .from('holidays')
    .select('*')
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new Error(`휴일/휴가 목록 조회 실패: ${error.message}`);
  return (data as HolidayRow[]).map(toHoliday);
}

export interface CreateHolidayInput {
  date: string;
  name: string;
  type: HolidayType;
}

export async function createHoliday(input: CreateHolidayInput): Promise<Holiday> {
  assertDate(input.date);
  assertType(input.type);
  const name = input.name?.trim();
  if (!name) throw new Error('이름은 필수입니다');

  const { data, error } = await dbServer
    .from('holidays')
    .insert({ date: input.date, name, type: input.type })
    .select()
    .single();

  if (error || !data) throw new Error(`휴일/휴가 등록 실패: ${error?.message ?? 'unknown'}`);
  return toHoliday(data as HolidayRow);
}

export async function deleteHoliday(id: string): Promise<void> {
  if (!id) throw new Error('id는 필수입니다');
  const { error } = await dbServer.from('holidays').delete().eq('id', id);
  if (error) throw new Error(`휴일/휴가 삭제 실패: ${error.message}`);
}
