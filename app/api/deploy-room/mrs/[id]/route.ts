import { NextRequest, NextResponse } from 'next/server';
import { updateMr } from '@/lib/services/deploy-room/mr.service';
import type { DeployRoomMrStatus } from '@/lib/types/deploy-room';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      included?: boolean;
      status?: DeployRoomMrStatus;
      ownerUserId?: string | null;
      notes?: string | null;
      actorUserId?: string;
    };

    const mr = await updateMr({ id, ...body });
    return NextResponse.json({ success: true, mr });
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
