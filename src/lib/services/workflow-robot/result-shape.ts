type WorkflowOutputScalarType = 'any' | 'string' | 'number' | 'boolean';

export type WorkflowOutputShape =
  | {
    kind: 'object';
    fields: Record<string, WorkflowOutputShape>;
  }
  | {
    kind: 'array';
    item?: WorkflowOutputShape;
  }
  | {
    kind: 'scalar';
    valueType: WorkflowOutputScalarType;
  };

export interface ParsedWorkflowOutputContract {
  structured: boolean;
  shape?: WorkflowOutputShape;
  error?: string;
  repaired?: boolean;
  suggestion?: string;
}

export interface WorkflowOutputContractContext {
  title?: unknown;
  description?: unknown;
  instructions?: unknown;
}

type TokenKind =
  | '{'
  | '}'
  | '['
  | ']'
  | ':'
  | ','
  | 'string'
  | 'number'
  | 'identifier'
  | 'eof';

interface Token {
  kind: TokenKind;
  value?: string;
  offset: number;
}

const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const PUNCTUATION = new Set(['{', '}', '[', ']', ':', ',']);
const MAX_VALIDATION_ISSUES = 20;

function unwrapCodeFence(value: string): string {
  const fenced = value.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] || value).trim();
}

class ShapeTokenizer {
  private offset = 0;

  constructor(private readonly source: string) {}

  next(): Token {
    while (/\s/.test(this.source[this.offset] || '')) this.offset++;
    const start = this.offset;
    if (start >= this.source.length) return { kind: 'eof', offset: start };

    const character = this.source[this.offset]!;
    if (PUNCTUATION.has(character)) {
      this.offset++;
      return { kind: character as TokenKind, offset: start };
    }
    if (character === '"' || character === "'") {
      return this.readString(character);
    }
    const number = this.source.slice(this.offset).match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
    )?.[0];
    if (number) {
      this.offset += number.length;
      return { kind: 'number', value: number, offset: start };
    }
    const identifier = this.source.slice(this.offset).match(
      /^[A-Za-z_][A-Za-z0-9_-]*/,
    )?.[0];
    if (identifier) {
      this.offset += identifier.length;
      return { kind: 'identifier', value: identifier, offset: start };
    }
    throw new Error(`Unexpected character "${character}" at offset ${start}.`);
  }

  private readString(quote: string): Token {
    const start = this.offset++;
    let value = '';
    while (this.offset < this.source.length) {
      const character = this.source[this.offset++]!;
      if (character === quote) {
        return { kind: 'string', value, offset: start };
      }
      if (character === '\\') {
        if (this.offset >= this.source.length) break;
        const escaped = this.source[this.offset++]!;
        const replacements: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
        };
        value += replacements[escaped] ?? escaped;
      } else {
        value += character;
      }
    }
    throw new Error(`Unterminated string at offset ${start}.`);
  }
}

class ShapeParser {
  private current: Token;

  constructor(private readonly tokenizer: ShapeTokenizer) {
    this.current = tokenizer.next();
  }

  parse(): WorkflowOutputShape {
    const shape = this.parseValue();
    if (shape.kind !== 'object') {
      throw new Error('Structured expected_output must describe a data object.');
    }
    this.expect('eof');
    return shape;
  }

  private parseValue(): WorkflowOutputShape {
    if (this.current.kind === '{') return this.parseObject();
    if (this.current.kind === '[') return this.parseArray();
    if (this.current.kind === 'string') {
      this.advance();
      return { kind: 'scalar', valueType: 'string' };
    }
    if (this.current.kind === 'number') {
      this.advance();
      return { kind: 'scalar', valueType: 'number' };
    }
    if (this.current.kind === 'identifier') {
      const identifier = String(this.current.value || '').toLowerCase();
      this.advance();
      if (['string', 'text', 'url'].includes(identifier)) {
        return { kind: 'scalar', valueType: 'string' };
      }
      if (['number', 'integer', 'float'].includes(identifier)) {
        return { kind: 'scalar', valueType: 'number' };
      }
      if (['boolean', 'bool', 'true', 'false'].includes(identifier)) {
        return { kind: 'scalar', valueType: 'boolean' };
      }
      return { kind: 'scalar', valueType: 'any' };
    }
    throw new Error(`Expected a value at offset ${this.current.offset}.`);
  }

  private parseObject(): WorkflowOutputShape {
    this.expect('{');
    const fields = Object.create(null) as Record<string, WorkflowOutputShape>;
    while (this.current.kind !== '}') {
      if (
        this.current.kind !== 'string' &&
        this.current.kind !== 'identifier'
      ) {
        throw new Error(
          `Expected an object field name at offset ${this.current.offset}.`,
        );
      }
      const field = String(this.current.value || '');
      if (!SAFE_FIELD_NAME.test(field)) {
        throw new Error(
          `Field "${field}" must use letters, numbers, and underscores only.`,
        );
      }
      if (BLOCKED_FIELD_NAMES.has(field)) {
        throw new Error(`Field "${field}" is not allowed.`);
      }
      if (Object.prototype.hasOwnProperty.call(fields, field)) {
        throw new Error(`Field "${field}" is declared more than once.`);
      }
      this.advance();

      if (this.current.kind === ':') {
        this.advance();
        fields[field] = this.parseValue();
      } else {
        fields[field] = { kind: 'scalar', valueType: 'any' };
      }

      if (this.current.kind === ',') {
        this.advance();
        if (this.current.kind === '}') break;
        continue;
      }
      if (this.current.kind !== '}') {
        throw new Error(`Expected "," or "}" at offset ${this.current.offset}.`);
      }
    }
    this.expect('}');
    return { kind: 'object', fields };
  }

  private parseArray(): WorkflowOutputShape {
    this.expect('[');
    if (this.current.kind === ']') {
      this.advance();
      return { kind: 'array' };
    }
    const item = this.parseValue();
    if (this.current.kind === ',') {
      throw new Error(
        'Array contracts must contain at most one item template.',
      );
    }
    this.expect(']');
    return { kind: 'array', item };
  }

  private expect(kind: TokenKind): void {
    if (this.current.kind !== kind) {
      throw new Error(
        `Expected "${kind}" at offset ${this.current.offset}, found "${this.current.kind}".`,
      );
    }
    this.advance();
  }

  private advance(): void {
    this.current = this.tokenizer.next();
  }
}

function normalizedWord(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function wordDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0]!;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex]!;
      previous[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function inferCollectionField(
  rawTotalField: string,
  context: WorkflowOutputContractContext,
): string {
  const suffix = normalizedWord(rawTotalField)
    .replace(/^total_?/, '');
  const contextWords = [
    context.title,
    context.description,
    context.instructions,
  ]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) =>
      value
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .match(/[a-z][a-z0-9_]*/g) || [])
    .filter((word) => word.length >= 4 && word.endsWith('s'));

  let best = suffix;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of contextWords) {
    const distance = wordDistance(suffix, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const threshold = Math.max(2, Math.floor(suffix.length * 0.3));
  return bestDistance <= threshold && SAFE_FIELD_NAME.test(best)
    ? best
    : (SAFE_FIELD_NAME.test(suffix) && suffix ? suffix : 'items');
}

function formatShape(shape: WorkflowOutputShape): string {
  if (shape.kind === 'object') {
    return `{ ${Object.entries(shape.fields)
      .map(([field, nested]) => `${field}: ${formatShape(nested)}`)
      .join(', ')} }`;
  }
  if (shape.kind === 'array') {
    return shape.item ? `[${formatShape(shape.item)}]` : '[]';
  }
  return shape.valueType === 'any' ? 'unknown' : shape.valueType;
}

function repairLegacyCollectionContract(
  source: string,
  context: WorkflowOutputContractContext,
): ParsedWorkflowOutputContract | null {
  const legacy = source.match(
    /^\{\s*\[\s*(\{[\s\S]*\})\s*\]\s*,\s*(["']?)([A-Za-z_][A-Za-z0-9_-]*)\2\s*:\s*[^{}]+\}$/,
  );
  if (!legacy) return null;

  try {
    const item = new ShapeParser(new ShapeTokenizer(legacy[1]!)).parse();
    const collectionField = inferCollectionField(legacy[3]!, context);
    const totalField = `total_${collectionField}`;
    const fields = Object.create(null) as Record<string, WorkflowOutputShape>;
    fields[collectionField] = { kind: 'array', item };
    fields[totalField] = { kind: 'scalar', valueType: 'number' };
    const shape: WorkflowOutputShape = { kind: 'object', fields };
    return {
      structured: true,
      shape,
      repaired: true,
      suggestion: formatShape(shape),
    };
  } catch {
    return null;
  }
}

export function parseWorkflowExpectedOutputContract(
  value: unknown,
  context: WorkflowOutputContractContext = {},
): ParsedWorkflowOutputContract {
  if (typeof value !== 'string' || !value.trim()) {
    return { structured: false };
  }
  const source = unwrapCodeFence(value.trim());
  if (!source.startsWith('{') && !source.startsWith('[')) {
    return { structured: false };
  }
  try {
    const shape = new ShapeParser(new ShapeTokenizer(source)).parse();
    return { structured: true, shape };
  } catch (error) {
    const repaired = repairLegacyCollectionContract(source, context);
    if (repaired) return repaired;
    return {
      structured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateShape(
  shape: WorkflowOutputShape,
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (issues.length >= MAX_VALIDATION_ISSUES) return;
  if (shape.kind === 'object') {
    if (!isObject(value)) {
      issues.push(`${path} must be an object`);
      return;
    }
    for (const [field, nestedShape] of Object.entries(shape.fields)) {
      const nestedPath = `${path}.${field}`;
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        issues.push(`${nestedPath} is required`);
        continue;
      }
      validateShape(nestedShape, value[field], nestedPath, issues);
    }
    return;
  }
  if (shape.kind === 'array') {
    if (!Array.isArray(value)) {
      issues.push(`${path} must be an array`);
      return;
    }
    if (shape.item) {
      value.forEach((item, index) =>
        validateShape(shape.item!, item, `${path}[${index}]`, issues));
    }
    return;
  }
  if (shape.valueType !== 'any' && typeof value !== shape.valueType) {
    issues.push(`${path} must be ${shape.valueType}`);
  }
}

export function validateWorkflowOutputShape(
  shape: WorkflowOutputShape,
  data: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  validateShape(shape, data, 'data', issues);
  return issues;
}
