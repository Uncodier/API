import { NextRequest, NextResponse } from 'next/server';

export interface SchemaColumn {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  notes?: string;
}

export interface TableSchema {
  table_name: string;
  description: string;
  columns: SchemaColumn[];
}

export interface GetSchemaResult {
  success: boolean;
  tables?: TableSchema[];
  error?: string;
}

// Static schema derived from TypeScript DB interfaces and query patterns.
// No DB round-trip needed — returns instantly.
const SCHEMA: TableSchema[] = [
  {
    table_name: 'agents',
    description: 'AI agents configured per site (customer support, sales, data analyst, etc.)',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'name', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'role', data_type: 'text', is_nullable: false, notes: 'e.g. Customer Support, Sales, Data Analyst, Growth Marketer' },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'active | inactive' },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'backstory', data_type: 'text', is_nullable: true },
      { column_name: 'system_prompt', data_type: 'text', is_nullable: true },
      { column_name: 'agent_prompt', data_type: 'text', is_nullable: true },
      { column_name: 'capabilities', data_type: 'jsonb', is_nullable: true },
      { column_name: 'tools', data_type: 'jsonb', is_nullable: true },
      { column_name: 'configuration', data_type: 'jsonb', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'agent_memories',
    description: 'Persistent memory entries stored by agents (notes, search results, etc.)',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'agent_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'type', data_type: 'text', is_nullable: false, notes: 'e.g. assistant_note, search_results' },
      { column_name: 'key', data_type: 'text', is_nullable: false },
      { column_name: 'data', data_type: 'jsonb', is_nullable: false, notes: 'contains content, summary, created_from' },
      { column_name: 'metadata', data_type: 'jsonb', is_nullable: true, notes: 'contains source, instance_id, client_id, project_id, task_id' },
      { column_name: 'command_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'access_count', data_type: 'integer', is_nullable: false },
      { column_name: 'last_accessed', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'campaigns',
    description: 'Marketing campaigns associated with a site',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'title', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'pending | active | paused | completed' },
      { column_name: 'type', data_type: 'text', is_nullable: false, notes: 'e.g. general, email, whatsapp' },
      { column_name: 'priority', data_type: 'text', is_nullable: false, notes: 'low | medium | high' },
      { column_name: 'budget', data_type: 'jsonb', is_nullable: true, notes: '{ currency, allocated, remaining }' },
      { column_name: 'revenue', data_type: 'jsonb', is_nullable: true, notes: '{ actual, currency, estimated, projected }' },
      { column_name: 'due_date', data_type: 'date', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'command_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'commands',
    description: 'Agent task commands — each represents a unit of work dispatched to an agent',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'task', data_type: 'text', is_nullable: false },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'pending | running | completed | failed | cancelled' },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'results', data_type: 'jsonb', is_nullable: true },
      { column_name: 'targets', data_type: 'jsonb', is_nullable: true },
      { column_name: 'tools', data_type: 'jsonb', is_nullable: true },
      { column_name: 'functions', data_type: 'jsonb', is_nullable: true },
      { column_name: 'context', data_type: 'text', is_nullable: true },
      { column_name: 'supervisor', data_type: 'jsonb', is_nullable: true },
      { column_name: 'model', data_type: 'text', is_nullable: true },
      { column_name: 'agent_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'agent_background', data_type: 'text', is_nullable: true },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'input_tokens', data_type: 'integer', is_nullable: true },
      { column_name: 'output_tokens', data_type: 'integer', is_nullable: true },
      { column_name: 'completion_date', data_type: 'timestamptz', is_nullable: true },
      { column_name: 'duration', data_type: 'integer', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'content',
    description: 'Content pieces (blog posts, newsletters, videos, etc.) created for a site',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'title', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'type', data_type: 'text', is_nullable: false, notes: 'blog_post | video | newsletter | social_post | etc.' },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'draft | review | approved | published | archived' },
      { column_name: 'text', data_type: 'text', is_nullable: true },
      { column_name: 'tags', data_type: 'text[]', is_nullable: true },
      { column_name: 'instructions', data_type: 'text', is_nullable: true },
      { column_name: 'segment_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'campaign_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'command_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'author_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'published_at', data_type: 'timestamptz', is_nullable: true },
      { column_name: 'estimated_reading_time', data_type: 'integer', is_nullable: true },
      { column_name: 'word_count', data_type: 'integer', is_nullable: true },
      { column_name: 'seo_score', data_type: 'numeric', is_nullable: true },
      { column_name: 'performance_rating', data_type: 'numeric', is_nullable: true },
      { column_name: 'metadata', data_type: 'jsonb', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'conversations',
    description: 'Chat/email/WhatsApp conversations between leads/visitors and agents',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'title', data_type: 'text', is_nullable: true },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'active | closed' },
      { column_name: 'channel', data_type: 'text', is_nullable: true, notes: 'chat | whatsapp | email | website_chat' },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'lead_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'visitor_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'agent_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'custom_data', data_type: 'jsonb', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'leads',
    description: 'Sales leads / contacts captured for a site',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'name', data_type: 'text', is_nullable: false },
      { column_name: 'email', data_type: 'text', is_nullable: false },
      { column_name: 'personal_email', data_type: 'text', is_nullable: true },
      { column_name: 'phone', data_type: 'text', is_nullable: true },
      { column_name: 'position', data_type: 'text', is_nullable: true },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'new | contacted | qualified | converted | lost' },
      { column_name: 'origin', data_type: 'text', is_nullable: true },
      { column_name: 'notes', data_type: 'text', is_nullable: true },
      { column_name: 'language', data_type: 'text', is_nullable: true },
      { column_name: 'birthday', data_type: 'date', is_nullable: true },
      { column_name: 'last_contact', data_type: 'timestamptz', is_nullable: true },
      { column_name: 'segment_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'campaign_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'command_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'assignee_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'referral_lead_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'company_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'company', data_type: 'jsonb', is_nullable: true },
      { column_name: 'social_networks', data_type: 'jsonb', is_nullable: true },
      { column_name: 'address', data_type: 'jsonb', is_nullable: true },
      { column_name: 'subscription', data_type: 'jsonb', is_nullable: true },
      { column_name: 'attribution', data_type: 'jsonb', is_nullable: true },
      { column_name: 'metadata', data_type: 'jsonb', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'messages',
    description: 'Individual messages within a conversation',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'content', data_type: 'text', is_nullable: false },
      { column_name: 'role', data_type: 'text', is_nullable: false, notes: 'user | assistant | system | visitor | team_member | agent' },
      { column_name: 'interaction', data_type: 'text', is_nullable: true, notes: 'opened | clicked (email tracking)' },
      { column_name: 'conversation_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'lead_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'visitor_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'agent_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'command_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'custom_data', data_type: 'jsonb', is_nullable: true, notes: 'contains origin_message_id, type, task' },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'requirements',
    description: 'Project requirements or feature requests tracked per site',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'title', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'type', data_type: 'text', is_nullable: false, notes: 'task | content | design | research | follow_up | develop' },
      { column_name: 'priority', data_type: 'text', is_nullable: false, notes: 'high | medium | low' },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'validated | in-progress | on-review | done | backlog | canceled' },
      { column_name: 'completion_status', data_type: 'text', is_nullable: false, notes: 'pending | completed | rejected' },
      { column_name: 'source', data_type: 'text', is_nullable: true },
      { column_name: 'instructions', data_type: 'text', is_nullable: true },
      { column_name: 'budget', data_type: 'numeric', is_nullable: true },
      { column_name: 'command_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'segments',
    description: 'Audience segments used to group leads and target campaigns',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'name', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'audience', data_type: 'text', is_nullable: true },
      { column_name: 'language', data_type: 'text', is_nullable: false },
      { column_name: 'url', data_type: 'text', is_nullable: true },
      { column_name: 'size', data_type: 'integer', is_nullable: true },
      { column_name: 'estimated_value', data_type: 'numeric', is_nullable: true },
      { column_name: 'engagement', data_type: 'numeric', is_nullable: true },
      { column_name: 'is_active', data_type: 'boolean', is_nullable: true },
      { column_name: 'analysis', data_type: 'jsonb', is_nullable: true },
      { column_name: 'topics', data_type: 'jsonb', is_nullable: true },
      { column_name: 'icp', data_type: 'jsonb', is_nullable: true, notes: 'Ideal Customer Profile data' },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'sites',
    description: 'Customer sites / workspaces — top-level tenant entity',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'name', data_type: 'text', is_nullable: false },
      { column_name: 'url', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'resource_urls', data_type: 'jsonb', is_nullable: true },
      { column_name: 'competitors', data_type: 'jsonb', is_nullable: true },
      { column_name: 'tracking', data_type: 'jsonb', is_nullable: true },
      { column_name: 'business_hours', data_type: 'jsonb', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'tasks',
    description: 'Follow-up tasks and activities linked to leads or conversations',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'title', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'type', data_type: 'text', is_nullable: false, notes: 'call | meeting | email | demo | quote | contract | payment | follow_up | etc.' },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'pending | in_progress | completed | failed' },
      { column_name: 'stage', data_type: 'text', is_nullable: false },
      { column_name: 'priority', data_type: 'integer', is_nullable: false, notes: '0=low, 1=normal, 5=medium, 10=high, 15=urgent' },
      { column_name: 'notes', data_type: 'text', is_nullable: true },
      { column_name: 'serial_id', data_type: 'text', is_nullable: true },
      { column_name: 'amount', data_type: 'numeric', is_nullable: true },
      { column_name: 'assignee', data_type: 'uuid', is_nullable: true },
      { column_name: 'scheduled_date', data_type: 'timestamptz', is_nullable: true },
      { column_name: 'completed_date', data_type: 'timestamptz', is_nullable: true },
      { column_name: 'lead_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'conversation_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'command_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'address', data_type: 'jsonb', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'audiences',
    description: 'Stored lead audiences built by the assistant for bulk messaging or analysis',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'name', data_type: 'text', is_nullable: false },
      { column_name: 'description', data_type: 'text', is_nullable: true },
      { column_name: 'filters', data_type: 'jsonb', is_nullable: true, notes: 'Query params used to build the audience' },
      { column_name: 'total_count', data_type: 'integer', is_nullable: false },
      { column_name: 'page_size', data_type: 'integer', is_nullable: false },
      { column_name: 'status', data_type: 'text', is_nullable: false, notes: 'building | ready | error' },
      { column_name: 'instance_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'audience_leads',
    description: 'Individual lead references within an audience, with send tracking',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'audience_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'lead_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'page_number', data_type: 'integer', is_nullable: false },
      { column_name: 'send_status', data_type: 'text', is_nullable: false, notes: 'pending | sent | failed | skipped' },
      { column_name: 'sent_at', data_type: 'timestamptz', is_nullable: true },
      { column_name: 'error', data_type: 'text', is_nullable: true },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
  {
    table_name: 'visitors',
    description: 'Anonymous or identified website visitors tracked per site',
    columns: [
      { column_name: 'id', data_type: 'uuid', is_nullable: false },
      { column_name: 'is_identified', data_type: 'boolean', is_nullable: false },
      { column_name: 'traits', data_type: 'jsonb', is_nullable: true },
      { column_name: 'lead_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'segment_id', data_type: 'uuid', is_nullable: true },
      { column_name: 'site_id', data_type: 'uuid', is_nullable: false },
      { column_name: 'created_at', data_type: 'timestamptz', is_nullable: false },
      { column_name: 'updated_at', data_type: 'timestamptz', is_nullable: false },
    ],
  },
];

export function getSchemaCore(site_id: string, user_id: string): GetSchemaResult {
  if (!site_id || !user_id) {
    return { success: false, error: 'site_id and user_id are required' };
  }
  return { success: true, tables: SCHEMA };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { site_id, user_id } = body;

    if (!site_id || !user_id) {
      return NextResponse.json(
        { success: false, error: 'site_id and user_id are required' },
        { status: 400 }
      );
    }

    return NextResponse.json(getSchemaCore(site_id, user_id));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
