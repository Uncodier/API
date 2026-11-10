import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { release } from 'node:os';
import { isolatedPdfImages, PDF_LIMIT_SCRIPT } from '../pdf-isolation';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('node:os', () => ({ release: jest.fn(() => '6.1.0') }));

describe('OS-limited PDF subprocess', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let child: any;
  const output = { images: [], warnings: [], truncated: false };
  beforeEach(() => {
    jest.useFakeTimers();
    (release as jest.Mock).mockReturnValue('6.1.0');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: jest.fn() }),
      stdout: new EventEmitter(), kill: jest.fn(),
    });
    (spawn as jest.Mock).mockReturnValue(child);
  });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); jest.useRealTimers(); jest.clearAllMocks(); });
  const close = (value = output) => { child.stdout.emit('data', Buffer.from(JSON.stringify(value))); child.emit('close', 0); };

  it('applies data/CPU/core limits before exec, does not inherit secrets, and sends bytes only via stdin', async () => {
    const buffer = Buffer.from('untrusted PDF');
    const pending = isolatedPdfImages(buffer, [1]);
    const [shell, args, config] = (spawn as jest.Mock).mock.calls[0];
    expect(shell).toBe('/bin/sh');
    expect(args[1]).toBe(PDF_LIMIT_SCRIPT);
    expect(args[1]).toContain('ulimit -d 393216 && ulimit -t 8 && exec');
    expect(args).toContain('--jitless');
    expect(args).not.toContain(buffer.toString());
    expect(config.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' });
    expect(child.stdin.end).toHaveBeenCalledWith(buffer);
    close();
    await expect(pending).resolves.toEqual(output);
  });

  it('kills timed out children and retains the single slot until close', async () => {
    const pending = isolatedPdfImages(Buffer.from('pdf'), [1]);
    const check = expect(pending).rejects.toThrow(/10 second/);
    jest.advanceTimersByTime(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(isolatedPdfImages(Buffer.from('pdf'), [1])).rejects.toThrow(/busy/);
    child.emit('close', null);
    await check;
    const next = isolatedPdfImages(Buffer.from('pdf'), [1]);
    close();
    await expect(next).resolves.toEqual(output);
  });

  it('kills excessive output instead of buffering it', async () => {
    const pending = isolatedPdfImages(Buffer.from('pdf'), [1]);
    const check = expect(pending).rejects.toThrow(/output limit/);
    child.stdout.emit('data', Buffer.alloc(9 * 1024 * 1024));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);
    await check;
  });

  it('rejects terminated or malformed child output', async () => {
    const pending = isolatedPdfImages(Buffer.from('pdf'), [1]);
    child.emit('close', 137);
    await expect(pending).rejects.toThrow(/resource limit/);
    const next = isolatedPdfImages(Buffer.from('pdf'), [1]);
    child.stdout.emit('data', Buffer.from('{}'));
    child.emit('close', 0);
    await expect(next).rejects.toThrow(/invalid output/);
  });

  it.each(['spawn', 'stdin'])('releases its slot after %s errors and close', async source => {
    const pending = isolatedPdfImages(Buffer.from('pdf'), [1]);
    const checked = expect(pending).rejects.toThrow(/could not start|input failed/);
    if (source === 'spawn') child.emit('error', new Error('ENOENT'));
    else child.stdin.emit('error', new Error('EPIPE'));
    child.emit('close', -1);
    await checked;
    const next = isolatedPdfImages(Buffer.from('pdf'), [1]);
    close();
    await expect(next).resolves.toEqual(output);
  });

  it('discards valid-looking output if the decoder then exits unsuccessfully', async () => {
    const pending = isolatedPdfImages(Buffer.from('pdf'), [1]);
    child.stdout.emit('data', Buffer.from(JSON.stringify(output)));
    child.emit('close', 1);
    await expect(pending).rejects.toThrow(/resource limit/);
  });

  it('fails closed on unsupported platforms without spawning', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await expect(isolatedPdfImages(Buffer.from('pdf'), [1])).rejects.toThrow(/Linux/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects kernels where data limits do not cover mmap backing stores', async () => {
    (release as jest.Mock).mockReturnValue('4.6.0');
    await expect(isolatedPdfImages(Buffer.from('pdf'), [1])).rejects.toThrow(/4.7/);
    expect(spawn).not.toHaveBeenCalled();
  });
});