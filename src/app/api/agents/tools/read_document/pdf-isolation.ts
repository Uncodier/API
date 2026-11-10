import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { release } from 'node:os';
import type { DocumentImage } from './types';

export type PdfImageOutput = { images: DocumentImage[]; warnings: string[]; truncated: boolean };
const MAX_INPUT = 20 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024 + 64 * 1024;
// RLIMIT_DATA includes anonymous mmap allocations on Linux >= 4.7 (including
// ArrayBuffer backing stores). V8 heap limits alone do NOT bound those buffers.
export const PDF_LIMIT_SCRIPT = 'ulimit -c 0 && ulimit -d 393216 && ulimit -t 8 && exec "$@"';
let active = false;

/** Never execute untrusted image decoders in the API process. Fail closed. */
export async function isolatedPdfImages(buffer: Buffer, pages: number[]): Promise<PdfImageOutput> {
  if (process.platform !== 'linux') throw new Error('PDF image isolation requires Linux resource limits.');
  const [major, minor] = release().split('.').map(Number);
  if (!(major > 4 || (major === 4 && minor >= 7))) throw new Error('PDF image isolation requires Linux 4.7 or later.');
  if (buffer.length > MAX_INPUT) throw new Error('PDF exceeds the 20 MB limit.');
  if (!pages.length || pages.length > 100 || pages.some(page => !Number.isSafeInteger(page) || page < 1)) throw new Error('Invalid PDF image pages.');
  if (active) throw new Error('PDF image decoder is busy; retry later.');
  active = true;
  try {
    return await new Promise<PdfImageOutput>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', PDF_LIMIT_SCRIPT, 'pdf-decoder', process.execPath,
        '--jitless', '--max-old-space-size=128',
        join(process.cwd(), 'src/app/api/agents/tools/read_document/pdf-decoder.cjs'), JSON.stringify(pages)], {
        // Do not inherit credentials, NODE_OPTIONS, loaders, or customer input in shell code.
        env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      const stop = (message: string) => {
        failure ||= new Error(message);
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => stop('PDF image decoding exceeded the 10 second limit.'), 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) { stop('PDF image decoder exceeded the output limit.'); return; }
        if (!failure) chunks.push(chunk);
      });
      child.stdin.on('error', () => stop('PDF image decoder input failed.'));
      child.on('error', () => { failure ||= new Error('PDF image decoder could not start.'); });
      // Wait for close (not just kill/exit) before releasing the concurrency slot.
      child.on('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) { reject(failure || new Error('PDF image decoder stopped at a resource limit or failed.')); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PdfImageOutput;
          if (!Array.isArray(result.images) || result.images.length > 5 || !Array.isArray(result.warnings) ||
              result.warnings.some(w => typeof w !== 'string') || typeof result.truncated !== 'boolean') throw new Error();
          let size = 0;
          for (const image of result.images) {
            if (!pages.includes(image.page) || image.mime_type !== 'image/png' || typeof image.data_url !== 'string' ||
                !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.data_url)) throw new Error();
            size += image.data_url.length;
          }
          if (size > 8 * 1024 * 1024) throw new Error();
          resolve(result);
        } catch { reject(new Error('PDF image decoder returned invalid output.')); }
      });
      child.stdin.end(buffer);
    });
  } finally { active = false; }
}