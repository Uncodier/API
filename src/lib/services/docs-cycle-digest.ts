export interface RawDocFile {
  path: string;
  content: string;
  mtime?: number;
}

export interface DigestFileEntry {
  path: string;
  content: string;
  bytes: number;
  bytes_original: number;
  summarized: boolean;
}

export interface DocsDigestConfig {
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

export const DOCS_DIGEST_DEFAULTS: Required<DocsDigestConfig> = {
  maxTotalBytes: 48 * 1024, // 48KB total
  maxFileBytes: 8 * 1024, // 8KB per file
  maxFiles: 20,
};

function byteLen(s: string): number {
  return Buffer.byteLength(s || '', 'utf-8');
}

export function summarizeJson(content: string, maxBytes: number): string {
  try {
    const obj = JSON.parse(content);
    const summary: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        summary[key] = value.length > 100 ? `${value.substring(0, 100)}...` : value;
      } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        summary[key] = value;
      } else if (Array.isArray(value)) {
        // Keep short scalar arrays (quote line items); collapse large/nested
        if (
          value.length <= 20 &&
          value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
        ) {
          summary[key] = value;
        } else {
          summary[key] = `[Array(${value.length})]`;
        }
      } else if (typeof value === 'object') {
        // One-level flatten for nested quote-like objects
        const nested: Record<string, unknown> = {};
        for (const [nk, nv] of Object.entries(value as Record<string, unknown>)) {
          if (typeof nv === 'string' || typeof nv === 'number' || typeof nv === 'boolean' || nv === null) {
            nested[nk] = typeof nv === 'string' && nv.length > 80 ? `${nv.slice(0, 80)}...` : nv;
          }
        }
        summary[key] = Object.keys(nested).length > 0 ? nested : '{Object}';
      }
    }

    let result = JSON.stringify(summary, null, 2);
    if (byteLen(result) > maxBytes) {
      result = `${Buffer.from(result, 'utf-8').subarray(0, Math.max(0, maxBytes - 20)).toString('utf-8')}\n... [truncated]`;
    }
    return result;
  } catch {
    return summarizeText(content, maxBytes);
  }
}

/** Prefer headings + first/last chunks for markdown. */
export function summarizeMarkdown(content: string, maxBytes: number): string {
  if (byteLen(content) <= maxBytes) return content;

  const headings = content
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .slice(0, 40)
    .join('\n');

  const headingBlock = headings ? `## Headings\n${headings}\n\n` : '';
  const remaining = Math.max(200, maxBytes - byteLen(headingBlock) - 80);
  const half = Math.floor(remaining / 2);
  const bytes = byteLen(content);
  const head = Buffer.from(content, 'utf-8').subarray(0, half).toString('utf-8');
  const tail = Buffer.from(content, 'utf-8').subarray(Math.max(0, bytes - half)).toString('utf-8');
  const omitted = Math.max(0, bytes - half * 2);

  let result = `${headingBlock}## Excerpt (head)\n${head}\n\n... [${omitted} bytes omitted] ...\n\n## Excerpt (tail)\n${tail}`;
  if (byteLen(result) > maxBytes) {
    result = summarizeText(result, maxBytes);
  }
  return result;
}

export function summarizeText(content: string, maxBytes: number): string {
  const bytes = byteLen(content);
  if (bytes <= maxBytes) return content;

  const halfBudget = Math.max(40, Math.floor(maxBytes / 2) - 40);
  const head = Buffer.from(content, 'utf-8').subarray(0, halfBudget).toString('utf-8');
  const tail = Buffer.from(content, 'utf-8').subarray(bytes - halfBudget).toString('utf-8');
  return `${head}\n\n... [${bytes - halfBudget * 2} bytes omitted] ...\n\n${tail}`;
}

export function summarizeDocContent(path: string, content: string, maxBytes: number): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return summarizeJson(content, maxBytes);
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return summarizeMarkdown(content, maxBytes);
  return summarizeText(content, maxBytes);
}

export function processDocsDigest(
  rawFiles: RawDocFile[],
  config?: DocsDigestConfig,
): DigestFileEntry[] {
  const { maxTotalBytes, maxFileBytes, maxFiles } = { ...DOCS_DIGEST_DEFAULTS, ...config };

  let sortedFiles = [...rawFiles].sort((a, b) => {
    const timeA = a.mtime || 0;
    const timeB = b.mtime || 0;
    if (timeB !== timeA) return timeB - timeA;
    return a.path.localeCompare(b.path);
  });

  if (sortedFiles.length > maxFiles) {
    sortedFiles = sortedFiles.slice(0, maxFiles);
  }

  const results: DigestFileEntry[] = [];
  let currentTotalBytes = 0;

  for (const file of sortedFiles) {
    const originalBytes = byteLen(file.content);
    let shouldSummarize = false;
    let targetSize = originalBytes;

    if (originalBytes > maxFileBytes) {
      shouldSummarize = true;
      targetSize = maxFileBytes;
    }

    if (currentTotalBytes + targetSize > maxTotalBytes) {
      shouldSummarize = true;
      targetSize = Math.max(0, maxTotalBytes - currentTotalBytes);
      if (targetSize < 500) break;
    }

    const processedContent = shouldSummarize
      ? summarizeDocContent(file.path, file.content, targetSize)
      : file.content;

    const finalBytes = byteLen(processedContent);
    results.push({
      path: file.path,
      content: processedContent,
      bytes: finalBytes,
      bytes_original: originalBytes,
      summarized: shouldSummarize,
    });
    currentTotalBytes += finalBytes;
  }

  return results;
}

/** Format digest for wrap-up prompt injection. */
export function formatDigestForPrompt(files: DigestFileEntry[]): string {
  if (!files.length) return 'No docs found in this cycle.';
  let text = '=== DOCS DIGEST ===\n';
  for (const file of files) {
    text += `\n--- File: ${file.path} (${file.bytes_original} bytes) ${file.summarized ? '[SUMMARIZED]' : ''} ---\n`;
    text += `${file.content}\n`;
  }
  return text;
}

/**
 * Reload the latest cycle_docs_digest from instance_logs so workflow steps
 * do not need to pass the full file payload between durable steps.
 */
export async function loadLatestDocsDigestFromLogs(
  instanceId: string,
  requirementId?: string,
): Promise<DigestFileEntry[] | null> {
  const { supabaseAdmin } = await import('@/lib/database/supabase-client');
  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .select('details')
    .eq('instance_id', instanceId)
    .eq('log_type', 'agent_action')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !data) return null;

  for (const row of data) {
    const details = row.details as Record<string, unknown> | null;
    if (!details || details.kind !== 'cycle_docs_digest') continue;
    if (
      requirementId &&
      details.requirement_id &&
      String(details.requirement_id) !== requirementId
    ) {
      continue;
    }
    const files = details.files;
    if (Array.isArray(files) && files.length > 0) {
      return files as DigestFileEntry[];
    }
  }
  return null;
}
