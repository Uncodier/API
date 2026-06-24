import { coerceToolArgs } from '../coerce-tool-args';

describe('coerceToolArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      steps: { type: 'array' },
      config: { type: 'object' },
      name: { type: 'string' }
    }
  };

  it('parses stringified array when schema expects array', () => {
    const args = {
      name: 'Test',
      steps: '[{"id":"1"}]'
    };
    const coerced = coerceToolArgs(schema, args);
    expect(Array.isArray(coerced.steps)).toBe(true);
    expect(coerced.steps[0].id).toBe('1');
    expect(coerced.name).toBe('Test');
  });

  it('parses stringified object when schema expects object', () => {
    const args = {
      config: '{"retry":true}'
    };
    const coerced = coerceToolArgs(schema, args);
    expect(typeof coerced.config).toBe('object');
    expect(coerced.config.retry).toBe(true);
  });

  it('ignores invalid JSON strings', () => {
    const args = {
      steps: '[not valid json}'
    };
    const coerced = coerceToolArgs(schema, args);
    expect(coerced.steps).toBe('[not valid json}');
  });

  it('leaves correct arrays/objects intact', () => {
    const args = {
      steps: [{ id: '1' }],
      config: { retry: true }
    };
    const coerced = coerceToolArgs(schema, args);
    expect(coerced).toEqual(args);
  });

  const complexSchema = {
    type: 'object',
    properties: {
      steps: { 
        type: 'array',
        items: {
          type: 'object',
          properties: {
            metadata: { type: 'object' },
            artifacts: { type: 'array' }
          }
        }
      }
    }
  };

  it('handles double-stringified JSON', () => {
    const args = {
      // JSON string that decodes to a JSON string
      steps: '"[{\\"id\\":\\"1\\"}]"'
    };
    const coerced = coerceToolArgs(complexSchema, args);
    expect(Array.isArray(coerced.steps)).toBe(true);
    expect(coerced.steps[0].id).toBe('1');
  });

  it('recurses into items to parse stringified nested fields', () => {
    const args = {
      steps: [
        { 
          metadata: '{"backlog_item_id":"123"}',
          artifacts: '["file.txt"]'
        }
      ]
    };
    const coerced = coerceToolArgs(complexSchema, args);
    expect(typeof coerced.steps[0].metadata).toBe('object');
    expect(coerced.steps[0].metadata.backlog_item_id).toBe('123');
    expect(Array.isArray(coerced.steps[0].artifacts)).toBe(true);
    expect(coerced.steps[0].artifacts[0]).toBe('file.txt');
  });

  it('recurses when both the outer and inner fields are stringified', () => {
    const args = {
      steps: '[{"metadata":"{\\"foo\\":\\"bar\\"}"}]'
    };
    const coerced = coerceToolArgs(complexSchema, args);
    expect(Array.isArray(coerced.steps)).toBe(true);
    expect(typeof coerced.steps[0].metadata).toBe('object');
    expect(coerced.steps[0].metadata.foo).toBe('bar');
  });
});
