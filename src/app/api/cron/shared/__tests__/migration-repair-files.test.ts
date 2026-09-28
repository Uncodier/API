import { createHash } from 'node:crypto';
import { verifyMigrationRepairFiles } from '@/lib/services/apps-platform/migration-repair-files';

describe('repaired SQL provenance across sandbox recovery', () => {
  const sql = 'CREATE POLICY owner ON records USING (auth.uid() = user_id);';
  const target = { file: 'supabase/migrations/001.sql', schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenantId: 'tenant',
    reason: 'lint' as const, checksum: createHash('sha256').update(sql).digest('hex') };

  it('requires exact source bytes before gate/checkpoint continuation', async () => {
    const sandbox = { runCommand: jest.fn().mockResolvedValue({ exitCode: 0, stdout: async () => sql }) };
    await expect(verifyMigrationRepairFiles(sandbox as any, [target])).resolves.toBeUndefined();
    expect(sandbox.runCommand).toHaveBeenCalledWith('cat', [target.file]);
    sandbox.runCommand.mockResolvedValue({ exitCode: 0, stdout: async () => `${sql}\n` });
    await expect(verifyMigrationRepairFiles(sandbox as any, [target])).rejects.toThrow('missing or changed');
    sandbox.runCommand.mockResolvedValue({ exitCode: 1 });
    await expect(verifyMigrationRepairFiles(sandbox as any, [target])).rejects.toThrow('missing or changed');
  });
});