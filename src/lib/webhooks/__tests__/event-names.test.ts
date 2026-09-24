import { buildWebhookEventNames } from '../event-names';

describe('buildWebhookEventNames', () => {
  it.each([
    ['tasks', 'task.created', 'tasks.created'],
    ['leads', 'lead.created', 'leads.created'],
    ['deals', 'deal.created', 'deals.created'],
    ['conversations', 'conversation.created', 'conversations.created'],
    ['quotations', 'quotation.created', 'quotations.created'],
    ['reservations', 'reservation.created', 'reservations.created'],
    ['sales', 'sale.created', 'sales.created'],
  ])(
    'uses a singular canonical name for %s',
    (table, canonical, legacyAlias) => {
      expect(buildWebhookEventNames(table, 'created')).toEqual({
        canonical,
        aliases: [legacyAlias],
      });
    },
  );

  it('does not add an alias when the table name is already canonical', () => {
    expect(buildWebhookEventNames('content', 'updated')).toEqual({
      canonical: 'content.updated',
      aliases: [],
    });
  });
});
