import { NextResponse } from 'next/server';
import {
  listTemplates,
  createTemplate,
} from '@/lib/services/deploy-room/template.service';

export async function GET() {
  try {
    const templates = await listTemplates();
    return NextResponse.json({ success: true, templates });
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
    const { name, project, deployType, gitlabProjects, teamMembers, checklist, isActive } = body;

    if (!name) {
      return NextResponse.json(
        { success: false, error: 'name은 필수입니다' },
        { status: 400 }
      );
    }

    const template = await createTemplate({
      name,
      project: project ?? '',
      deployType: deployType ?? '',
      gitlabProjects: gitlabProjects ?? [],
      teamMembers: teamMembers ?? [],
      checklist: checklist ?? [],
      isActive: isActive ?? true,
    });

    return NextResponse.json({ success: true, template }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
