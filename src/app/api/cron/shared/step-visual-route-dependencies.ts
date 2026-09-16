import path from 'node:path';
import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

const SOURCE_FILE_RE = /\.(?:tsx|jsx|ts|js|css|scss)$/;
const PAGE_FILE_RE = /^src\/app\/.*page\.(?:tsx|jsx|ts|js)$/;
const LAYOUT_FILE_RE = /^src\/app\/.*layout\.(?:tsx|jsx|ts|js)$/;
const SOURCE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.css', '.scss'];
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;

function isFrontendSource(file: string): boolean {
  return (
    SOURCE_FILE_RE.test(file) &&
    file.startsWith('src/') &&
    !file.startsWith('src/app/api/')
  );
}

function importBase(importer: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return path.posix.normalize(`src/${specifier.slice(2)}`);
  if (specifier.startsWith('~/')) return path.posix.normalize(`src/${specifier.slice(2)}`);
  if (!specifier.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
}

function resolveImport(
  importer: string,
  specifier: string,
  sourceFiles: Set<string>,
): string | null {
  const base = importBase(importer, specifier.split('?')[0]);
  if (!base) return null;
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate)) || null;
}

async function readSourceFiles(sandbox: Sandbox): Promise<string[]> {
  const result = await sandbox.runCommand('git', [
    '-C',
    SandboxService.WORK_DIR,
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'src',
  ]);
  if (result.exitCode !== 0) return [];
  const stdout = await result.stdout().catch(() => '');
  return stdout
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => SOURCE_FILE_RE.test(file));
}

async function readContents(
  sandbox: Sandbox,
  files: string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const concurrency = 25;
  for (let offset = 0; offset < files.length; offset += concurrency) {
    const batch = files.slice(offset, offset + concurrency);
    const values = await Promise.all(
      batch.map(async (file) => {
        const content = await sandbox.fs
          .readFile(`${SandboxService.WORK_DIR}/${file}`, 'utf8')
          .catch(() => null);
        return [file, content] as const;
      }),
    );
    for (const [file, content] of values) {
      if (content !== null) contents.set(file, content);
    }
  }
  return contents;
}

/**
 * Follows reverse static imports from changed modules to App Router pages.
 * This lets a component-only edit target the screens that actually render it.
 */
export function inferAffectedPageFilesFromContents(
  changedFiles: string[],
  contents: Map<string, string>,
): string[] {
  const changedSources = changedFiles.filter(isFrontendSource);
  if (changedSources.length === 0) return [];
  const sourceFiles = new Set(contents.keys());
  const importersByDependency = new Map<string, Set<string>>();
  const pageFiles = new Set<string>();

  const addLayoutDescendants = (layoutFile: string) => {
    const layoutDirectory = `${path.posix.dirname(layoutFile)}/`;
    for (const file of Array.from(sourceFiles)) {
      if (file.startsWith(layoutDirectory) && PAGE_FILE_RE.test(file)) {
        pageFiles.add(file);
      }
    }
  };
  for (const changedFile of changedSources) {
    if (LAYOUT_FILE_RE.test(changedFile)) addLayoutDescendants(changedFile);
  }

  for (const [importer, content] of Array.from(contents.entries())) {
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(content))) {
      const dependency = resolveImport(importer, match[1], sourceFiles);
      if (!dependency) continue;
      const importers = importersByDependency.get(dependency) || new Set<string>();
      importers.add(importer);
      importersByDependency.set(dependency, importers);
    }
  }

  const queue = changedSources.filter((file) => sourceFiles.has(file));
  const visited = new Set(queue);
  while (queue.length) {
    const dependency = queue.shift()!;
    for (const importer of Array.from(importersByDependency.get(dependency) || [])) {
      if (PAGE_FILE_RE.test(importer)) pageFiles.add(importer);
      if (LAYOUT_FILE_RE.test(importer)) addLayoutDescendants(importer);
      if (!visited.has(importer)) {
        visited.add(importer);
        queue.push(importer);
      }
    }
  }
  return Array.from(pageFiles).sort();
}

export async function inferAffectedPageFiles(
  sandbox: Sandbox,
  changedFiles: string[],
): Promise<string[]> {
  if (!changedFiles.some(isFrontendSource)) return [];
  const files = await readSourceFiles(sandbox);
  if (files.length === 0) return [];
  const contents = await readContents(sandbox, files);
  return inferAffectedPageFilesFromContents(changedFiles, contents);
}
