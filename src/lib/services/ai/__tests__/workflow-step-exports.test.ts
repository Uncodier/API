import { execFileSync } from 'node:child_process';

it('compiles WhatsApp step exports with the actual step-mode compiler without executing services', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { build } from 'esbuild';
    import { createSwcPlugin } from '@workflow/builders';
    const result = await build({
      entryPoints: ['./src/app/api/agents/gear/whatsapp/steps.ts'],
      bundle: false, write: false, platform: 'node', format: 'esm', target: 'es2022',
      tsconfig: './tsconfig.json', logLevel: 'silent',
      plugins: [createSwcPlugin({ mode: 'step', projectRoot: process.cwd() })],
    });
    console.log(result.outputFiles[0].text);
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  expect(output).toContain('processUnregisteredUserStep');
}, 35000);