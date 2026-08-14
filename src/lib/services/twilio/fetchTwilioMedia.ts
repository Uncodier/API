/**
 * Download Twilio media URLs (WhatsApp images/audio/files).
 * These endpoints require Basic Auth and 307-redirect to S3; forwarding
 * Authorization to S3 makes the second hop fail.
 */

export function isTwilioMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'api.twilio.com' || host.endsWith('.api.twilio.com');
  } catch {
    return typeof url === 'string' && url.includes('api.twilio.com');
  }
}

export function accountSidFromTwilioMediaUrl(url: string): string | undefined {
  const match = url.match(/\/Accounts\/(AC[0-9a-fA-F]{32})\//i);
  return match?.[1];
}

export type TwilioMediaAuth = {
  accountSid?: string;
  authToken?: string;
};

function envValue(env: NodeJS.Dict<string>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

export function resolveTwilioMediaAuth(
  url: string,
  options: TwilioMediaAuth = {},
  env: NodeJS.Dict<string> = process.env
): { accountSid: string; authToken: string } | null {
  const authToken =
    options.authToken ||
    envValue(env, 'GEAR_TWILIO_AUTH_TOKEN') ||
    envValue(env, 'TWILIO_AUTH_TOKEN');
  const accountSid =
    options.accountSid ||
    accountSidFromTwilioMediaUrl(url) ||
    envValue(env, 'GEAR_TWILIO_ACCOUNT_SID') ||
    envValue(env, 'TWILIO_ACCOUNT_SID');

  if (!accountSid || !authToken) return null;
  return { accountSid, authToken };
}

export async function fetchTwilioMedia(
  url: string,
  options: TwilioMediaAuth = {},
  env: NodeJS.Dict<string> = process.env
): Promise<{ buffer: ArrayBuffer; contentType?: string }> {
  const auth = resolveTwilioMediaAuth(url, options, env);
  const headers = new Headers();
  if (auth) {
    headers.set(
      'Authorization',
      `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64')}`
    );
  }

  let response = await fetch(url, { headers, redirect: 'manual' });

  if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
    const redirectUrl = response.headers.get('location')!;
    response = await fetch(redirectUrl);
  }

  if (!response.ok) {
    throw new Error(`HTTP error ${response.status} when downloading Twilio media`);
  }

  const buffer = await response.arrayBuffer();
  return {
    buffer,
    contentType: response.headers.get('content-type') || undefined,
  };
}

export function replaceTwilioMediaUrls(
  text: string,
  originals: Array<{ url: string }>,
  uploaded: Array<{ url?: string }>
): string {
  let next = text;
  for (let i = 0; i < originals.length; i++) {
    const from = originals[i]?.url;
    const to = uploaded[i]?.url;
    if (from && to && from !== to) {
      next = next.split(from).join(to);
    }
  }
  return next;
}
