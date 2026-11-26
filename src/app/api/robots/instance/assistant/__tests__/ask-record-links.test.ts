import { randomUUID } from 'node:crypto';
import { linkedAskRecordIds } from '@/lib/services/robot-instance/ask-record-links';

const a = randomUUID(), b = randomUUID();
const path = `/records/${a}`;
const url = `https://app.makinari.com${path}`;

test('resolves multiple native links in order, including Markdown and relative links', () => {
  expect(linkedAskRecordIds(`Compare [first](${url})\n<${url}> and /records/${b.toUpperCase()}/.`)).toEqual([a,b]);
  expect(linkedAskRecordIds(url)).toEqual([a]);
});

test.each([`https://another.example${path}`, `//another.example${path}`, `https://app.makinari.com.example${path}`,
  `http://app.makinari.com${path}`, `https://app.makinari.com:3000${path}`, `https://another.example?next=${url}`,
  `https://app.makinari.com@another.example${path}`, `${url}/other`, `${url}?private=1`, `${url}#other`,
  `${url}0`, `${url}.example`, `unrelated ${a}`])('does not treat arbitrary text or URLs as a Record source', value => {
  expect(linkedAskRecordIds(value)).toEqual([]);
});

test('rejects too many distinct sources instead of silently dropping any', () => {
  const links = Array.from({length:8}, () => `/records/${randomUUID()}`);
  expect(linkedAskRecordIds([...links,links[0]].join('\n'))).toHaveLength(8);
  expect(() => linkedAskRecordIds([...links,path].join('\n'))).toThrow(RangeError);
});
