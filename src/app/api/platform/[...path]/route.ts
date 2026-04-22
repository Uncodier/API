import { NextRequest, NextResponse } from 'next/server';
import { resolveHandler, wrapWithScope } from '@/lib/services/platform-api/handlers';

/**
 * Single catch-all for the Uncodie Platform API consumed by apps generated in
 * the sandbox. The dispatcher matches (METHOD + path segments) against the
 * handler table in `handlers.ts`, then wraps the handler with
 * `withPlatformScope` so auth / scope / quota / audit are uniform.
 *
 * Unknown routes return 404 — we never invent capabilities.
 */

async function dispatch(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const segments = Array.isArray(path) ? path : [];
  const entry = resolveHandler(req.method, segments);
  if (!entry) {
    return NextResponse.json(
      {
        error: `Not found: ${req.method} /api/platform/${segments.join('/')}`,
        hint: 'Register the handler in src/lib/services/platform-api/handlers.ts before calling it.',
      },
      { status: 404 },
    );
  }
  const wrapped = wrapWithScope(entry);
  return wrapped(req);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return dispatch(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return dispatch(req, ctx);
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return dispatch(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return dispatch(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return dispatch(req, ctx);
}
