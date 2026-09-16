const SENSITIVE_QUERY_KEY =
  /^(?:token|access_token|refresh_token|api_?key|key|signature|sig|secret)$/i;

export function sanitizeTelemetryUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return sanitizeTelemetryText(value);
  }
}

export function sanitizeTelemetryText(value: string): string {
  return value
    .replace(
      /([?&](?:token|access_token|refresh_token|api_?key|key|signature|sig|secret)=)[^&#\s"'<>]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
      'Bearer [REDACTED]',
    );
}
