import { execFileSync } from 'node:child_process';

it('compiles the real durable workflow without sandbox, database or provider modules in its VM', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { build } from 'esbuild';
    import { createNodeModuleErrorPlugin, createPseudoPackagePlugin, createSwcPlugin } from '@workflow/builders';
    const result = await build({
      entryPoints: ['./src/app/api/cron/requirements-apps/workflow.ts'], absWorkingDir: process.cwd(),
      bundle: true, write: false, platform: 'neutral', format: 'cjs', target: 'es2022',
      conditions: ['workflow'], mainFields: ['module', 'main'], tsconfig: './tsconfig.json',
      treeShaking: true, metafile: true, logLevel: 'silent', plugins: [createPseudoPackagePlugin(),
        createSwcPlugin({mode:'workflow',projectRoot:process.cwd()}), createNodeModuleErrorPlugin()],
    });
    console.log(JSON.stringify({inputs:Object.keys(result.metafile.inputs),code:result.outputFiles[0].text}));
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  const result = JSON.parse(output);
  expect(result.code).toContain('executeRequirementCycle');
  for (const input of result.inputs) {
    expect(input).not.toMatch(/lib\/harness\/(?:runtime|engine|model|workspace|store)\.ts/);
    expect(input).not.toContain('database/supabase-client');
  }
  expect(result.code).not.toContain('node:crypto');
}, 35000);