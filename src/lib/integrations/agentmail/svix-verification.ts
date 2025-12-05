import { Webhook } from 'svix';
import { headers } from 'next/headers';

/**
 * Verifies Svix webhook signature for AgentMail webhooks
 * @param body Raw request body as string
 * @returns Verified payload object
 * @throws Error if verification fails
 */
export async function verifySvixWebhook(body: string): Promise<any> {
  const webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new Error('AGENTMAIL_WEBHOOK_SECRET environment variable is not configured');
  }

  const headersList = await headers();
  const svixId = headersList.get('svix-id');
  const svixSignature = headersList.get('svix-signature');
  const svixTimestamp = headersList.get('svix-timestamp');

  if (!svixId || !svixSignature || !svixTimestamp) {
    throw new Error('Missing required Svix headers: svix-id, svix-signature, or svix-timestamp');
  }

  const wh = new Webhook(webhookSecret);

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

