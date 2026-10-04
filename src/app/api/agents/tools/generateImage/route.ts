import { NextRequest, NextResponse } from 'next/server';
import { POST as generateImage } from '@/app/api/ai/image/route';

/** Preserve the caller identity instead of escalating through SERVICE_API_KEY. */
export async function POST(request: NextRequest) {
  const response = await generateImage(request);
  const data = await response.json();
  return NextResponse.json({ ...data, success: response.ok }, { status: response.status, headers: response.headers });
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Image Generation Tool API',
    providers: ['azure'],
    default_provider: 'azure', required_fields: ['prompt', 'site_id'],
  });
}