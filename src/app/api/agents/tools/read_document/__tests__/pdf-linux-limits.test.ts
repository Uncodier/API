import { spawn } from 'node:child_process';
import { PDF_LIMIT_SCRIPT } from '../pdf-isolation';

// Must run in the deployed Linux/Node image. Mocked spawn cannot prove that
// RLIMIT_DATA constrains external (non-V8-heap) buffers on that image.
const linux = process.platform === 'linux' ? describe : describe.skip;
linux('actual Linux PDF resource limits', () => {
  function run(source: string): Promise<{ code: number | null; signal: string | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', PDF_LIMIT_SCRIPT, 'pdf-limit-test', process.execPath,
        '--jitless', '--max-old-space-size=128', '-e', source], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('OS CPU limit did not stop the process')); }, 15_000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout }); });
    });
  }

  it('can initialize Node and allocate a normal image under the data limit', async () => {
    const result = await run('const a = new Uint8Array(32 * 1024 * 1024); a.fill(1); console.log(a.length)');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('33554432');
  });

  it('denies a mask-sized excessive ArrayBuffer allocation before touching its memory', async () => {
    const result = await run('const a = new Uint8Array(1024 * 1024 * 1024); console.log("UNBOUNDED", a.length)');
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('UNBOUNDED');
  });

  it('denies aggregate buffers even when each individual image is within its pixel limit', async () => {
    const result = await run('const images = []; for (let i=0;i<50;i++) images.push(new Uint8Array(32*1024*1024)); console.log("UNBOUNDED")');
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('UNBOUNDED');
  });

  it('terminates a CPU-bound decoder even when the child event loop cannot run', async () => {
    const result = await run('while (true) {}');
    expect(result.code).not.toBe(0);
    expect(result.signal).toMatch(/SIG(XCPU|KILL)/);
  }, 20_000);
});