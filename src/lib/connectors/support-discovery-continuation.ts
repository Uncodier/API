import { randomBytes } from 'node:crypto';
import { ConnectorError } from './types';

// A direct catalog cursor plus its enclosing account window exceeds the channel's
// 128-character envelope. Keep positions only, never targets, grants or results.
type Position = { after: string; directCursor?: string };
const positions = new Map<string, { position: Position; context: string; expires: number }>();
export function saveDirectPosition(position: Position, context: Buffer) {
  if (positions.size >= 4096) positions.delete(positions.keys().next().value!);
  const token = `g.${randomBytes(24).toString('base64url')}`;
  positions.set(token, { position, context: context.toString('hex'), expires: Date.now() + 15 * 60_000 });
  return token;
}
export function readDirectPosition(token: string, context: Buffer) {
  const entry = positions.get(token);
  if (!entry || entry.expires <= Date.now() || entry.context !== context.toString('hex')) {
    throw new ConnectorError('STALE_CURSOR', 'Restart support discovery.', 409);
  }
  return entry.position;
}
