import { createRedactor } from '@/lib/harness/security';

/** A private presentation DTO, never the provider envelope or an input to the model. Shape is
 * independent of toolkits. Keep array positions and field paths, including empty containers,
 * instead of guessing which array holds the rows or interpreting business data as zero. */
export type DirectReport = { title: string; note: string; columns: string[]; rows: string[][] };
const safeField = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const privateField = /credential|secret|token|password|passwd|privatekey|publickey|apikey|accesskey|auth|cookie|session|signature|signedurl|headers|diagnostic|stacktrace|debug|rawresponse|^logs?$|connectionstring|clientkey|bearer|certificate/i;
const sensitiveText = /-----BEGIN|\b(?:Bearer|Basic)\s|(?:\w+:\/\/)|\b(?:sk[-_]|sbp_|sb_secret_|gh[pousr]_|xox[baprs]-|AIza|AKIA)|[a-zA-Z0-9+_=/.-]{36,}|(?:token|key|password|authorization|credential|secret)\s*[:=]|[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/i;

export function directOutputReport(data: unknown, credential: string): DirectReport {
  const rows: string[][] = [];
  let nodes = 0, bytes = 0, withheld = false, truncated = false;
  const redact = createRedactor([credential]);
  const add = (path: string, value: string) => {
    const size = Buffer.byteLength(JSON.stringify([path, value]));
    if (bytes + size > 40_000 || rows.length >= 100) { truncated = true; return; }
    bytes += size;
    rows.push([path, value]);
  };
  const visit = (value: unknown, path: string, depth: number) => {
    if (++nodes > 2048 || depth > 12 || path.length > 180 || rows.length >= 100) { truncated = true; return; }
    if (value === null) { add(path, 'null'); return; }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      // The JSON transport cannot represent arbitrarily large integers exactly.
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) { withheld = true; return; }
      const cell = String(value);
      if (redact(cell) !== cell) { withheld = true; return; }
      add(path, cell); return;
    }
    if (typeof value === 'string') {
      if (value.length > 200 || sensitiveText.test(value) || redact(value) !== value) { withheld = true; return; }
      add(path, value); return;
    }
    if (!value || typeof value !== 'object') { withheld = true; return; }
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
      if (!safeField.test(key) || Object.hasOwn(Object.prototype,key) || key === 'prototype' ||
        privateField.test(key.replace(/[^a-zA-Z0-9]/g,'')) || sensitiveText.test(key) || redact(key) !== key) { withheld = true; continue; }
      visit((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(data, '$', 0);
  return { title:'Connector result', columns: ['Field', 'Value'], rows,
    note: 'Provider-confirmed response on the selected connection. A page is not a total.' +
      (withheld ? ' Sensitive, oversized or unsupported fields were omitted. Omitted data is not an empty result.' : '') +
      (truncated ? ' This preview is truncated.' : '') };
}