/** Extract explicit native Record links from the submitted user message only.
 * These are lookup keys, never grants and never network fetch targets. */
const uuid = '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}';
const recordLink = new RegExp(
  `(?:^|[\\s(<\\["'\x60])(?:https://app\\.makinari\\.com)?/records/(${uuid})/?(?=$|[\\s)>\\]"'\x60]|[.,;:!](?=$|\\s))`, 'g',
);

export function linkedAskRecordIds(message: string): string[] {
  const ids = new Set<string>();
  for (const match of message.matchAll(recordLink)) {
    ids.add(match[1].toLowerCase());
    if (ids.size > 8) throw new RangeError('Reference at most eight distinct Records per Ask turn.');
  }
  return [...ids];
}
