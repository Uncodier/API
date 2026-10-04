/** ImapFlow returns false for an unsuccessful search, not an empty mailbox. */
export function requireImapSearchResults(result: number[] | false): number[] {
  if (result === false) {
    throw new Error('IMAP search failed or no mailbox is selected');
  }
  return result;
}