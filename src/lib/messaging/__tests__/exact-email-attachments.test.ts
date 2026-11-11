import { validateEmailAttachments } from '@/lib/services/email/email-attachments';

test('validates and retains file bytes and MIME without local path capabilities', () => {
  const attachment = { filename: 'receipt.pdf', content: Buffer.from('synthetic file').toString('base64'), content_type: 'application/pdf' };
  expect(validateEmailAttachments([attachment])).toEqual([attachment]);
});
test.each([
  { filename: '../file', content: 'YQ==' },
  { filename: 'file', content: 'not base64' },
  { filename: 'file', content: 'YQ==', path: '/etc/passwd' },
  { filename: 'file', content: 'YQ==', content_type: 'invalid' },
])('rejects unsafe attachment %j', attachment => {
  expect(() => validateEmailAttachments([attachment])).toThrow();
});
test('bounds combined decoded bytes', () => {
  const content = Buffer.alloc(11 * 1024 * 1024).toString('base64');
  expect(() => validateEmailAttachments([{ filename: 'one', content }, { filename: 'two', content }])).toThrow('20 MB');
});