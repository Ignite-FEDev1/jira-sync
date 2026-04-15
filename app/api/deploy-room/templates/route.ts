import { NextResponse } from 'next/server';
import { listTemplates } from '@/lib/services/deploy-room/template.service';

export async function GET() {
  try {
    const templates = await listTemplates(true);
    return NextResponse.json({ success: true, templates });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
