import { createHash } from 'node:crypto';
import type { Sandbox } from '@vercel/sandbox';
import type { MigrationRepairTarget } from './migration-repair-types';

/** Verify repair provenance again whenever a gate/checkpoint can recreate the sandbox. */
export async function verifyMigrationRepairFiles(sandbox: Sandbox, targets: MigrationRepairTarget[]): Promise<void> {
  for (const target of targets) {
    const read = await sandbox.runCommand('cat', [target.file]);
    if (read.exitCode !== 0 || createHash('sha256').update(await read.stdout()).digest('hex') !== target.checksum) {
      throw new Error(`Repaired migration ${target.file} is missing or changed after sandbox recovery.`);
    }
  }
}