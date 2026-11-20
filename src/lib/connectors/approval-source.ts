import { createHash } from 'node:crypto';
import { z } from 'zod';

// Private host locators, never fields of a model or HTTP action input.
const uuid = z.string().uuid();
const message = { id: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) };
export const approvalSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), ...message }).strict(),
  z.object({ kind: z.literal('message'), ...message }).strict(),
  z.object({ kind: z.literal('instance_log'), ...message }).strict(),
]);
export type ApprovalSource = z.infer<typeof approvalSource>;
export const sourceDigest = (text: string) => createHash('sha256').update(text).digest('hex');
