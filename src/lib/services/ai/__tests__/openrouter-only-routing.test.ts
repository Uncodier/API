import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('capability-specific runtime boundary', () => {
  it.each([
    'src/app/api/ai/text/route.ts',
    'src/app/api/ai/video/route.ts',
    'src/app/api/ai/audio/route.ts',
    'src/lib/services/ai/tts-service.ts',
    'src/lib/services/ai/transcribeAudio.ts',
    'src/lib/status/handlers/ai/provider-probes.ts',
  ])('does not retain direct gateway implementations or credentials in %s', file => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/from ['"]@google\/(?:genai|generative-ai)['"]/);
    expect(source).not.toMatch(/process\.env\.(?:AZURE_TTS_|GEMINI_API_KEY|VERCEL_AI_GATEWAY|OPENAI_API_KEY)/);
    expect(source).not.toMatch(/synthesizeWithAzure|generateWithAzure|generateVideoWithGemini|generateWithVercelGateway/);
  });

  it('routes images exclusively through Azure without OpenRouter or Google fallback', () => {
    const root = process.cwd();
    const route = readFileSync(resolve(root, 'src/app/api/ai/image/route.ts'), 'utf8');
    const adapter = readFileSync(resolve(root, 'src/app/api/ai/image/provider-azure.ts'), 'utf8');
    const config = readFileSync(resolve(root, 'src/lib/services/image/azure-image-config.ts'), 'utf8');
    expect(route).toContain("import { generateWithAzure } from './provider-azure'");
    expect(route).toContain("const provider = body.provider ?? 'azure'");
    expect(route).toContain("if (provider !== 'azure')");
    expect(route + adapter + config).not.toMatch(/generateWithOpenRouter|openRouterMedia|OPENROUTER_API_KEY|OPENROUTER_IMAGE_/);
    expect(route + adapter + config).not.toMatch(/from ['"]@google\/(?:genai|generative-ai)['"]|generateWithGemini|generateWithVercelGateway/);
    expect(config).toContain('env.MICROSOFT_AZURE_OPENAI_API_KEY');
    expect(config).not.toContain('env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT');
  });

  it('does not use old provider selectors or deployments for history preparation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/robots/instance/assistant/steps.ts'), 'utf8');
    expect(source).not.toMatch(/process\.env\.(?:AI_MODEL|MICROSOFT_AZURE_OPENAI_DEPLOYMENT)/);
    expect(source).toContain('resolveAssistantHistoryModel');
  });
});