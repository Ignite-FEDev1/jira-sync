import { NextRequest, NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';

export async function GET(request: NextRequest) {
  const teamId = request.nextUrl.searchParams.get('teamId');

  if (!teamId) {
    return NextResponse.json({ success: false, error: 'teamId is required' }, { status: 400 });
  }

  const [usersResult, teamResult, tokenResult] = await Promise.all([
    dbServer.from('users').select('id, name').eq('team_id', teamId).order('name'),
    dbServer.from('teams').select('leader_id').eq('id', teamId).single(),
    dbServer.from('users').select('gitlab_token').neq('gitlab_token', '').limit(1),
  ]);

  const members = usersResult.data?.map((u: { id: string; name: string }) => ({
    id: u.id,
    name: u.name,
  })) ?? [];

  const leaderId = teamResult.data?.leader_id ?? null;
  const gitlabToken = tokenResult.data?.[0]?.gitlab_token ?? '';

  return NextResponse.json({
    success: true,
    members,
    leaderId,
    gitlabToken,
  });
}
