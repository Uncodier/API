import { supabaseAdmin } from '@/lib/database/supabase-client';
import { normalizeReportSections, type ReportSection } from './dailyStandupReportSections';

export type ReportDataset = {
  rows: Record<string, unknown>[];
  sampled_count: number;
  truncated: boolean;
  window: string;
};
export type WrapUpInputs = {
  reportSections: ReportSection[];
  prevDayRange: { start: string; end: string };
  sections: Partial<Record<ReportSection, Record<string, ReportDataset>>>;
};

const LIMIT = 200;

function previousDayRange() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function dataset(rows: Record<string, unknown>[], window: string): ReportDataset {
  return { rows: rows.slice(0, LIMIT), sampled_count: Math.min(rows.length, LIMIT), truncated: rows.length > LIMIT, window };
}

/** Explicit columns only: no credentials, arbitrary JSON, linked sections or memories. */
async function readRows(query: any, window: string): Promise<ReportDataset> {
  const { data, error } = await query.limit(LIMIT + 1);
  if (error) throw new Error('Could not retrieve selected Daily Standup data');
  return dataset(data || [], window);
}

export async function getWrapUpInputs(siteId: string, selection?: unknown): Promise<WrapUpInputs> {
  const reportSections = normalizeReportSections(selection);
  const { start, end } = previousDayRange();
  const sections: WrapUpInputs['sections'] = {};
  const recent = (table: string, columns: string) => supabaseAdmin.from(table).select(columns)
    .eq('site_id', siteId).gte('created_at', start).lt('created_at', end)
    .order('created_at', { ascending: false });
  const snapshot = (table: string, columns: string) => supabaseAdmin.from(table).select(columns)
    .eq('site_id', siteId).order('created_at', { ascending: false });

  await Promise.all(reportSections.map(async section => {
    switch (section) {
      case 'sales': {
        const [sales, leads] = await Promise.all([
          readRows(recent('sales', 'id,title,status,amount,currency,created_at'), 'created_previous_day_utc'),
          readRows(recent('leads', 'id,name,status,created_at'), 'created_previous_day_utc'),
        ]);
        sections.sales = { sales, leads };
        break;
      }
      case 'tasks':
        sections.tasks = { tasks: await readRows(recent('tasks',
          'id,title,status,priority,scheduled_date,completed_date,created_at'), 'created_previous_day_utc') };
        break;
      case 'requirements':
        sections.requirements = { requirements: await readRows(recent('requirements',
          'id,title,status,priority,completion_status,created_at'), 'created_previous_day_utc') };
        break;
      case 'social': {
        // The provider sync persists cumulative snapshots; these are NOT daily metric deltas.
        const [social_posts, performance] = await Promise.all([
          readRows(snapshot('content', 'id,title,status,published_at,created_at')
            .eq('type', 'social_post'), 'current_local_social_posts'),
          readRows(supabaseAdmin.from('content_performance')
            .select('id,content_id,outstand_post_id,likes,comments,shares,views,impressions,reach,fetched_at')
            .eq('site_id', siteId).order('fetched_at', { ascending: false }), 'cached_cumulative_social_metrics_not_daily_deltas'),
        ]);
        sections.social = { social_posts, performance };
        break;
      }
      case 'channels': {
        const { data, error } = await supabaseAdmin.from('settings').select('channels')
          .eq('site_id', siteId).order('created_at', { ascending: false }).limit(1);
        if (error) throw new Error('Could not retrieve selected channel settings');
        const channels = data?.[0]?.channels;
        const rows: Record<string, unknown>[] = [];
        for (const name of ['email', 'agent_email', 'agent_mail', 'agent', 'whatsapp', 'agent_whatsapp']) {
          const config = channels?.[name];
          if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
          rows.push({ channel: name,
            ...(typeof config.status === 'string' ? { status: config.status } : {}),
            ...(typeof config.enabled === 'boolean' ? { enabled: config.enabled } : {}),
          });
        }
        for (const connection of Array.isArray(channels?.connections) ? channels.connections : []) {
          if (!connection || typeof connection !== 'object') continue;
          rows.push({
            ...(typeof connection.type === 'string' ? { channel: connection.type } : {}),
            ...(typeof connection.status === 'string' ? { status: connection.status } : {}),
            ...(typeof connection.enabled === 'boolean' ? { enabled: connection.enabled } : {}),
          });
        }
        sections.channels = { configuration: dataset(rows, 'current_configuration_not_delivery_health') };
        break;
      }
      case 'records':
        sections.records = { records: await readRows(recent('records',
          'id,title,status,created_at'), 'created_previous_day_utc') };
        break;
      case 'orders':
        sections.orders = { orders: await readRows(recent('sale_orders',
          'id,order_number,status,total,currency,created_at'), 'created_previous_day_utc') };
        break;
      case 'reservations': {
        // No direct site_id contract: require an inner catalog-item tenant join.
        const query = supabaseAdmin.from('reservations')
          .select('id,status,start_time,end_time,quantity,catalog_items!inner(site_id)')
          .eq('catalog_items.site_id', siteId).gte('start_time', start).lt('start_time', end)
          .order('start_time', { ascending: false });
        const reservations = await readRows(query, 'started_previous_day_utc');
        reservations.rows = reservations.rows.map(({ catalog_items, ...row }) => row);
        sections.reservations = { reservations };
        break;
      }
      case 'inventory':
        // Confirmed by the Inventory module. No order/reservation joins or inferred movements.
        sections.inventory = { inventory_levels: await readRows(snapshot('inventory_levels',
          'id,catalog_item_id,location_id,quantity,updated_at,catalog_items!inner(name,sku,site_id)')
          .eq('catalog_items.site_id', siteId), 'current_inventory_quantities_not_daily_movements') };
        break;
    }
  }));

  return { reportSections, prevDayRange: { start, end }, sections };
}