import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../../../../../../', import.meta.url));

describe('assistant workflow build boundary', () => {
  it('compiles with the real Workflow plugins without pulling recovery services into the workflow', () => {
    // Run the native compiler outside Jest's VM. No application modules are
    // executed, no .env is loaded, and no database/provider mocks hide imports.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { build } from 'esbuild';
      import {
        createNodeModuleErrorPlugin, createPseudoPackagePlugin, createSwcPlugin,
      } from '@workflow/builders';

      const result = await build({
        entryPoints: ['./src/app/api/robots/instance/assistant/workflow.ts'],
        absWorkingDir: process.cwd(),
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'cjs',
        target: 'es2022',
        conditions: ['workflow'],
        mainFields: ['module', 'main'],
        tsconfig: './tsconfig.json',
        treeShaking: true,
        metafile: true,
        logLevel: 'silent',
        plugins: [
          createPseudoPackagePlugin(),
          createSwcPlugin({ mode: 'workflow', projectRoot: process.cwd() }),
          createNodeModuleErrorPlugin(),
        ],
      });
      console.log(JSON.stringify({
        inputs: Object.keys(result.metafile.inputs),
        code: result.outputFiles[0].text,
      }));
    `], { cwd: projectRoot, encoding: 'utf8', timeout: 30_000 });
    const { inputs, code } = JSON.parse(output) as { inputs: string[]; code: string };

    expect(inputs).toContain('src/lib/services/robot-instance/assistant-respawn-policy.ts');
    // The generated workflow must use the source image context, not a stale
    // flattened URL-list builder. No manual edits to generated route bundles.
    expect(inputs).toContain('src/lib/services/robot-instance/assistant-image-content.ts');
    expect(code).toContain('image-entity-v2');
    expect(code).toContain('current_attachment');
    for (const serverModule of [
      'src/lib/services/robot-instance/assistant-respawn.ts',
      'src/lib/services/robot-instance/assistant-recovery.ts',
      'src/lib/services/robot-instance/assistant-recovery-fingerprint.ts',
      'src/lib/database/supabase-client.ts',
    ]) {
      expect(inputs).not.toContain(serverModule);
    }
    // These calls must remain durable step references, not be removed with the
    // server implementations. Recovery and respawn behavior is still present.
    for (const step of [
      'prepareRecoveryStep', 'guardRecoveryStep', 'checkpointRecoveryStep',
      'processAssistantTurn', 'spawnSilentContinueStep',
    ]) {
      expect(code).toContain('//' + step + '");');
    }
    expect(code).not.toContain('node:crypto');
  }, 35_000);
});