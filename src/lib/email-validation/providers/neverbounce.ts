import NeverBounce from 'neverbounce';

export type NeverBounceResult = 'valid' | 'invalid' | 'disposable' | 'catchall' | 'unknown';

export interface NeverBounceValidationData {
  email: string;
  isValid: boolean;
  result: NeverBounceResult;
  flags?: string[];
  suggested_correction?: string | null;
  execution_time?: number;
  message?: string;
  timestamp?: string;
}

let cachedClient: NeverBounce | null = null;

function getClient(): NeverBounce {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.NEVER_BOUNCE_API_KEY;
  if (!apiKey) {
    throw new Error('NEVER_BOUNCE_API_KEY is not configured');
  }
  cachedClient = new NeverBounce({ apiKey });
  return cachedClient;
}

export async function validateWithNeverBounce(email: string): Promise<NeverBounceValidationData> {
  const client = getClient();
  const startTime = Date.now();
  const result = await client.single.check(email);
  const executionTime = Date.now() - startTime;

  const responseData: any = result.getResponse?.() || {};
  const isValid = typeof result.is === 'function' ? result.is('valid') : responseData.result === 'valid';
  const validationResult: NeverBounceResult = typeof result.getResult === 'function' ? result.getResult() : (responseData.result || (isValid ? 'valid' : 'invalid'));
  const flags: string[] = Array.isArray(responseData.flags) ? responseData.flags : [];
  const suggestedCorrection = 'suggested_correction' in responseData ? responseData.suggested_correction : null;

  return {
    email,
    isValid,
    result: validationResult,
    flags,
    suggested_correction: suggestedCorrection ?? null,
    execution_time: executionTime,
    message: isValid ? 'Email is valid' : `Email is ${validationResult}`,
    timestamp: new Date().toISOString()
  };
}


