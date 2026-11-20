import { ConnectorError } from './types';

const PAGE_SIZE = 5;
const unavailable = () => new ConnectorError('PUBLICATION_UNAVAILABLE', 'Published titles are unavailable.', 409);

/** System labels such as INBOX are not publication settings. */
export function isPublicationLabel(value: unknown): value is string {
  return typeof value === 'string' && /^Label_[0-9]{1,32}$/.test(value);
}

export function publishedGmailInput(labelId: string): Record<string, unknown> {
  if (!isPublicationLabel(labelId)) throw unavailable();
  return { label_ids: [labelId], max_results: PAGE_SIZE, ids_only: false, verbose: false,
    include_payload: false, include_spam_trash: false };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

/** Accept the executeConnectorTool envelope, never substitute snippets, headers or bodies for a title. */
export function publishedGmailResult(providerResult: unknown, labelId: string): { titles: string[]; limited: boolean } {
  const envelope = record(providerResult);
  if (!isPublicationLabel(labelId) || envelope.successful !== true) throw unavailable();
  const data = record(envelope.data);
  if (!Array.isArray(data.messages) || data.messages.length > PAGE_SIZE) throw unavailable();
  const titles = data.messages.map(item => {
    const message = record(item);
    const labels = Object.hasOwn(message, 'labelIds') ? message.labelIds : message.label_ids;
    if (!Array.isArray(labels) || !labels.every(label => typeof label === 'string') || !labels.includes(labelId)
      || labels.includes('TRASH') || labels.includes('SPAM') || labels.includes('DRAFT') || typeof message.subject !== 'string') throw unavailable();
    // Some metadata versions use snake_case. If both are present neither can contradict publication.
    if (Object.hasOwn(message, 'labelIds') && Object.hasOwn(message, 'label_ids')) {
      const other = message.label_ids;
      if (!Array.isArray(other) || new Set(other).size !== new Set(labels).size || !other.every(value => labels.includes(value))) throw unavailable();
    }
    return message.subject.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 200);
  });
  return { titles: titles.filter(Boolean), limited: Boolean(data.nextPageToken || data.next_page_token || titles.length === PAGE_SIZE) };
}