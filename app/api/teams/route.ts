import { NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';

export async function GET() {
  const { data, error } = await dbServer
    .from('teams')
    .select('id, name, leader_id, source_project_id, created_at')
    .order('name');

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
