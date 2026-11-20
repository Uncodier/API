import { POST as assistantRequest } from '../route';
import type { NextRequest } from 'next/server';

// Dedicated path: deploying a newer web client against an older API must not
// silently deliver a request that the old API interprets as unscoped.
export const maxDuration = 800;
export async function POST(request: NextRequest) {
  return assistantRequest(request);
}
