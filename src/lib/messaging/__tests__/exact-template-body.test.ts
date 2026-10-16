import { canonicalExactTemplateBody } from '../exact-template-body';
test('canonicalizes multiline whitespace without changing content', () => {
  expect(canonicalExactTemplateBody('Hello\n\n {{1}}  —\tCafe\u0301')).toBe('Hello {{1}} — Café');
});
test('rejects destructive prefixing or truncation instead of silently changing campaign text', () => {
  expect(() => canonicalExactTemplateBody('Hi')).toThrow();
  expect(() => canonicalExactTemplateBody('a'.repeat(1001))).toThrow();
});