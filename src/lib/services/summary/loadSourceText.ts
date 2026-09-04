import { supabaseAdmin } from '@/lib/database/supabase-client';

export const SUPPORTED_COLLECTIONS = ['records', 'catalog_items'] as const;
export type SummaryCollection = (typeof SUPPORTED_COLLECTIONS)[number];

export class UnsupportedCollectionError extends Error {
  constructor(collection: string) {
    super(`Unsupported collection for source loading: ${collection}`);
    this.name = 'UnsupportedCollectionError';
    Object.setPrototypeOf(this, UnsupportedCollectionError.prototype);
  }
}

function isSupportedCollection(collection: string): collection is SummaryCollection {
  return (SUPPORTED_COLLECTIONS as readonly string[]).includes(collection);
}

function appendScalarData(text: string, data: unknown): string {
  if (!data || typeof data !== 'object') return text;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') {
      lines.push(`- ${key}: ${value}`);
    }
  }
  if (lines.length === 0) return text;
  return `${text}Data:\n${lines.join('\n')}\n`;
}

async function resolveRelationLine(relType: string, relId: string): Promise<string> {
  try {
    if (relType === 'lead' || relType === 'leads') {
      const { data } = await supabaseAdmin
        .from('leads')
        .select('name, company, status')
        .eq('id', relId)
        .single();
      if (data) {
        return `- Linked to Lead: ${data.name || 'Unknown'} (Company: ${data.company || 'N/A'}, Status: ${data.status || 'N/A'})`;
      }
    } else if (relType === 'company' || relType === 'companies') {
      const { data } = await supabaseAdmin
        .from('companies')
        .select('name, industry')
        .eq('id', relId)
        .single();
      if (data) {
        return `- Linked to Company: ${data.name || 'Unknown'} (Industry: ${data.industry || 'N/A'})`;
      }
    } else if (relType === 'sales_order' || relType === 'orders') {
      const { data } = await supabaseAdmin
        .from('orders')
        .select('order_number, total, status')
        .eq('id', relId)
        .single();
      if (data) {
        return `- Linked to Sales Order: ${data.order_number || 'Unknown'} (Total: ${data.total || 0}, Status: ${data.status || 'N/A'})`;
      }
    } else if (relType === 'deal' || relType === 'deals') {
      const { data } = await supabaseAdmin
        .from('deals')
        .select('title, value, stage')
        .eq('id', relId)
        .single();
      if (data) {
        return `- Linked to Deal: ${data.title || 'Unknown'} (Value: ${data.value || 0}, Stage: ${data.stage || 'N/A'})`;
      }
    } else if (relType === 'campaign' || relType === 'campaigns') {
      const { data } = await supabaseAdmin
        .from('campaigns')
        .select('name, status')
        .eq('id', relId)
        .single();
      if (data) {
        return `- Linked to Campaign: ${data.name || 'Unknown'} (Status: ${data.status || 'N/A'})`;
      }
    }
  } catch {
    // Fall through to the generic line
  }

  return `- Linked to ${relType} (ID: ${relId})`;
}

async function loadRecordSourceText(id: string): Promise<string> {
  const { data: record, error } = await supabaseAdmin
    .from('records')
    .select('*, category:record_categories(*)')
    .eq('id', id)
    .single();

  if (error || !record) throw new Error(`Record not found: ${id}`);

  let text = `Title: ${record.title}\n`;
  if (record.description) text += `Description: ${record.description}\n`;
  if (record.category?.name) text += `Category: ${record.category.name}\n`;
  text = appendScalarData(text, record.data);

  if (record.relations && typeof record.relations === 'object') {
    const lines: string[] = [];
    for (const [relType, relId] of Object.entries(record.relations)) {
      if (typeof relId === 'string' && relId) {
        lines.push(await resolveRelationLine(relType, relId));
      }
    }
    if (lines.length > 0) {
      text += `Relations:\n${lines.join('\n')}\n`;
    }
  }

  return text;
}

async function loadCatalogItemSourceText(id: string): Promise<string> {
  const { data: item, error } = await supabaseAdmin
    .from('catalog_items')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !item) throw new Error(`Catalog item not found: ${id}`);

  let text = `Name: ${item.name}\n`;
  if (item.description) text += `Description: ${item.description}\n`;
  if (item.kind) text += `Kind: ${item.kind}\n`;
  return text;
}

/**
 * Collection-agnostic compact source text for summarization.
 * Clients send { collection, id } so long payloads stay server-side.
 */
export async function loadSourceText(collection: string, id: string): Promise<string> {
  if (!isSupportedCollection(collection)) {
    throw new UnsupportedCollectionError(collection);
  }

  if (collection === 'records') {
    return loadRecordSourceText(id);
  }

  return loadCatalogItemSourceText(id);
}
