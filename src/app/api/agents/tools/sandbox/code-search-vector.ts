import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

type RunResult = { stdout: string; stderr: string; exitCode: number };

async function shRun(
  sandbox: Sandbox,
  script: string,
): Promise<RunResult> {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', script],
  });
  return {
    stdout: await result.stdout(),
    stderr: await result.stderr(),
    exitCode: result.exitCode,
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveScope(path: string | undefined): string {
  const workDir = SandboxService.WORK_DIR;
  if (!path?.trim()) return workDir;
  if (path.startsWith('/')) return path;
  return `${workDir}/${path}`.replace(/\/+/g, '/');
}

function clampLimit(value: number | undefined): number {
  const limit =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : 10;
  return Math.min(Math.max(limit, 1), 50);
}

const VECTOR_SCRIPT = `
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
  if (request === 'sharp') {
    return {};
  }
  return originalRequire.apply(this, arguments);
};

const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const WORK_DIR = process.argv[2];
const QUERY = process.argv[3];
const MAX_RESULTS = parseInt(process.argv[4] || '10', 10);
const CACHE_DIR = '/tmp/makinari-vector-indexes';
const RG_BIN = '/tmp/agent-bin/rg';

process.env.HF_HUB_DISABLE_PROGRESS_BARS = '1';

async function main() {
  try {
    require.resolve('/tmp/node_modules/@xenova/transformers');
  } catch (e) {
    execSync('npm install @xenova/transformers onnxruntime-node --omit=optional', { cwd: '/tmp', stdio: 'ignore' });
  }

  const { pipeline, cos_sim, env } = require('/tmp/node_modules/@xenova/transformers');
  env.cacheDir = '/tmp/.cache/transformers';
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  const rgResult = spawnSync(RG_BIN, [
    '--files',
    '--hidden',
    '--no-messages',
    '-g', '!node_modules/**',
    '-g', '!.git/**',
    '-g', '!.next/**',
    '-g', '!.turbo/**',
    '-g', '!.vercel/**',
    '-g', '!dist/**',
    '-g', '!build/**',
    '-g', '!coverage/**',
    '-g', '!.cache/**',
    WORK_DIR
  ], { encoding: 'utf8' });
  if (rgResult.error) throw rgResult.error;
  if (rgResult.status !== 0 && rgResult.status !== 1) {
    throw new Error(
      'rg --files failed (exit ' + String(rgResult.status) + '): ' +
      String(rgResult.stderr || '').trim()
    );
  }
  const files = String(rgResult.stdout || '').split('\\n').filter(Boolean);
  if (files.length === 0) {
    throw new Error(
      'rg discovered no files for the requested vector-search scope; index creation was aborted.'
    );
  }
  const fileState = files.map(file => {
    try {
      const stat = fs.statSync(file);
      return file + ':' + stat.size + ':' + stat.mtimeMs;
    } catch (e) {
      return file + ':missing';
    }
  }).join('\\n');
  const workspaceFingerprint = crypto
    .createHash('sha256')
    .update('vector-index-v3\\n' + WORK_DIR + '\\n' + fileState)
    .digest('hex');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = CACHE_DIR + '/vector-index-v3-' + workspaceFingerprint + '.json';
  let index = [];
  let cacheLoaded = false;

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!Array.isArray(cached) || cached.length === 0) {
        throw new Error('invalid or empty cache');
      }
      index = cached;
      cacheLoaded = true;
    } catch (e) {
      fs.unlinkSync(cacheFile);
    }
  }
  if (!cacheLoaded) {
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        if (content.length > 1000000 || content.includes('\\0')) continue;

        const lines = content.split('\\n');
        const chunkSize = 80;
        const chunkStride = 50;
        for (let i = 0; i < lines.length; i += chunkStride) {
          const chunk = lines.slice(i, i + chunkSize).join('\\n');
          if (chunk.trim().length < 10) continue;

          const relativeFile = file.replace(WORK_DIR + '/', '');
          const output = await extractor(relativeFile + '\\n' + chunk, {
            pooling: 'mean',
            normalize: true
          });
          index.push({
            file: relativeFile,
            line: i + 1,
            text: chunk.length > 400 ? chunk.slice(0, 400) + '...' : chunk,
            embedding: Array.from(output.data)
          });
        }
      } catch (e) {
        // Ignore unreadable and non-text files.
      }
    }
    if (index.length === 0) {
      throw new Error(
        'No indexable text chunks were produced; refusing to cache an empty vector index.'
      );
    }
    const temporaryCache = cacheFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporaryCache, JSON.stringify(index));
    fs.renameSync(temporaryCache, cacheFile);
  }
  try {
    const staleCaches = fs.readdirSync(CACHE_DIR)
      .filter(name => name.startsWith('vector-index-') && name.endsWith('.json'))
      .map(name => ({
        path: CACHE_DIR + '/' + name,
        mtime: fs.statSync(CACHE_DIR + '/' + name).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(3);
    staleCaches.forEach(cache => fs.unlinkSync(cache.path));
  } catch (e) {
    // Cache cleanup must never make retrieval unavailable.
  }

  const queryOutput = await extractor(QUERY, {
    pooling: 'mean',
    normalize: true
  });
  const queryEmbedding = Array.from(queryOutput.data);
  const results = index.map(item => ({
    file: item.file,
    line: item.line,
    text: item.text,
    score: cos_sim(queryEmbedding, item.embedding)
  }));
  results.sort((a, b) => b.score - a.score);

  console.log('VECTOR_SEARCH_RESULT:' + JSON.stringify({
    ok: true,
    workspace_fingerprint: workspaceFingerprint,
    results: results.slice(0, MAX_RESULTS)
  }));
}

main().catch(err => {
  console.log('VECTOR_SEARCH_RESULT:' + JSON.stringify({
    ok: false,
    error: err.message
  }));
});
`;

export async function actionVectorSearch(
  sandbox: Sandbox,
  args: { pattern?: string; path?: string; max_results?: number },
  bins: { rg: boolean },
) {
  if (!bins.rg) {
    return {
      ok: false,
      error:
        'ripgrep (rg) is required for vector_search to list files, but it is not available.',
    };
  }
  const query = (args.pattern ?? '').trim();
  if (!query) {
    return {
      ok: false,
      error: 'pattern (query) is required for vector_search.',
    };
  }
  const limit = clampLimit(args.max_results);
  const scope = resolveScope(args.path);
  const writeResult = await shRun(
    sandbox,
    `cat << 'EOF' > /tmp/vector_search.js\n${VECTOR_SCRIPT}\nEOF`,
  );
  if (writeResult.exitCode !== 0) {
    return {
      ok: false,
      error: `Failed to write vector_search.js: ${writeResult.stderr}`,
    };
  }

  const result = await shRun(
    sandbox,
    `node /tmp/vector_search.js ${shellEscape(scope)} ${shellEscape(query)} ${limit}`,
  );
  const match = result.stdout.match(/VECTOR_SEARCH_RESULT:(.*)/);
  if (!match) {
    return {
      ok: false,
      error:
        `Vector search script failed or produced no valid output. Exit code: ${result.exitCode}. ` +
        `Stderr: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }

  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return {
      ok: true,
      query,
      scope,
      workspace_fingerprint: parsed.workspace_fingerprint,
      count: parsed.results.length,
      results: parsed.results,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to parse vector search results: ${String(error)}`,
    };
  }
}
