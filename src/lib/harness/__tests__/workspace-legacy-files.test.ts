import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLegacyFiles, LEGACY_FILE_PROGRAM } from '../workspace-legacy-files';
let root: string;
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'legacy-file-test-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function setup() {
  const run = jest.fn(async (input: { args: string[]; signal?: AbortSignal }) => {
    input.signal?.throwIfAborted();
    const program = LEGACY_FILE_PROGRAM.replaceAll('/vercel/sandbox/', root + '/source/').replaceAll('/tmp/', root + '/');
    const payload = JSON.parse(input.args.slice(4).join(''));
    payload.path = payload.path.replace('/tmp/', root + '/');
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', program, JSON.stringify(payload)], { encoding: 'utf8', timeout: 5000 });
    return { exitCode: result.status, stdout: async () => result.stdout };
  });
  return { run, files: createLegacyFiles(run) };
}
it('preserves binary data and both SDK/Node read contracts under the guarded user', async () => {
  const { files } = setup(); const path = '/tmp/visual-probe.js'; const content = Buffer.from([0, 255, 1, 2]);
  await files.writeFiles([{ path, content }]);
  expect(await files.readFileToBuffer({ path })).toEqual(content);
  expect(await files.fs.readFile(path)).toEqual(content);
  const stream = await files.readFile({ path }); let collected = Buffer.alloc(0);
  for await (const value of stream!) collected = Buffer.concat([collected, value]);
  expect(collected).toEqual(content);
  await files.fs.rm(path); expect(await files.readFileToBuffer({ path })).toBeNull();
  await expect(files.fs.readFile(path)).rejects.toThrow();
  await expect(files.fs.rm(path, { force: true })).resolves.toBeUndefined();
});
it.each(['/tmp/../etc/passwd', '/tmp/unrelated', '/etc/passwd', '/tmp/makinari-probe-x/child', '/tmp/visual-probe-captures/../secret'])('rejects unsafe or non-helper path %s', async path => {
  await expect(setup().files.writeFiles([{ path, content: Buffer.from('no') }])).rejects.toThrow();
});
it('rejects symlink and hardlink targets without changing their content', async () => {
  const source = join(root, 'source-file'); writeFileSync(source, 'private');
  symlinkSync(source, join(root, 'visual-probe.js'));
  const { files } = setup();
  await expect(files.fs.readFile('/tmp/visual-probe.js')).rejects.toThrow();
  await expect(files.writeFiles([{ path: '/tmp/visual-probe.js', content: Buffer.from('changed') }])).rejects.toThrow();
  linkSync(source, join(root, 'makinari-probe-test.out'));
  await expect(files.fs.readFile('/tmp/makinari-probe-test.out')).rejects.toThrow();
});
it('bounds file sizes, rejects recursive deletion, and checks cancellation before dispatch', async () => {
  const { files, run } = setup();
  await expect(files.writeFiles([{ path: '/tmp/visual-probe.js', content: Buffer.alloc(262145) }])).rejects.toThrow();
  await expect(files.fs.rm('/tmp/visual-probe-captures', { recursive: true, force: true })).rejects.toThrow();
  await expect(files.fs.readFile('/tmp/visual-probe.js', { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  writeFileSync(join(root, 'visual-probe.js'), Buffer.alloc(262145));
  await expect(files.fs.readFile('/tmp/visual-probe.js')).rejects.toThrow();
});