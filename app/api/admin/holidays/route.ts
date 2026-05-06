import { NextResponse } from 'next/server';
import { listHolidays, createHoliday, HOLIDAY_TYPES } from '@/lib/services/holiday/holiday.service';

export async function GET() {
  try {
    const items = await listHolidays();
    return NextResponse.json({ success: true, items });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { date, name, type } = body;

    if (!date) {
      return NextResponse.json({ success: false, error: 'date는 필수입니다' }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ success: false, error: 'name은 필수입니다' }, { status: 400 });
    }
    if (!HOLIDAY_TYPES.includes(type)) {
      return NextResponse.json(
        { success: false, error: `type은 ${HOLIDAY_TYPES.join(', ')} 중 하나여야 합니다` },
        { status: 400 }
      );
    }

    const item = await createHoliday({ date, name, type });
    return NextResponse.json({ success: true, item }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
