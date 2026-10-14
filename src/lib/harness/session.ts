import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactUserText } from './security';
import type { HarnessSession, SessionRequest } from './types';

export const sessionRequestSchema = z.object({
  objective: z.string().trim().min(1).max(24000),
  repository: z.object({
    url: z.string().url().max(2048).refine(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
        (!url.port || url.port === '443') && url.hostname.includes('.') &&
        !/^(localhost|127\.|0\.|169\.254\.)/i.test(url.hostname);
    }, 'Use a public HTTPS repository URL without embedded credentials, query or fragment.'),
    ref: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).optional(),
  }).strict(),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(500).default(100),
    maxOutputTokens: z.number().int().min(256).max(16384).default(4096),
    maxTotalTokens: z.number().int().min(1024).max(10000000).default(1000000),
    maxActiveMs: z.number().int().min(1000).max(14400000).default(3600000),
  }).strict().default({}),
  profile: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
}).strict();

export function createSession(request: SessionRequest, id: string = randomUUID()): HarnessSession {
  const parsed = sessionRequestSchema.parse(request);
  const objective = redactUserText(parsed.objective);
  const now = new Date().toISOString();
  return {
    id, version: 0, status: 'queued', request: { ...parsed, objective },
    messages: [{ role: 'user', content: objective }], turns: 0, allocatedTokens: 0,
    activeMs: 0, uncertainOperations: [], createdAt: now, updatedAt: now,
  };
}