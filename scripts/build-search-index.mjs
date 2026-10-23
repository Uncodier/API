import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import * as pagefind from 'pagefind';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function htmlFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await htmlFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(relative);
    }
  }
  return files.sort();
}

function checkErrors(result, operation) {
  if (result.errors.length) {
    throw new Error(`Pagefind ${operation}: ${result.errors.join('; ')}`);
  }
  return result;
}

export async function buildSearchIndex(root = projectRoot) {
  const dist = path.join(root, '.next');
  const manifest = JSON.parse(await readFile(path.join(dist, 'prerender-manifest.json'), 'utf8'));
  // Only index the documentation, never API responses, status pages or error pages.
  const routes = Object.entries(manifest.routes).filter(([, entry]) => entry.srcRoute === '/[[...mdxPath]]');
  if (!routes.length) throw new Error('Pagefind: no prerendered documentation routes. Run a full next build first.');

  // Next 16.4 adapter builds namespace HTML by route kind and source-page hash.
  // Do not expose that internal prefix in search result URLs, or fall back to stale app HTML.
  const scopedDir = path.join(dist, 'server', 'route-cache', 'APP_PAGE');
  const scoped = await exists(scopedDir);
  const source = scoped ? scopedDir : path.join(dist, 'server', 'app');
  const files = new Map();
  if (await exists(source)) {
    for (const relative of await htmlFiles(source)) {
      const key = scoped ? relative.match(/^[^/]+\/\$\/(.+\.html)$/)?.[1] : relative;
      if (!key) continue;
      if (files.has(key)) throw new Error(`Pagefind: ambiguous prerendered HTML for ${key}`);
      files.set(key, path.join(source, relative));
    }
  }

  const pages = [];
  for (const [url, entry] of routes) {
    const key = entry.dataRoute?.replace(/^\//, '').replace(/\.rsc$/, '.html');
    const file = files.get(key);
    if (!file) throw new Error(`Pagefind: missing prerendered HTML for ${url} in ${source}. Run a full next build first.`);
    const content = await readFile(file, 'utf8');
    if (!load(content)('[data-pagefind-body]').length) {
      throw new Error(`Pagefind: documentation page ${url} has no data-pagefind-body.`);
    }
    pages.push({ url, content });
  }

  const temporary = await mkdtemp(path.join(tmpdir(), 'api-pagefind-'));
  try {
    const { index } = checkErrors(await pagefind.createIndex(), 'create index');
    if (!index) throw new Error('Pagefind: failed to create index.');
    for (const page of pages) {
      checkErrors(await index.addHTMLFile(page), `index ${page.url}`);
    }
    const bundle = path.join(temporary, '_pagefind');
    checkErrors(await index.writeFiles({ outputPath: bundle }), 'write index');

    const outputs = [path.join(root, 'public', '_pagefind')];
    // The adapter packages public/ before npm postbuild; update its output too,
    // including cached bundles rather than relying on a missing-files-only sync.
    if (await exists(path.join(dist, 'output', 'config.json'))) {
      outputs.push(path.join(dist, 'output', 'static', '_pagefind'));
    }
    for (const output of outputs) {
      await rm(output, { recursive: true, force: true });
      await mkdir(path.dirname(output), { recursive: true });
      await cp(bundle, output, { recursive: true });
    }
    console.log(`[Pagefind] Indexed ${pages.length} documentation pages from ${source}`);
    return { pages: pages.length, source, outputs };
  } finally {
    await pagefind.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildSearchIndex().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}