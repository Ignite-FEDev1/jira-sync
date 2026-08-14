import { dbServer } from '@/lib/db';
import type { DeployRoomTemplate, DeployRoomTemplateChecklist } from '@/lib/types/deploy-room';

type TemplateRow = {
  id: string;
  name: string;
  project: string;
  deploy_type: string;
  gitlab_projects: string[];
  team_members: string[];
  checklist: DeployRoomTemplateChecklist[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function toTemplate(row: TemplateRow): DeployRoomTemplate {
  return {
    id: row.id,
    name: row.name,
    project: row.project,
    deployType: row.deploy_type,
    gitlabProjects: row.gitlab_projects ?? [],
    teamMembers: row.team_members ?? [],
    checklist: row.checklist ?? [],
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTemplates(onlyActive = false): Promise<DeployRoomTemplate[]> {
  let query = dbServer.from('deploy_room_templates').select('*').order('created_at', { ascending: true });
  if (onlyActive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new Error(`템플릿 목록 조회 실패: ${error.message}`);
  return (data as TemplateRow[]).map(toTemplate);
}

export async function getTemplateById(id: string): Promise<DeployRoomTemplate | null> {
  const { data, error } = await dbServer
    .from('deploy_room_templates')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`템플릿 조회 실패: ${error.message}`);
  return data ? toTemplate(data as TemplateRow) : null;
}

export async function getTemplateByProjectAndType(
  project: string,
  deployType: string
): Promise<DeployRoomTemplate | null> {
  const { data, error } = await dbServer
    .from('deploy_room_templates')
    .select('*')
    .eq('project', project)
    .eq('deploy_type', deployType)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`템플릿 조회 실패: ${error.message}`);
  return data ? toTemplate(data as TemplateRow) : null;
}

export interface CreateTemplateInput {
  name: string;
  project: string;
  deployType: string;
  gitlabProjects: string[];
  teamMembers: string[];
  checklist: DeployRoomTemplateChecklist[];
  isActive?: boolean;
}

export async function createTemplate(input: CreateTemplateInput): Promise<DeployRoomTemplate> {
  const { data, error } = await dbServer
    .from('deploy_room_templates')
    .insert({
      name: input.name,
      project: input.project,
      deploy_type: input.deployType,
      gitlab_projects: input.gitlabProjects,
      team_members: input.teamMembers,
      checklist: input.checklist,
      is_active: input.isActive ?? true,
    })
    .select()
    .single();

  if (error || !data) throw new Error(`템플릿 생성 실패: ${error?.message ?? 'unknown'}`);
  return toTemplate(data as TemplateRow);
}

export interface UpdateTemplateInput {
  name?: string;
  project?: string;
  deployType?: string;
  gitlabProjects?: string[];
  teamMembers?: string[];
  checklist?: DeployRoomTemplateChecklist[];
  isActive?: boolean;
}

export async function updateTemplate(
  id: string,
  input: UpdateTemplateInput
): Promise<DeployRoomTemplate> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.project !== undefined) patch.project = input.project;
  if (input.deployType !== undefined) patch.deploy_type = input.deployType;
  if (input.gitlabProjects !== undefined) patch.gitlab_projects = input.gitlabProjects;
  if (input.teamMembers !== undefined) patch.team_members = input.teamMembers;
  if (input.checklist !== undefined) patch.checklist = input.checklist;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  const { data, error } = await dbServer
    .from('deploy_room_templates')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error || !data) throw new Error(`템플릿 수정 실패: ${error?.message ?? 'unknown'}`);
  return toTemplate(data as TemplateRow);
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await dbServer.from('deploy_room_templates').delete().eq('id', id);
  if (error) throw new Error(`템플릿 삭제 실패: ${error.message}`);
}
