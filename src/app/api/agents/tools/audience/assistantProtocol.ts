/**
 * Assistant Protocol for Audience Tool
 *
 * Build, list, retrieve (paginated), and delete stored lead audiences.
 * Results persist in the `audiences` / `audience_leads` tables and can
 * be consumed page-by-page as context or fed to `sendBulkMessages`.
 */

import { getLeads, type LeadFilters } from '@/lib/database/lead-db';
import {
  createAudience,
  getAudienceById,
  getAudiencesBySite,
  getAudiencePage,
  insertAudienceLeads,
  updateAudience,
  deleteAudience,
} from '@/lib/database/audience-db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudienceToolParams {
  action: 'create' | 'list' | 'get' | 'delete';

  // create
  name?: string;
  description?: string;
  status?: string;
  segment_id?: string;
  campaign_id?: string;
  assignee_id?: string;
  search?: string;
  /** Only pass true when the user explicitly asks to search inside lead notes. */
  search_include_notes?: boolean;
  origin?: string;
  limit?: number;
  page_size?: number;

  // get / delete
  audience_id?: string;
  page?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LEADS = 5000;
const DEFAULT_PAGE_SIZE = 50;
const COLLECT_BATCH = 200;

// ---------------------------------------------------------------------------
// Internal: collect all matching lead IDs (paginated under the hood)
// ---------------------------------------------------------------------------

async function collectLeadIds(
  siteId: string,
  userId: string,
  params: AudienceToolParams,
): Promise<{ leadIds: string[]; total: number }> {
  const leadIds: string[] = [];
  let offset = 0;
  let total = 0;

  const maxLimit = params.limit ? Math.min(params.limit, MAX_LEADS) : MAX_LEADS;

  while (leadIds.length < maxLimit) {
    const filters: LeadFilters = {
      site_id: siteId,
      user_id: userId,
      status: params.status,
      segment_id: params.segment_id,
      campaign_id: params.campaign_id,
      assignee_id: params.assignee_id,
      search: params.search,
      search_include_notes: params.search_include_notes === true,
      limit: Math.min(COLLECT_BATCH, maxLimit - leadIds.length),
      offset,
      sort_by: 'created_at',
      sort_order: 'desc',
    };

    const result = await getLeads(filters);
    total = result.total; // Note: total returned by getLeads is the total matching ignoring limit/offset

    for (const lead of result.leads) {
      if (leadIds.length >= maxLimit) break;
      leadIds.push(lead.id);
    }

    if (!result.hasMore || result.leads.length === 0) break;
    offset += COLLECT_BATCH;
  }

  return { leadIds, total };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function audienceTool(siteId: string, userId: string, instanceId: string) {
  const execute = async (args: AudienceToolParams) => {
    const { action } = args;

    // ---- CREATE ----
    if (action === 'create') {
      if (!args.name) {
        return { success: false, error: 'Missing required field: name' };
      }

      const pageSize = args.page_size ?? DEFAULT_PAGE_SIZE;

      let sqlQuery = `SELECT * FROM leads WHERE site_id = '${siteId}' AND user_id = '${userId}'`;
      if (args.status) sqlQuery += ` AND status = '${args.status}'`;
      if (args.segment_id) sqlQuery += ` AND segment_id = '${args.segment_id}'`;
      if (args.campaign_id) sqlQuery += ` AND campaign_id = '${args.campaign_id}'`;
      if (args.assignee_id) sqlQuery += ` AND assignee_id = '${args.assignee_id}'`;
      if (args.origin) sqlQuery += ` AND origin = '${args.origin}'`;
      if (args.search) {
        const safeSearch = args.search.replace(/'/g, "''");
        if (args.search_include_notes === true) {
          sqlQuery += ` AND (name ILIKE '%${safeSearch}%' OR email ILIKE '%${safeSearch}%' OR notes ILIKE '%${safeSearch}%')`;
        } else {
          sqlQuery += ` AND (name ILIKE '%${safeSearch}%' OR email ILIKE '%${safeSearch}%')`;
        }
      }
      sqlQuery += ` ORDER BY created_at DESC`;
      if (args.limit) sqlQuery += ` LIMIT ${args.limit}`;

      const audience = await createAudience({
        name: args.name,
        description: args.description,
        site_id: siteId,
        user_id: userId,
        instance_id: instanceId,
        filters: {
          status: args.status,
          segment_id: args.segment_id,
          campaign_id: args.campaign_id,
          assignee_id: args.assignee_id,
          search: args.search,
          search_include_notes: args.search_include_notes === true,
          origin: args.origin,
          limit: args.limit,
          sql: sqlQuery,
        },
        page_size: pageSize,
      });

      try {
        const { leadIds, total } = await collectLeadIds(siteId, userId, args);

        if (leadIds.length === 0) {
          await updateAudience(audience.id, { total_count: 0, status: 'ready' });
          return {
            success: true,
            audience_id: audience.id,
            name: audience.name,
            total_count: 0,
            total_pages: 0,
            page_size: pageSize,
            status: 'ready',
            message: 'No leads matched the provided filters.',
          };
        }

        await insertAudienceLeads(audience.id, leadIds, pageSize);

        const totalPages = Math.ceil(leadIds.length / pageSize);
        await updateAudience(audience.id, {
          total_count: leadIds.length,
          status: 'ready',
        });

        const { leads: firstPageLeads } = await getAudiencePage(audience.id, 1);
        const exampleLeads = firstPageLeads.slice(0, 5);

        return {
          success: true,
          audience_id: audience.id,
          name: audience.name,
          total_count: leadIds.length,
          total_matched: total,
          capped: total > MAX_LEADS,
          total_pages: totalPages,
          page_size: pageSize,
          status: 'ready',
          example_leads: exampleLeads,
        };
      } catch (err: any) {
        await updateAudience(audience.id, { status: 'error' });
        return { success: false, error: err?.message ?? 'Unknown error building audience' };
      }
    }

    // ---- LIST ----
    if (action === 'list') {
      const audiences = await getAudiencesBySite(siteId);
      return {
        success: true,
        audiences: audiences.map((a) => ({
          audience_id: a.id,
          name: a.name,
          description: a.description,
          total_count: a.total_count,
          page_size: a.page_size,
          total_pages: Math.ceil(a.total_count / a.page_size),
          status: a.status,
          created_at: a.created_at,
        })),
      };
    }

    // ---- GET (paginated) ----
    if (action === 'get') {
      if (!args.audience_id) {
        return { success: false, error: 'Missing required field: audience_id' };
      }

      const audience = await getAudienceById(args.audience_id);
      if (!audience) return { success: false, error: 'Audience not found' };

      const page = args.page ?? 1;
      const totalPages = Math.ceil(audience.total_count / audience.page_size);

      if (page < 1 || page > totalPages) {
        return { success: false, error: `Invalid page ${page}. Total pages: ${totalPages}` };
      }

      const { leads } = await getAudiencePage(args.audience_id, page);

      return {
        success: true,
        audience_id: audience.id,
        name: audience.name,
        leads,
        page,
        total_pages: totalPages,
        total_count: audience.total_count,
        has_more: page < totalPages,
      };
    }

    // ---- DELETE ----
    if (action === 'delete') {
      if (!args.audience_id) {
        return { success: false, error: 'Missing required field: audience_id' };
      }
      await deleteAudience(args.audience_id);
      return { success: true, message: 'Audience deleted' };
    }

    return { success: false, error: `Invalid action: "${action}"` };
  };

  return {
    name: 'audience',
    description: `Build and manage reusable lead audiences.

Actions:
• create — query leads by filters and store the result as a named audience.
  Required: name. Optional filters: status, segment_id, campaign_id, assignee_id, search (name and email only unless search_include_notes is true), origin, limit (e.g. 10 to only add 10 leads), page_size (default 50).
  Returns audience_id, total_count, total_pages, and example_leads (up to 5 leads).
• list — list all audiences for this site.
• get — retrieve a specific page of leads from an audience.
  Required: audience_id. Optional: page (1-based, default 1).
  Returns paginated lead data with has_more flag.
• delete — remove an audience. Required: audience_id.

Usage tips:
- Create an audience once, then use "get" to iterate pages as context.
- Pass the audience_id to the sendBulkMessages tool to send messages to all leads (use {{lead.*}} merge tokens in the message/subject as documented on sendBulkMessages).
- Maximum ${MAX_LEADS} leads per audience. Use limit or filters to narrow down if needed.
- Audiences persist across conversation turns.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'delete'],
          description: 'Action to perform.',
        },
        name: { type: 'string', description: 'Audience name (required for create).' },
        description: { type: 'string', description: 'Optional description.' },
        status: { type: 'string', description: 'Filter leads by status (new, contacted, qualified, converted, lost).' },
        segment_id: { type: 'string', description: 'Filter leads by segment UUID.' },
        campaign_id: { type: 'string', description: 'Filter leads by campaign UUID.' },
        assignee_id: { type: 'string', description: 'Filter leads by assignee UUID.' },
        search: {
          type: 'string',
          description:
            'Text search in lead name and email. Do not set search_include_notes unless the user explicitly asks to search lead notes.',
        },
        search_include_notes: {
          type: 'boolean',
          description:
            'Set true only when the user explicitly requests searching inside lead notes. Default behavior excludes notes.',
        },
        origin: { type: 'string', description: 'Filter leads by origin.' },
        limit: { type: 'number', description: 'Maximum number of total leads to add to the audience.' },
        page_size: { type: 'number', description: 'Leads per page (default 50, max 100).' },
        audience_id: { type: 'string', description: 'Audience UUID (required for get/delete).' },
        page: { type: 'number', description: 'Page number, 1-based (for get action).' },
      },
      required: ['action'],
    },
    execute,
  };
}
