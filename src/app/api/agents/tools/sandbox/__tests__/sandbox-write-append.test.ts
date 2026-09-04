import { describe, expect, it } from '@jest/globals';
import { mergeWriteContent } from '../sandbox-fs-write';

describe('sandbox_write_file append', () => {
  it('overwrites by default', () => {
    expect(mergeWriteContent('old vertical\n', '## Educación\n', 'overwrite')).toBe('## Educación\n');
    expect(mergeWriteContent('old vertical\n', '## Educación\n')).toBe('## Educación\n');
  });

  it('appends without clobbering prior verticals', () => {
    expect(mergeWriteContent('## Logística\n- CANACAR\n', '## Educación\n- CANIETI\n', 'append')).toBe(
      '## Logística\n- CANACAR\n## Educación\n- CANIETI\n',
    );
  });

  it('writes incoming content when the file does not exist yet', () => {
    expect(mergeWriteContent(null, '## Logística\n', 'append')).toBe('## Logística\n');
  });
});
