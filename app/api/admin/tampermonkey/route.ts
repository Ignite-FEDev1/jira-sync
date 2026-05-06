import { NextResponse } from 'next/server';
import { listScripts, createScript } from '@/lib/services/tampermonkey/script.service';

export async function GET() {
  try {
    const scripts = await listScripts();
    return NextResponse.json({ success: true, scripts });
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
    const { id, name, description, code } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: 'id는 필수입니다' }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ success: false, error: 'name은 필수입니다' }, { status: 400 });
    }
    if (!code) {
      return NextResponse.json({ success: false, error: 'code는 필수입니다' }, { status: 400 });
    }

    const script = await createScript({ id, name, description, code });
    return NextResponse.json({ success: true, script }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
