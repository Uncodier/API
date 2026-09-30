import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { getNextJsCorsConfig } from '../../../cors.config.js';

describe('static CORS configuration', () => {
  it('leaves origin selection to request middleware instead of overwriting origins', () => {
    const rules = getNextJsCorsConfig();
    expect(rules.map(rule => rule.source)).toEqual(['/api/:path*', '/record']);
    for (const rule of rules) {
      expect(rule.headers.some(header => header.key === 'Access-Control-Allow-Origin')).toBe(false);
      expect(rule.headers).toEqual(expect.arrayContaining([
        { key: 'Access-Control-Allow-Headers', value: expect.stringContaining('X-Visitor-Session-Token') },
        { key: 'Access-Control-Expose-Headers', value: expect.stringContaining('Retry-After') },
        { key: 'Vary', value: 'Origin' },
      ]));
    }
  });

  it('does not reintroduce static origin overrides in Next configuration', () => {
    // Do not import Next config: it loads build plugins and developer environment.
    const config = fs.readFileSync(path.join(process.cwd(), 'next.config.mjs'), 'utf8');
    expect(config).not.toContain("key: 'Access-Control-Allow-Origin'");
    expect(config).not.toContain("key: 'Access-Control-Allow-Headers'");
  });
});