import { isPublicationLabel, publishedGmailInput, publishedGmailResult } from '../support-public-gmail';

const label = 'Label_12345';
const msg = { labelIds: [label], subject: 'Holiday hours', snippet: 'private text', sender: 'private sender' };
const wrap = (...messages: unknown[]) => ({ successful: true, data: { messages, nextPageToken: 'private cursor' } });

it('pins a metadata-only page to a single custom label', () => {
  expect(publishedGmailInput(label)).toEqual({ label_ids: [label], max_results: 5, ids_only: false, verbose: false,
    include_payload: false, include_spam_trash: false });
  for (const invalid of ['INBOX', 'Label_', '*', label + ' OR in:anywhere', null]) expect(isPublicationLabel(invalid)).toBe(false);
  expect(() => publishedGmailInput('INBOX')).toThrow();
});

it('drops private metadata, ids and the provider cursor', () => {
  expect(publishedGmailResult(wrap(msg), label)).toEqual({ titles: ['Holiday hours'], limited: true });
});

it.each([{}, { ...msg, labelIds: [] }, { ...msg, labelIds: [label, 'TRASH'] }, { ...msg, labelIds: [label, 'DRAFT'] },
  { ...msg, subject: null }])('refuses the whole response on missing or contradictory publication evidence', bad => {
  expect(() => publishedGmailResult(wrap(msg, bad), label)).toThrow('Published titles are unavailable');
});

it('bounds the page and rejects incompatible provider output rather than returning raw content', () => {
  expect(() => publishedGmailResult(wrap(...Array(6).fill(msg)), label)).toThrow();
  expect(() => publishedGmailResult({ data: 'sensitive' }, label)).toThrow();
});

it('requires all supplied label metadata to agree before publishing a subject', () => {
  const snake = { subject: msg.subject, label_ids: [label, 'STARRED'] };
  expect(publishedGmailResult(wrap(snake, { ...snake, labelIds: ['STARRED', label] }), label).titles)
    .toEqual([msg.subject, msg.subject]);
  for (const label_ids of [[], null, [label, 'DRAFT'], ['STARRED']]) {
    expect(() => publishedGmailResult(wrap(msg, { ...msg, label_ids }), label)).toThrow();
  }
});