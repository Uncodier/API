import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('capability-specific runtime boundary', () => {
  it.each([
    'src/app/api/ai/text/route.ts',
    'src/app/api/ai/video/route.ts',
    'src/lib/services/ai/transcribeAudio.ts',
    'src/lib/status/handlers/ai/provider-probes.ts',
  ])('does not retain direct gateway implementations or credentials in %s', file => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/from ['"]@google\/(?:genai|generative-ai)['"]/);
    expect(source).not.toMatch(/process\.env\.(?:AZURE_TTS_|GEMINI_API_KEY|VERCEL_AI_GATEWAY|OPENAI_API_KEY)/);
    expect(source).not.toMatch(/synthesizeWithAzure|generateWithAzure|generateVideoWithGemini|generateWithVercelGateway/);
  });

  it('routes speech exclusively through Azure without OpenRouter dependencies or credential redirects', () => {
    const root = process.cwd();
    const route = readFileSync(resolve(root, 'src/app/api/ai/audio/route.ts'), 'utf8');
    const service = readFileSync(resolve(root, 'src/lib/services/ai/tts-service.ts'), 'utf8');
    const config = readFileSync(resolve(root, 'src/lib/services/ai/azure-tts-config.ts'), 'utf8');
    expect(route + service + config).not.toMatch(/from ['"][^'"]*openrouter['"]|createOpenRouterClient|getOpenRouterTts|synthesizeWithOpenRouter|OPENROUTER_/);
    expect(service).toContain('getAzureTtsConfig');
    expect(service).toContain('validateSpeechOptions');
    expect(service).toMatch(/redirect:\s*['"]error['"]/);
    expect(service).not.toMatch(/redirect:\s*['"]follow['"]/);
    expect(service + config).not.toMatch(/from ['"]@google\/(?:genai|generative-ai)['"]|GEMINI_API_KEY|VERCEL_AI_GATEWAY/);
  });

  it('routes transcription exclusively through Azure without gateway dependencies', () => {
    const root = process.cwd();
    const service = readFileSync(resolve(root, 'src/lib/services/ai/transcribeAudio.ts'), 'utf8');
    const config = readFileSync(resolve(root, 'src/lib/services/ai/azure-transcription-config.ts'), 'utf8');
    expect(service + config).not.toMatch(/from ['"][^'"]*openrouter['"]|createOpenRouterClient|OPENROUTER_|GEMINI_API_KEY|PORTKEY_|VERCEL_AI_GATEWAY/);
    expect(service).toContain('getAzureTranscriptionConfig');
    expect(service).toContain("form.append('file'");
    expect(service).toMatch(/redirect:\s*['"]error['"]/);
    expect(config).not.toMatch(/env\.MICROSOFT_AZURE_OPENAI_(?:DEPLOYMENT|API_VERSION)/);
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