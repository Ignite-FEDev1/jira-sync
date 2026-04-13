import { NextRequest, NextResponse } from 'next/server';
import { toggleChecklistItem } from '@/lib/services/deploy-room/checklist.service';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const { itemId } = await params;
    const body = (await request.json()) as {
      checked: boolean;
      actorUserId?: string;
    };

    if (typeof body.checked !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'checked(boolean)은 필수입니다' },
        { status: 400 }
      );
    }

    const item = await toggleChecklistItem({
      itemId,
      checked: body.checked,
      actorUserId: body.actorUserId,
    });

    return NextResponse.json({ success: true, item });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
