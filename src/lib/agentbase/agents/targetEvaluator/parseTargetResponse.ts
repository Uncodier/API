/**
 * Parse TargetProcessor LLM output into a results array.
 * Embedded JSON is accepted only when it matches the target keys.
 */

function findAllJsonArrays(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.substring(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates.sort((a, b) => b.length - a.length);
}

export function extractEmbeddedJsonMatchingTargets(text: string, targets: any[]): any[] | null {
  if (!text || typeof text !== 'string' || !targets || targets.length === 0) {
    return null;
  }

  const expectedKeys = targets.map((t) => Object.keys(t || {}));
  const candidates = findAllJsonArrays(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed) || parsed.length !== targets.length) {
        continue;
      }

      let allMatch = true;
      for (let i = 0; i < parsed.length; i++) {
        const elementKeys = Object.keys(parsed[i] || {});
        const targetKeys = expectedKeys[i] || [];
        if (!targetKeys.some((key) => elementKeys.includes(key))) {
          allMatch = false;
          break;
        }
      }

      if (allMatch) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export type ParseTargetResponse =
  | { ok: true; results: any[] }
  | { ok: false; error: string };

export function parseTargetResponseContent(responseContent: unknown, targets: any[] = []): ParseTargetResponse {
  const preview = (value: string) => value.substring(0, 100);

  if (typeof responseContent === 'string') {
    const trimmed = responseContent.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return { ok: true, results: parsed };
        }
      } catch {
        const extracted = extractEmbeddedJsonMatchingTargets(responseContent, targets);
        if (extracted) {
          return { ok: true, results: extracted };
        }
        return {
          ok: false,
          error: `Invalid LLM response: Could not extract JSON matching target structure. Response started with: "${preview(responseContent)}..."`,
        };
      }
    }

    try {
      const parsedContent = JSON.parse(responseContent);
      if (Array.isArray(parsedContent)) {
        return { ok: true, results: parsedContent };
      }
      if (typeof parsedContent === 'object' && parsedContent !== null) {
        return { ok: true, results: [parsedContent] };
      }
      return { ok: false, error: 'Invalid LLM response: Expected JSON array or object, got primitive value' };
    } catch {
      const extracted = extractEmbeddedJsonMatchingTargets(responseContent, targets);
      if (extracted) {
        return { ok: true, results: extracted };
      }
      return {
        ok: false,
        error: `Invalid LLM response: Could not extract JSON matching target structure. Response started with: "${preview(responseContent)}..."`,
      };
    }
  }

  if (Array.isArray(responseContent)) {
    return { ok: true, results: responseContent };
  }

  if (typeof responseContent === 'object' && responseContent !== null) {
    return { ok: true, results: [responseContent] };
  }

  return {
    ok: false,
    error: `Invalid LLM response: Expected JSON array or object, got ${typeof responseContent}`,
  };
}
