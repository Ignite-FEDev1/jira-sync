import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import {
  getScript,
  updateScript,
  deleteScript,
} from '@/lib/services/tampermonkey/script.service';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const script = await getScript(id);
    if (!script) {
      return NextResponse.json(
        { success: false, error: '스크립트를 찾을 수 없습니다' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, script });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { name, description, code } = body;

    const script = await updateScript(id, { name, description, code });
    revalidatePath(`/api/tampermonkey/${id}/user.js`);
    return NextResponse.json({ success: true, script });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteScript(id);
    revalidatePath(`/api/tampermonkey/${id}/user.js`);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
