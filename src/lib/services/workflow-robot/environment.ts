const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeWorkflowEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const environment: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value)) {
    if (!SAFE_ENV_NAME.test(name) || rawValue == null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof rawValue)) continue;
    const stringValue = String(rawValue);
    if (stringValue.includes('\0')) continue;
    environment[name] = stringValue;
  }
  return environment;
}

export function normalizeWorkflowSecretNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((name) => {
    if (typeof name !== 'string') return [];
    const normalized = name.trim();
    return SAFE_ENV_NAME.test(normalized) ? [normalized] : [];
  })));
}

export function selectWorkflowBrowserSecrets(
  environment: Record<string, string>,
  requestedNames: unknown,
): { secrets: Record<string, string>; missing: string[] } {
  const names = normalizeWorkflowSecretNames(requestedNames);
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      secrets[name] = environment[name]!;
    } else {
      missing.push(name);
    }
  }
  return { secrets, missing };
}
