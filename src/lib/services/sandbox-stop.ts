import type { Sandbox } from '@vercel/sandbox';

function sandboxLabel(sandbox: Sandbox): string {
  const anyS = sandbox as Sandbox & { name?: string; sandboxId?: string };
  return anyS.name || anyS.sandboxId || 'unknown';
}

/**
 * Best-effort stop with retries. Shared by provision, snapshot restore, and recovery
 * so zombie-billing cleanup is one implementation.
 */
export async function stopSandboxQuiet(sandbox: Sandbox, opts?: { blocking?: boolean }): Promise<void> {
  const blocking = opts?.blocking ?? false;
  let delayMs = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await Promise.race([
        sandbox.stop({ blocking } as { blocking?: boolean }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
      ]);
      return;
    } catch (e: unknown) {
      if (attempt < 2) {
        console.warn(
          `[Sandbox] CLEANUP: stopSandboxQuiet attempt ${attempt + 1} failed for ${sandboxLabel(sandbox)}. Retrying in ${delayMs}ms...`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      } else {
        console.error(
          `[Sandbox] ZOMBIE ALERT: Failed to stop sandbox ${sandboxLabel(sandbox)} after 3 attempts. It may be orphaned.`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
}
