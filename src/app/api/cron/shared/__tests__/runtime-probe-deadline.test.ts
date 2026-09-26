import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Sandbox } from '@vercel/sandbox';
import { spawnSync } from 'node:child_process';
import { runRuntimeProbe, stopProbeServer } from '../step-runtime-probe';

jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));

type Options = { cmd: string; args: string[]; detached?: boolean; timeoutMs: number; signal: AbortSignal };
const never = () => new Promise<never>(() => {});
const body = Buffer.from('hello').toString('base64');
const evidence = `READY=1\nPAGE|/|200|0.025|text/html|${body}\nDONE\n`;

function fixture() {
  const command = {
    wait: jest.fn(async (_opts: { signal: AbortSignal }) => ({ exitCode: 0 })),
    kill: jest.fn(async (_signal: string, _opts: { abortSignal: AbortSignal }) => {}),
  };
  const readFile = jest.fn(async (path: string, _opts: { encoding: string; signal: AbortSignal }) => path.endsWith('.log') ? 'ready' : evidence);
  const writeFiles = jest.fn(async (_files: unknown, _opts: { signal: AbortSignal }) => {});
  const stdout = jest.fn(async (_opts: { signal: AbortSignal }) => 'KILLED');
  const runCommand = jest.fn(async (opts: Options) => opts.detached ? command : { exitCode: 0, stdout });
  const sandbox = { runCommand, fs: { readFile }, writeFiles } as unknown as Sandbox;
  return { sandbox, runCommand, command, readFile, writeFiles, stdout };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('bounded runtime probes', () => {
  it('uses VM deadline plus curl connect/request limits and decodes complete evidence', async () => {
    const f = fixture();
    f.readFile.mockImplementation(async (path) => path.endsWith('.log') ? '' : evidence.replace('DONE', `API|/api/items|POST|201|0.05|application/json|${body}\nDONE`));
    const result = await runRuntimeProbe({ sandbox: f.sandbox, totalTimeoutMs: 1000, apiRoutes: [{ path: '/api/items', method: 'POST', payload: { name: 'item' } }] });
    expect(result.ok).toBe(true);
    expect(result.pages[0]).toMatchObject({ http_status: 200, ttfb_ms: 25, content_type: 'text/html', body_snippet: 'hello' });
    expect(result.apis[0]).toMatchObject({ http_status: 201, response_time_ms: 50, payload_source: 'inferred', body_snippet: 'hello' });
    const exec = f.runCommand.mock.calls.find(([opts]) => opts.detached)![0];
    expect(exec.timeoutMs).toBe(1000);
    expect(exec.signal).toBeInstanceOf(AbortSignal);
    const curls = exec.args[1].split('\n').filter((line) => line.includes('$(curl'));
    expect(curls).toHaveLength(3);
    for (const curl of curls) expect(curl).toContain('--connect-timeout 2 --max-time 5');
    expect(exec.args[1]).toContain('setsid timeout -k 1 300 node node_modules/next/dist/bin/next');
    expect(exec.args[1]).toContain('trap cleanup EXIT');
    expect(exec.args[1]).not.toContain('npx --yes');
    expect(spawnSync('/bin/sh', ['-n'], { input: exec.args[1], encoding: 'utf8' }).status).toBe(0);
    expect(f.writeFiles.mock.calls[0][1].signal).toBe(exec.signal);
    expect(f.readFile.mock.calls[0][1].signal).toBe(exec.signal);
    expect(f.runCommand.mock.calls.at(-1)![0].args[1]).toContain('kill -KILL -"$PID"');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels a hung command wait and explicitly kills it even with keepServerAlive', async () => {
    const f = fixture();
    f.command.wait.mockImplementation(never);
    const pending = runRuntimeProbe({ sandbox: f.sandbox, totalTimeoutMs: 100, keepServerAlive: true });
    await jest.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.startup_error).toContain('deadline exceeded');
    expect(f.command.wait.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.command.kill).toHaveBeenCalledWith('SIGKILL', { abortSignal: expect.any(AbortSignal) });
    expect(f.runCommand.mock.calls.at(-1)![0].signal.aborted).toBe(false);
    expect(f.runCommand.mock.calls.at(-1)![0].args[1]).toContain('kill -KILL -"$PID"');
    expect(f.readFile).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds a transport that never returns its command handle', async () => {
    const f = fixture();
    f.runCommand.mockImplementation(async (opts) => opts.detached ? never() : { exitCode: 0, stdout: f.stdout });
    const pending = runRuntimeProbe({ sandbox: f.sandbox, totalTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(100);
    expect((await pending).ok).toBe(false);
    expect(f.runCommand.mock.calls[0][0].timeoutMs).toBe(100);
    expect(f.runCommand.mock.calls.at(-1)![0].args[1]).toContain('kill -KILL -"$PID"');
  });

  it('counts payload writes inside the same deadline and does not start a server afterwards', async () => {
    const f = fixture();
    f.writeFiles.mockImplementation(never);
    const pending = runRuntimeProbe({ sandbox: f.sandbox, totalTimeoutMs: 100, apiRoutes: [{ path: '/api/item', payload: { x: 1 } }] });
    await jest.advanceTimersByTimeAsync(100);
    expect((await pending).ok).toBe(false);
    expect(f.writeFiles.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.runCommand.mock.calls.every(([opts]) => !opts.detached)).toBe(true);
  });

  it('does not silently probe with a missing payload after write failure', async () => {
    const f = fixture();
    f.writeFiles.mockRejectedValue(new Error('payload write failed'));
    const result = await runRuntimeProbe({ sandbox: f.sandbox, apiRoutes: [{ path: '/api/item', payload: { x: 1 } }] });
    expect(result.startup_error).toContain('payload write failed');
    expect(f.runCommand.mock.calls.every(([opts]) => !opts.detached)).toBe(true);
  });

  it('bounds evidence reads and tears down an otherwise successful retained server', async () => {
    const f = fixture();
    f.readFile.mockImplementation(never);
    const pending = runRuntimeProbe({ sandbox: f.sandbox, totalTimeoutMs: 100, keepServerAlive: true });
    await jest.advanceTimersByTimeAsync(100);
    expect((await pending).ok).toBe(false);
    expect(f.readFile.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.runCommand.mock.calls.at(-1)![0].args[1]).toContain('kill -KILL -"$PID"');
  });

  it('honors caller cancellation and still uses a fresh bounded cleanup signal', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.command.wait.mockImplementation(never);
    const pending = runRuntimeProbe({ sandbox: f.sandbox, signal: controller.signal });
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('cycle cancelled'));
    const result = await pending;
    expect(result.startup_error).toBe('cycle cancelled');
    expect(f.command.kill.mock.calls[0][1].abortSignal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds cleanup itself if kill and cleanup transport both hang', async () => {
    const f = fixture();
    f.command.wait.mockImplementation(never);
    f.command.kill.mockImplementation(never);
    f.runCommand.mockImplementation(async (opts) => opts.detached ? f.command : never());
    const pending = runRuntimeProbe({ sandbox: f.sandbox, totalTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(5100);
    expect((await pending).duration_ms).toBe(5100);
    expect(f.command.kill.mock.calls[0][1].abortSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps only successful servers alive for visual reuse, then stop is bounded', async () => {
    const f = fixture();
    expect((await runRuntimeProbe({ sandbox: f.sandbox, keepServerAlive: true })).ok).toBe(true);
    expect(f.runCommand.mock.calls.at(-1)![0].args[1]).not.toContain('kill -KILL');
    expect(await stopProbeServer(f.sandbox, 3000)).toEqual({ killed: true });
    expect(f.runCommand.mock.calls.at(-1)![0].timeoutMs).toBe(4500);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stopProbeServer returns in 5s even when stdout never resolves', async () => {
    const f = fixture();
    f.stdout.mockImplementation(never);
    const pending = stopProbeServer(f.sandbox, 3000);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ killed: false });
    expect(f.stdout.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it.each([
    ['READY=1\n', 'collecting all route evidence'],
    [evidence.replace('READY=1', 'READY=0'), 'did not respond'],
  ])('fails closed on incomplete probe output', async (raw, error) => {
    const f = fixture();
    f.readFile.mockImplementation(async (path) => path.endsWith('.log') ? '' : raw);
    const result = await runRuntimeProbe({ sandbox: f.sandbox, keepServerAlive: true });
    expect(result.ok).toBe(false);
    expect(result.startup_error).toContain(error);
    expect(f.runCommand.mock.calls.at(-1)![0].args[1]).toContain('kill -KILL');
  });

  it('fails closed on nonzero command exit even with a seemingly valid result file', async () => {
    const f = fixture();
    f.command.wait.mockResolvedValue({ exitCode: 137 });
    const result = await runRuntimeProbe({ sandbox: f.sandbox, keepServerAlive: true });
    expect(result.ok).toBe(false);
    expect(result.startup_error).toContain('137');
  });

});