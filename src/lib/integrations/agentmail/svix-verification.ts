import { Webhook } from 'svix';
import { headers } from 'next/headers';

/**
 * Verifies Svix webhook signature for AgentMail webhooks
 * @param body Raw request body as string
 * @param webhookSecret Optional webhook secret. If not provided, uses AGENTMAIL_WEBHOOK_SECRET for backward compatibility
 * @returns Verified payload object, or null if verification is not possible (secret not configured or verification failed)
 */
export async function verifySvixWebhook(body: string, webhookSecret?: string): Promise<any | null> {
  const secret = webhookSecret || process.env.AGENTMAIL_WEBHOOK_SECRET;

  if (!secret) {
    console.warn('⚠️ [AgentMail] Webhook secret is not configured. Skipping signature verification.');
    return null;
  }

  const headersList = await headers();
  const svixId = headersList.get('svix-id');
  const svixSignature = headersList.get('svix-signature');
  const svixTimestamp = headersList.get('svix-timestamp');

  if (!svixId || !svixSignature || !svixTimestamp) {
    console.warn('⚠️ [AgentMail] Missing required Svix headers. Skipping signature verification.');
    return null;
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
    console.warn('⚠️ [AgentMail] Svix webhook verification failed:', err.message);
    return null;
  }
}

