import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { deleteHoliday } from '@/lib/services/holiday/holiday.service';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteHoliday(id);
    revalidatePath('/api/holidays');
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
