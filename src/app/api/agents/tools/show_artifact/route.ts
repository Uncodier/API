import { NextRequest, NextResponse } from 'next/server';
import { createInstanceArtifactCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createInstanceArtifactCore(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    console.error('Error in show_artifact tool (POST):', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message.includes('required') || error.message.includes('Invalid screen') ? 400 : 500 }
    );
  }
}
