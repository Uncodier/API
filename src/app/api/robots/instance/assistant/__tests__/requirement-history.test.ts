import { randomBytes, randomUUID } from 'node:crypto';
import { serializedBytes } from '@/lib/harness/engine-results';
import { createRedactor, redactData } from '@/lib/harness/security';
import type { Message } from '@/lib/harness/types';
import { HISTORY_RECEIPT_BUDGET, readRequirementHistory } from '../requirement-history';
import { requirementOperationResult } from '../requirement-operation';

function reader(messages: Message[], redact = createRedactor()) {
  const original = structuredClone(messages);
  // Freeze all canonical data: projection must not strip reasoning or edit calls.
  const freeze = (value: any) => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(messages);
  const callId = randomUUID();
  return (offset: number, limit = 5, contentOffset?: number) => {
    const result = readRequirementHistory({ messages, offset, limit, contentOffset, callId, redact });
    const receipt: Message = { role: 'tool', toolCallId: callId,
      content: JSON.stringify(requirementOperationResult(redactData(result, redact))) };
    expect(serializedBytes(receipt)).toBeLessThanOrEqual(HISTORY_RECEIPT_BUDGET);
    expect(messages).toEqual(original);
    return result.output;
  };
}

describe('bounded requirement history projection (offline)', () => {
  test('242-message nested history is references, not raw reasoning or recursive receipts', () => {
    const reasoning = randomBytes(24).toString('hex');
    const callId = randomUUID();
    let nested: Message = { role: 'assistant', content: 'Old observation', reasoningDetails: [{ text: reasoning }] };
    for (let depth = 0; depth < 8; depth++) nested = { role: 'tool', toolCallId: callId,
      content: JSON.stringify({ ok: true, output: { offset: 0, total: 1, messages: [nested], nextOffset: null } }) };
    const messages: Message[] = [
      { role: 'assistant', content: 'Consult prior context', reasoningDetails: [{ text: reasoning }],
        toolCalls: [{ id: callId, name: 'read_session_history', arguments: JSON.stringify({ offset: 0, thought_process: reasoning }) }] },
      nested,
      ...Array.from({ length: 240 }, (_, index): Message => ({ role: 'assistant', content: `Observation ${index}`,
        reasoningDetails: [{ text: reasoning }] })),
    ];
    const read = reader(messages);
    const indices: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = read(offset, 10);
      expect(page.total).toBe(242);
      expect(page.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(page)).not.toContain(reasoning);
      expect(JSON.stringify(page)).not.toMatch(/reasoningDetails|thought_process/);
      for (const entry of page.messages) {
        indices.push(entry.index);
        expect(entry.reference).toEqual({ source: 'messages', index: entry.index });
        if (entry.index === 1) expect(entry).toEqual({ index: 1, role: 'tool', toolCallId: callId,
          reference: { source: 'messages', index: 1 }, omitted: 'history_result' });
      }
      if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(indices).toEqual(Array.from({ length: 242 }, (_, index) => index));
    // Content paging is not an escape hatch for raw nested history/reasoning.
    expect(read(1, 1, 0).messages[0]).not.toHaveProperty('content');
  });

  test.each([false, true])('orphaned legacy history receipts are references, without a call name (string output: %s)', stringOutput => {
    const reasoning = randomBytes(24).toString('hex');
    const output = { offset: 0, total: 1,
      messages: [{ role: 'assistant', content: '', reasoningDetails: [{ text: reasoning }] }] };
    const read = reader([{ role: 'tool', toolCallId: randomUUID(), content: JSON.stringify({ ok: true,
      output: stringOutput ? JSON.stringify(output) : { ...output, nextOffset: null } }) }]);
    const page = read(0, 1, 0);
    expect(page.messages[0]).toMatchObject({ reference: { source: 'messages', index: 0 }, omitted: 'history_result' });
    expect(JSON.stringify(page)).not.toContain(reasoning);
    expect(page.messages[0]).not.toHaveProperty('content');
  });

  test.each(['x', '\\', '"', '\n', '\u0000', '🧪漢é'])('oversized first item (%j) advances and its entire content remains pageable', unit => {
    const content = `${unit.repeat(360000 / unit.length)}${randomUUID()}`;
    const read = reader([{ role: 'user', content }, { role: 'assistant', content: 'Next observation' }]);
    const first = read(0, 10);
    expect(first.nextOffset).toBe(1);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ index: 0, truncated: true, contentOffset: 0, totalChars: content.length });
    expect(read(first.nextOffset!, 10)).toMatchObject({ nextOffset: null, messages: [{ index: 1, content: 'Next observation' }] });
    let entry = first.messages[0];
    let complete = entry.content!;
    while (entry.nextContentOffset !== null) {
      expect(entry.nextContentOffset).toBeGreaterThan(entry.contentOffset!);
      const offset = entry.nextContentOffset!;
      entry = read(0, 1, offset).messages[0];
      expect(entry.contentOffset).toBe(offset);
      expect(entry.content!.length).toBeGreaterThan(0);
      // JSON escaping must not conceal dangling halves of a Unicode character.
      expect(entry.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      complete += entry.content;
    }
    expect(complete).toBe(content);
  });

  test('measures the final serialized receipt, including JSON quote/backslash expansion', () => {
    const content = '\\"\n'.repeat(35000);
    const source: Message = { role: 'user', content };
    expect(serializedBytes([source])).toBeLessThan(300000);
    expect(serializedBytes({ role: 'tool', toolCallId: 'history', content: JSON.stringify({ ok: true,
      output: { offset: 0, total: 1, messages: [source], nextOffset: null } }) })).toBeGreaterThan(HISTORY_RECEIPT_BUDGET);
    const page = reader([source])(0, 1);
    expect(page.messages[0].truncated).toBe(true);
    expect(page.messages[0].nextContentOffset).toBeGreaterThan(0);
  });

  test('redacts complete strings before slicing across runtime credential boundaries', () => {
    const username = randomBytes(12).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(32).toString('hex');
    const url = new URL('https://history.example.invalid/result');
    url.username = username; url.password = password; url.searchParams.set('access_token', token);
    const content = `${'x'.repeat(360000)} ${url} Bearer ${token}`;
    const redact = createRedactor([username, password, token]);
    const read = reader([{ role: 'tool', content }], redact);
    const pages = [read(0, 1), read(0, 1, 359999), read(0, 1, 360001 + url.protocol.length + 2 + 3)];
    for (const sensitive of [username, password, token]) expect(JSON.stringify(pages)).not.toContain(sensitive);
    expect(pages[1].messages[0].content).toBe(redact(content).slice(359999));
    expect(pages[1].messages[0].content).toContain('[REDACTED]');
  });

  test('small complete tool results and artifact pointers are preserved', () => {
    const complete = JSON.stringify({ ok: false, error: { code: 'KNOWN_FAILURE', message: 'Synthetic failure' },
      output: { value: '🧪 result', nested: ['one', 'two'] } });
    const artifact = { id: randomUUID(), bytes: 500000, chars: 450000 };
    const pointer = JSON.stringify({ ok: true, artifact, truncated: true, excerpt: 'Beginning', tail: 'End' });
    const page = reader([{ role: 'tool', content: complete }, { role: 'tool', content: pointer }])(0);
    expect(page.messages.map(entry => entry.content)).toEqual([complete, pointer]);
    expect(page.messages.every(entry => entry.truncated === undefined)).toBe(true);
    expect(JSON.parse(page.messages[1].content!).artifact).toEqual(artifact);
  });

  test('pages multiple large items without dropping one or repeating the cursor', () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `${index}${'x'.repeat(180000)}` }));
    const read = reader(messages);
    for (let offset = 0; offset < messages.length; offset++) {
      const page = read(offset, 10);
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0].content).toBe(messages[offset].content);
      expect(page.nextOffset).toBe(offset === messages.length - 1 ? null : offset + 1);
    }
  });

  test('oversized metadata cannot block even an empty first item', () => {
    const read = reader([{ role: 'assistant', content: '',
      toolCalls: Array.from({ length: 1000 }, () => ({ id: randomBytes(200).toString('hex'), name: 'read', arguments: '{}' })) },
    { role: 'user', content: 'Next' }]);
    expect(read(0, 10)).toMatchObject({ nextOffset: 1,
      messages: [{ index: 0, content: '', reference: { source: 'messages', index: 0 }, metadataOmitted: true }] });
  });

  test('metadata fitting only an empty excerpt cannot stall the content cursor', () => {
    const callId = randomUUID();
    const base = { index: 0, role: 'tool', reference: { source: 'messages', index: 0 }, content: '',
      truncated: true, contentOffset: 0, totalChars: 1000, nextContentOffset: 0, toolCallId: '' };
    const size = serializedBytes({ role: 'tool', toolCallId: callId, content: JSON.stringify({ ok: true,
      output: { offset: 0, total: 1, messages: [base], nextOffset: null } }) });
    const messages: Message[] = [{ role: 'tool', content: '\u0000'.repeat(1000), toolCallId: 'x'.repeat(HISTORY_RECEIPT_BUDGET - size) }];
    const result = readRequirementHistory({ messages, callId, offset: 0, limit: 1, redact: createRedactor() });
    expect(result.output.messages[0]).toMatchObject({ content: '\u0000'.repeat(1000), metadataOmitted: true });
    expect(result.output.messages[0].nextContentOffset).not.toBe(0);
  });

  test('empty/out-of-range pages terminate; content offsets are redacted UTF-16 boundaries', () => {
    expect(reader([])(0)).toEqual({ offset: 0, total: 0, messages: [], nextOffset: null });
    const read = reader([{ role: 'user', content: '🧪漢é' }]);
    expect(read(1)).toEqual({ offset: 1, total: 1, messages: [], nextOffset: null });
    expect(read(20)).toEqual({ offset: 20, total: 1, messages: [], nextOffset: null });
    expect(read(0, 1, 1).messages[0]).toMatchObject({ content: '🧪漢é', contentOffset: 0, nextContentOffset: null });
    expect(read(0, 1, 999).messages[0]).toMatchObject({ content: '', contentOffset: 4, nextContentOffset: null });
  });
});