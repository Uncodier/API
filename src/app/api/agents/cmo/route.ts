import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.redirect(new URL('/REST%20API/agents/cmo/message', 'https://uncodie.com'));
} 