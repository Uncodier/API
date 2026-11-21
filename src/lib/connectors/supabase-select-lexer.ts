import { ConnectorError } from './types';

export function invalid(message = 'Use a single SELECT on a listed analytics source. Platform scope requires an aggregate.'): never {
  // Do not reflect caller SQL, data, bind values, or physical schema details in diagnostics.
  throw new ConnectorError('INVALID_TOOL_ARGUMENTS', message, 400);
}

export type TokenKind = 'word' | 'identifier' | 'string' | 'number' | 'parameter' | 'symbol' | 'eof';
export type Token = { kind: TokenKind; value: string };
const identifier = /^[a-z][a-z0-9_]{0,47}$/;
export const simpleName = (value: string) => identifier.test(value) &&
  !Object.hasOwn(Object.prototype, value) && value !== 'prototype';

// Sticky matches only. Every non-whitespace byte must be consumed by one of these token classes.
// In particular there is no comment stripping, SQL normalization or acceptance of unknown tokens.
const tokens = /[ \t\r\n]+|'(?:[^'\x00]|'')*'|"[a-z][a-z0-9_]{0,47}"|[a-zA-Z][a-zA-Z0-9_]*|\$[1-9][0-9]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|<>|!=|<=|>=|[<>=.,();*]/y;

export function tokenize(input: unknown): Token[] {
  if (typeof input !== 'string' || input.length > 4096 || Buffer.byteLength(input) > 4096) invalid();
  const list: Token[] = [];
  let offset = 0;
  while (offset < input.length) {
    tokens.lastIndex = offset;
    const raw = tokens.exec(input)?.[0];
    if (!raw) invalid();
    offset += raw.length;
    const ch = raw[0];
    // PostgreSQL rejects trailing identifier junk on numeric constants and positional parameters.
    if (/[0-9$-]/.test(ch) && /[A-Za-z_]/.test(input.charAt(offset))) invalid();
    if (' \r\n\t'.includes(ch)) continue;
    if (list.length >= 320) invalid();
    if (ch === "'") list.push({ kind: 'string', value: raw.slice(1, -1).replace(/''/g, "'") });
    else if (ch === '"') list.push({ kind: 'identifier', value: raw.slice(1, -1) });
    else if (/[A-Za-z]/.test(ch)) list.push({ kind: 'word', value: raw.toLowerCase() });
    else if (ch === '$') list.push({ kind: 'parameter', value: raw.slice(1) });
    else if (/[0-9-]/.test(ch)) list.push({ kind: 'number', value: raw });
    else list.push({ kind: 'symbol', value: raw });
  }
  list.push({ kind: 'eof', value: '' });
  return list;
}
