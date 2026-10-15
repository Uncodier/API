import type { Sandbox } from '@vercel/sandbox';
import { reconcileSandboxBillingQuiet } from '@/lib/services/billing/sandbox-billing';

function sandboxLabel(sandbox: Sandbox): string {
  const anyS = sandbox as Sandbox & { name?: string; sandboxId?: string };
  return anyS.name || anyS.sandboxId || 'unknown';
}

/**
 * Best-effort stop with retries. Shared by provision, snapshot restore, and recovery
 * so zombie-billing cleanup is one implementation.
 */
export async function stopSandboxQuiet(sandbox: Sandbox): Promise<boolean> {
  if (['stopped', 'failed', 'aborted'].includes(sandbox.status)) {
    await reconcileSandboxBillingQuiet(sandbox);
    return true;
  }
  let delayMs = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sandbox.stop(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout')), 3000); }),
      ]);
      await reconcileSandboxBillingQuiet(sandbox);
      return true;
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
          'Provider cleanup unavailable; details intentionally omitted.',
        );
      }
    } finally { if (timer) clearTimeout(timer); }
  }
  await reconcileSandboxBillingQuiet(sandbox);
  return false;
}
