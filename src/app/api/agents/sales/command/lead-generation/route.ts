import { NextRequest } from 'next/server';
import { POST as LeadGenerationHandler } from '../../leadGeneration/route';

/**
 * Standardized handler for lead generation following the /api/agents/{agent_type}/command/{command_name} pattern.
 * This simply redirects to the main lead generation implementation.
 */
export async function POST(request: NextRequest) {
  // Pass the request to the main implementation
  return LeadGenerationHandler(request);
} 