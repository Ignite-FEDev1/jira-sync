import { NextResponse } from 'next/server';
import { getScript, buildUserScript } from '@/lib/services/tampermonkey/script.service';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function resolveBaseUrl(req: Request): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? url.host;
  return `${proto}://${host}`;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const script = await getScript(id);
    if (!script) {
      return new NextResponse(`// Script not found: ${id}`, {
        status: 404,
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', ...CORS_HEADERS },
      });
    }

    const baseUrl = resolveBaseUrl(req);
    const code = buildUserScript(script, baseUrl);

    return new NextResponse(code, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=60, s-maxage=60',
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    return new NextResponse(
      `// Error: ${error instanceof Error ? error.message : String(error)}`,
      {
        status: 500,
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', ...CORS_HEADERS },
      }
    );
  }
}
