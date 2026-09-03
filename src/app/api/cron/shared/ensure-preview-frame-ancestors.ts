import type { Sandbox } from '@vercel/sandbox';

export const PREVIEW_FRAME_ANCESTORS =
  "'self' http://localhost:* http://127.0.0.1:* https://*.makinari.com https://makinari.com https://www.makinari.com https://app.makinari.com https://*.uncodie.com";

const FRAME_ANCESTORS_DIRECTIVE = `frame-ancestors ${PREVIEW_FRAME_ANCESTORS}`;

type VercelHeader = { key?: string; value?: string };
type VercelHeaderRule = { source?: string; headers?: VercelHeader[] };

/** Merge frame-ancestors into vercel.json without dropping crons/builds. */
export function mergeVercelJsonHeaders(originalJson: string | null): string {
  let vercelConfig: Record<string, unknown> = {};
  if (originalJson) {
    try {
      const parsed = JSON.parse(originalJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        vercelConfig = parsed as Record<string, unknown>;
      }
    } catch {
      vercelConfig = {};
    }
  }

  const headers = Array.isArray(vercelConfig.headers)
    ? ([...vercelConfig.headers] as VercelHeaderRule[])
    : [];

  let globalHeadersRule = headers.find((h) => h && h.source === '/(.*)');
  if (!globalHeadersRule) {
    globalHeadersRule = { source: '/(.*)', headers: [] };
    headers.push(globalHeadersRule);
  }
  if (!Array.isArray(globalHeadersRule.headers)) {
    globalHeadersRule.headers = [];
  }

  globalHeadersRule.headers = globalHeadersRule.headers.filter(
    (h) => String(h?.key || '').toLowerCase() !== 'x-frame-options'
  );

  const cspHeader = globalHeadersRule.headers.find(
    (h) => String(h?.key || '').toLowerCase() === 'content-security-policy'
  );

  if (cspHeader) {
    let cspValue = String(cspHeader.value || '');
    if (/frame-ancestors/i.test(cspValue)) {
      cspValue = cspValue.replace(/frame-ancestors[^;]*/i, FRAME_ANCESTORS_DIRECTIVE);
    } else {
      cspValue = cspValue.trim();
      if (cspValue && !cspValue.endsWith(';')) cspValue += ';';
      cspValue = `${cspValue}${cspValue ? ' ' : ''}${FRAME_ANCESTORS_DIRECTIVE}`;
    }
    cspHeader.value = cspValue;
  } else {
    globalHeadersRule.headers.push({
      key: 'Content-Security-Policy',
      value: FRAME_ANCESTORS_DIRECTIVE,
    });
  }

  vercelConfig.headers = headers;
  return JSON.stringify(vercelConfig, null, 2);
}

/** Drop X-Frame-Options DENY/SAMEORIGIN from next.config source. */
export function stripXFrameOptionsFromNextConfig(source: string): string {
  return source
    .replace(
      /\{\s*key:\s*['"]X-Frame-Options['"]\s*,\s*value:\s*['"](?:DENY|SAMEORIGIN)['"]\s*\},?/gi,
      ''
    )
    .replace(/['"]X-Frame-Options['"]\s*:\s*['"](?:DENY|SAMEORIGIN)['"],?/gi, '');
}

async function readSandboxFile(sandbox: Sandbox, absPath: string): Promise<string | null> {
  const readRes = await sandbox.runCommand('sh', ['-c', `cat "${absPath}" 2>/dev/null || true`]);
  const stdout = (await readRes.stdout()).trim();
  return stdout.length > 0 ? stdout : null;
}

export async function ensurePreviewFrameAncestors(sandbox: Sandbox, cwd: string): Promise<void> {
  const vercelJsonPath = `${cwd}/vercel.json`;
  const originalJson = await readSandboxFile(sandbox, vercelJsonPath);
  const updatedJson = mergeVercelJsonHeaders(originalJson);
  await sandbox.writeFiles([{ path: vercelJsonPath, content: updatedJson }]);

  for (const name of ['next.config.ts', 'next.config.js', 'next.config.mjs']) {
    const abs = `${cwd}/${name}`;
    const source = await readSandboxFile(sandbox, abs);
    if (!source || !/x-frame-options/i.test(source)) continue;
    const next = stripXFrameOptionsFromNextConfig(source);
    if (next !== source) {
      await sandbox.writeFiles([{ path: abs, content: next }]);
    }
  }
}
