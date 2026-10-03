import type { DbCommand } from '../../models/types';
import type { GetCommandByIdOptions } from './CommandQueryService';
import { isValidUUID } from '../../utils/UuidUtils';

type CommandReader = {
  getCommandById(id: string, options?: GetCommandByIdOptions): Promise<DbCommand | null>;
};

/** Poll the exact submitted command, never a "most recent" description match. */
export async function waitForSubmittedCommand(
  service: CommandReader,
  submittedId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ commandId: string; command: DbCommand | null }> {
  const timeoutMs = options.timeoutMs ?? 290_000;
  const intervalMs = options.intervalMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('Command polling intervals must be positive finite numbers');
  }

  const deadline = Date.now() + timeoutMs;
  let commandId = submittedId;

  while (Date.now() < deadline) {
    // The service resolves existing legacy mappings and keeps memory-only
    // fallback commands out of Postgres. Fresh reads observe other workers.
    const command = await service.getCommandById(submittedId, { fresh: true });
    if (!command) throw new Error(`Submitted command ${submittedId} not found`);

    const dbId = [command.id, command.metadata?.dbUuid]
      .find((id): id is string => typeof id === 'string' && isValidUUID(id));
    commandId = dbId || submittedId;

    if (['completed', 'failed', 'cancelled'].includes(command.status)) {
      return { commandId, command };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    // Sequential polling: a slow read cannot create overlapping queries.
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  }

  return { commandId, command: null };
}