import { NextResponse } from 'next/server';
import {
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from '@/lib/services/deploy-room/template.service';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const template = await getTemplateById(id);
    if (!template) {
      return NextResponse.json({ success: false, error: '템플릿을 찾을 수 없습니다' }, { status: 404 });
    }
    return NextResponse.json({ success: true, template });
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
    const { name, project, deployType, gitlabProjects, teamMembers, checklist, isActive } = body;

    const template = await updateTemplate(id, {
      name,
      project,
      deployType,
      gitlabProjects,
      teamMembers,
      checklist,
      isActive,
    });

    return NextResponse.json({ success: true, template });
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
    await deleteTemplate(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
