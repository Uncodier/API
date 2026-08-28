import { validateResults } from './validateResults.js';

export const MAX_PARSE_RETRIES = 2;

export function schemaRetryUserMessage(error: string): string {
  return `Your previous response did not match the required target structure.
Error: ${error}
Return a JSON array with EXACTLY the same keys as each target. Do not wrap in markdown. Do not add extra keys.`;
}

export function matchTargetKeys(results: any[], targets: any[]): { isValid: boolean; error?: string } {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { isValid: true };
  }
  if (!Array.isArray(results) || results.length !== targets.length) {
    return {
      isValid: false,
      error: `Expected ${targets.length} results matching targets, got ${Array.isArray(results) ? results.length : typeof results}`,
    };
  }

  for (let i = 0; i < targets.length; i++) {
    const targetKeys = Object.keys(targets[i] || {});
    const resultKeys = Object.keys(results[i] || {});
    const missing = targetKeys.filter((key) => !resultKeys.includes(key));
    if (missing.length > 0) {
      return {
        isValid: false,
        error: `Result ${i} is missing target keys: ${missing.join(', ')}. Got: ${resultKeys.join(', ') || '(none)'}`,
      };
    }
  }

  return { isValid: true };
}

export type SchemaValidation = {
  isValid: boolean;
  error?: string;
  results?: any[];
  correctedResults?: any[];
};

/**
 * validateResults first. correctedResults are accepted without a retry.
 * Otherwise require target keys so a valid-looking JSON object still re-prompts.
 */
export function applyTargetSchemaValidation(results: any[], targets: any[]): SchemaValidation {
  const validation = validateResults(results || [], targets) as {
    isValid: boolean;
    error?: string;
    correctedResults?: any[];
  };

  if (validation.correctedResults) {
    return {
      isValid: true,
      results: validation.correctedResults,
      correctedResults: validation.correctedResults,
    };
  }

  if (!validation.isValid) {
    return { isValid: false, error: validation.error || 'Target schema validation failed' };
  }

  const keyCheck = matchTargetKeys(results, targets);
  if (!keyCheck.isValid) {
    return { isValid: false, error: keyCheck.error };
  }

  return { isValid: true, results };
}
