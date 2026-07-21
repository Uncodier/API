'use workflow';

import { generateAndCacheImageStep } from './steps';

export interface GeneratePromptImageInput {
  prompt: string;
  siteId: string;
  size: '256x256' | '512x512' | '1024x1024';
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | undefined;
  hash: string;
}

export async function generatePromptImageWorkflow(input: GeneratePromptImageInput) {
  'use workflow';
  
  await generateAndCacheImageStep(
    input.prompt,
    input.siteId,
    input.size,
    input.ratio,
    input.hash
  );
  
  return { status: 'completed' };
}
