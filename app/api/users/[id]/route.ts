import { NextRequest, NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const row = {
    name: body.name,
    team_id: body.teamId || null,
    ignite_account_id: body.igniteAccountId ?? '',
    ignite_jira_email: body.igniteJiraEmail ?? '',
    ignite_jira_api_token: body.igniteJiraApiToken ?? '',
    hmg_account_id: body.hmgAccountId ?? '',
    hmg_jira_email: body.hmgJiraEmail ?? '',
    hmg_jira_api_token: body.hmgJiraApiToken ?? '',
    hmg_user_id: body.hmgUserId ?? '',
    h_chat_api_key: body.hChatApiKey ?? '',
    gitlab_token: body.gitlabToken ?? '',
  };

  const { data, error } = await dbServer
    .from('users')
    .update(row)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { error } = await dbServer.from('users').delete().eq('id', id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
