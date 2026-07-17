import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

export interface FileFreshness {
  mtime: string | null;
  updated_this_cycle: boolean | null;
  git_status: string | null;
}

export interface StructuredListEntry extends FileFreshness {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
}

/**
 * Gets a map of file path (relative to repo root) -> git status (e.g., 'M', '??', 'A')
 */
export async function getGitPorcelainMap(sandbox: Sandbox, cwd: string): Promise<Record<string, string>> {
  try {
    const res = await SandboxService.runCommandInSandbox(sandbox, 'git', ['status', '--porcelain'], cwd);
    if (res.exitCode !== 0) {
      return {};
    }
    
    const lines = res.stdout.split('\n').map(l => l.trimEnd());
    const map: Record<string, string> = {};
    
    for (const line of lines) {
      if (!line) continue;
      // git status --porcelain format: "XY PATH" or "XY ORIG_PATH -> NEW_PATH" (renames)
      const status = line.substring(0, 2);
      let path = line.substring(3);
      const arrowIdx = path.indexOf(' -> ');
      if (arrowIdx !== -1) {
        path = path.substring(arrowIdx + 4);
      }
      if (path.startsWith('"') && path.endsWith('"')) {
        path = path.slice(1, -1);
      }
      map[path] = status;
    }
    return map;
  } catch (err) {
    console.warn('[FileFreshness] Failed to get git porcelain map:', err);
    return {};
  }
}

/**
 * Classifies if an mtime is considered "updated this cycle" based on the cycle baseline.
 * If baseline is missing, returns null.
 */
export function classifyFreshness(mtime: string | null, cycleBaselineAt?: string): boolean | null {
  if (!cycleBaselineAt || !mtime) return null;
  
  const mtimeMs = new Date(mtime).getTime();
  const baselineMs = new Date(cycleBaselineAt).getTime();
  
  if (isNaN(mtimeMs) || isNaN(baselineMs)) return null;
  
  return mtimeMs >= baselineMs;
}

export function formatListLine(entry: StructuredListEntry): string {
  const mtimeStr = entry.mtime ? entry.mtime : 'unknown_time';
  
  let tags = '';
  if (entry.updated_this_cycle === true) {
    tags += '[updated_this_cycle] ';
  } else if (entry.updated_this_cycle === false) {
    tags += '[unchanged_this_cycle] ';
  }
  
  if (entry.git_status) {
    tags += `[dirty:${entry.git_status}] `;
  }
  
  const sizeStr = String(entry.size).padStart(10, ' ');
  const typeChar = entry.type === 'dir' ? 'd' : entry.type === 'symlink' ? 'l' : '-';
  
  return `${typeChar} ${sizeStr} ${mtimeStr} ${tags}${entry.name}`;
}
