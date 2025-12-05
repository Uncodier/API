import { Webhook } from 'svix';
import { headers } from 'next/headers';

/**
 * Verifies Svix webhook signature for AgentMail webhooks
 * @param body Raw request body as string
 * @param webhookSecret Optional webhook secret. If not provided, uses AGENTMAIL_WEBHOOK_SECRET for backward compatibility
 * @returns Verified payload object
 * @throws Error if verification fails
 */
export async function verifySvixWebhook(body: string, webhookSecret?: string): Promise<any> {
  const secret = webhookSecret || process.env.AGENTMAIL_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('Webhook secret is not configured. Provide webhookSecret parameter or set AGENTMAIL_WEBHOOK_SECRET environment variable');
  }

  const headersList = await headers();
  const svixId = headersList.get('svix-id');
  const svixSignature = headersList.get('svix-signature');
  const svixTimestamp = headersList.get('svix-timestamp');

  if (!svixId || !svixSignature || !svixTimestamp) {
    throw new Error('Missing required Svix headers: svix-id, svix-signature, or svix-timestamp');
  }

  const wh = new Webhook(secret);

  try {
    const payload = wh.verify(body, {
      'svix-id': svixId,
      'svix-signature': svixSignature,
      'svix-timestamp': svixTimestamp,
    }) as any;

    return payload;
  } catch (err: any) {
    console.error('❌ Svix webhook verification failed:', err.message);
    throw new Error(`Webhook verification failed: ${err.message}`);
  }
}

