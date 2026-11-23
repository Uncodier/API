import { createRedactor } from '@/lib/harness/security';

/** A private presentation DTO, never the provider envelope or an input to the model. */
export type DirectReport = { title: string; note: string; columns: string[]; rows: string[][] };
const safeField = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const privateField = /credential|secret|token|password|passwd|privatekey|publickey|apikey|accesskey|auth|cookie|session|signature|signedurl|headers|diagnostic|stacktrace|debug|rawresponse|^logs?$|connectionstring|clientkey|bearer|certificate/i;
const sensitiveText = /-----BEGIN|\b(?:Bearer|Basic)\s|(?:\w+:\/\/)|\b(?:sk[-_]|sbp_|sb_secret_|gh[pousr]_|xox[baprs]-|AIza|AKIA)|[a-zA-Z0-9+_=/.-]{36,}|(?:token|key|password|authorization|credential|secret)\s*[:=]|[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/i;
const businessUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function directOutputFilter(credential: string, privateValues: string[] = []) {
  const redact = createRedactor([credential, ...privateValues]);
  return {
    field: (key: string) => safeField.test(key) && !Object.hasOwn(Object.prototype, key) && key !== 'prototype' &&
      !privateField.test(key.replace(/[^a-zA-Z0-9]/g, '')) && !sensitiveText.test(key) && redact(key) === key,
    cell(value: unknown, maxLength = 200, allowBusinessUuid = false) {
      if (value === null) return 'null';
      if (typeof value === 'string') {
        const uuid = allowBusinessUuid && value.length === 36 && businessUuid.test(value);
        return value.length <= maxLength && (uuid || !sensitiveText.test(value)) && redact(value) === value ? value : undefined;
      }
      // The JSON transport cannot represent arbitrarily large integers exactly.
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value)))) {
        const text = String(value);
        if (redact(text) === text) return text;
      }
    },
  };
}

/** Default to field paths, including empty containers, rather than guessing which array holds the rows. */
export function directOutputReport(data: unknown, credential: string, privateValues: string[] = []): DirectReport {
  const rows: string[][] = [];
  let nodes = 0, bytes = 0, withheld = false, truncated = false;
  const filter = directOutputFilter(credential, privateValues);
  const add = (path: string, value: string) => {
    const size = Buffer.byteLength(JSON.stringify([path, value]));
    if (bytes + size > 40_000 || rows.length >= 100) { truncated = true; return; }
    bytes += size;
    rows.push([path, value]);
  };
  const visit = (value: unknown, path: string, depth: number) => {
    if (++nodes > 2048 || depth > 12 || path.length > 180 || rows.length >= 100) { truncated = true; return; }
    if (value === null || typeof value !== 'object') {
      const cell = filter.cell(value);
      if (cell === undefined) { withheld = true; return; }
      add(path, cell); return;
    }
    if (Array.isArray(value)) {
      if (!value.length) add(path, '[]');
      for (let i = 0; i < value.length; i++) {
        if (rows.length >= 100 || nodes >= 2048) { truncated = true; break; }
        visit(value[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }
    const keys = Object.keys(value);
    if (!keys.length) add(path, '{}');
    for (const key of keys) {
      if (rows.length >= 100 || nodes >= 2048) { truncated = true; break; }
      if (!filter.field(key)) { withheld = true; continue; }
      visit((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(data, '$', 0);
  return { title:'Connector result', columns: ['Field', 'Value'], rows,
    note: 'Provider-confirmed response on the selected connection. A page is not a total.' +
      (withheld ? ' Sensitive, oversized or unsupported fields were omitted. Omitted data is not an empty result.' : '') +
      (truncated ? ' This preview is truncated.' : '') };
}