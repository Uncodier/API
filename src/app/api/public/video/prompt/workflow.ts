'use workflow';

import { generateAndCacheVideoStep } from './steps';
import type { ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';

export interface GeneratePromptVideoInput {
  prompt: string;
  siteId: string;
  durationSeconds: number;
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
  hash: string;
  executionRouting?: ExecutionRoutingReference;
}

export async function generatePromptVideoWorkflow(input: GeneratePromptVideoInput) {
  'use workflow';
  
  return await generateAndCacheVideoStep(
    input.prompt,
    input.siteId,
    input.durationSeconds,
    input.ratio,
    input.hash,
    input.executionRouting
  );
}