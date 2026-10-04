import { requireImapSearchResults } from '../imap-search-results';

describe('IMAP search results', () => {
  it('preserves message identifiers', () => {
    const identifiers = [4, 8, 12];
    expect(requireImapSearchResults(identifiers)).toBe(identifiers);
  });

  it('accepts a successful search with no matches', () => {
    expect(requireImapSearchResults([])).toEqual([]);
  });

  it('does not report a failed search as an empty mailbox or successful deletion', () => {
    expect(() => requireImapSearchResults(false)).toThrow('IMAP search failed');
  });
});