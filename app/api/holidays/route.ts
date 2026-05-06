import { NextResponse } from 'next/server';
import { listHolidays } from '@/lib/services/holiday/holiday.service';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const all = await listHolidays();
    const pick = (type: 'holiday' | 'vacation' | 'event') =>
      all.filter((h) => h.type === type).map(({ id, date, name }) => ({ id, date, name }));

    return NextResponse.json(
      {
        success: true,
        holidays: pick('holiday'),
        vacations: pick('vacation'),
        events: pick('event'),
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
