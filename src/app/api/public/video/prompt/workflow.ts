'use workflow';

import { generateAndCacheVideoStep } from './steps';

export interface GeneratePromptVideoInput {
  prompt: string;
  siteId: string;
  durationSeconds: number;
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
  hash: string;
}

export async function generatePromptVideoWorkflow(input: GeneratePromptVideoInput) {
  'use workflow';
  
  await generateAndCacheVideoStep(
    input.prompt,
    input.siteId,
    input.durationSeconds,
    input.ratio,
    input.hash
  );
  
  return { status: 'completed' };
}