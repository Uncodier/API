import { buildNotificationMessage } from '../notification-details';

describe('notification plain-text details', () => {
  it('preserves full multiline details and omits only absent values', () => {
    const description = 'First line\nSecond line\n' + 'Detailed context. '.repeat(40);
    const message = buildNotificationMessage('Task created', [
      ['Description', description], ['Priority', 0], ['Optional', null],
      ['Missing', undefined], ['Empty', '  '], ['Approved', false],
    ]);
    expect(message).toContain(description.trim());
    expect(message).toContain('Priority: 0');
    expect(message).toContain('Approved: false');
    expect(message).not.toMatch(/Optional:|Missing:|Empty:/);
    expect(message.length).toBeGreaterThan(240);
  });

  it('does not invent details when a notification only supplies its message', () => {
    expect(buildNotificationMessage('Original message', [])).toBe('Original message');
  });
});