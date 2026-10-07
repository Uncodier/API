import { z } from 'zod';

export class SiteSetupError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const optionsSchema = z.object({
  enable_analytics: z.boolean().optional(),
  enable_chat: z.boolean().optional(),
  enable_leads: z.boolean().optional(),
  enable_email_tracking: z.boolean().optional(),
  default_timezone: z.string().min(1).max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'default_timezone must be a valid timezone').optional(),
  default_language: z.string().min(1).max(35).optional(),
  default_locale: z.string().min(1).max(35).optional(),
});

const setupSchema = z.object({
  site_id: z.string().uuid('site_id must be a valid UUID').transform((id) => id.toLowerCase()),
  // Accepted for compatibility, but never used as the workflow identity.
  user_id: z.string().uuid('user_id must be a valid UUID').transform((id) => id.toLowerCase()).optional(),
  setup_type: z.enum(['basic', 'advanced', 'complete']).default('basic'),
  options: optionsSchema.optional(),
});

export type SiteSetupInput = z.infer<typeof setupSchema>;

export async function parseSetupRequest(request: Request): Promise<SiteSetupInput> {
  let body: unknown;
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      throw new SiteSetupError(415, 'INVALID_REQUEST', 'JSON content type required');
    }
    if (Number(request.headers.get('content-length')) > 4_096) {
      throw new SiteSetupError(413, 'INVALID_REQUEST', 'Site setup request is too large');
    }
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4_096) {
        void reader.cancel().catch(() => {});
        throw new SiteSetupError(413, 'INVALID_REQUEST', 'Site setup request is too large');
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    // Preserve only safe, locally constructed validation failures.
    if (error instanceof SiteSetupError) throw error;
    throw new SiteSetupError(400, 'INVALID_REQUEST', 'Request body must be valid JSON');
  }
  const parsed = setupSchema.safeParse(body);
  if (!parsed.success) {
    throw new SiteSetupError(400, 'INVALID_REQUEST', parsed.error.issues[0].message);
  }
  // Zod strips unknown fields: callers cannot supply financial or workflow arguments.
  return parsed.data;
}

export function parseSetupWorkflowId(request: Request) {
  const query = new URL(request.url).searchParams;
  const workflowId = query.get('workflow_id');
  const match = workflowId?.match(/^site-setup-([0-9a-f-]{36})-(\d{1,20})$/i);
  const site = z.string().uuid().safeParse(match?.[1]);
  if (query.getAll('workflow_id').length !== 1 || !workflowId || !site.success) {
    throw new SiteSetupError(400, 'INVALID_REQUEST', 'A valid site setup workflow_id is required');
  }
  return { workflowId, siteId: site.data.toLowerCase() };
}