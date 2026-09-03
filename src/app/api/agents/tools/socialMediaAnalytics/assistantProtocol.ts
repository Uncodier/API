import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export interface SocialMediaAnalyticsParams {
  content_id?: string;
  outstand_post_id?: string;
  limit?: number;
  refresh?: boolean;
}

function normalizeMetricsByAccount(byAccount: any[]): Array<Record<string, unknown>> {
  if (!Array.isArray(byAccount)) return [];
  return byAccount.map((acc) => {
    const metrics = acc?.metrics || acc || {};
    return {
      network: acc?.social_account?.network || acc?.network || null,
      username: acc?.social_account?.username || acc?.username || null,
      nickname: acc?.social_account?.nickname || acc?.nickname || null,
      likes: metrics.likes || 0,
      comments: metrics.comments || 0,
      shares: metrics.shares || 0,
      views: metrics.views || 0,
      impressions: metrics.impressions || 0,
      reach: metrics.reach || 0,
      engagement_rate: metrics.engagement_rate || 0,
    };
  });
}

async function upsertPerformance(siteId: string, postId: string, analytics: any) {
  const { data: existing } = await supabaseAdmin
    .from('content')
    .select('id')
    .eq('site_id', siteId)
    .contains('tags', [`outstand_id_${postId}`])
    .limit(1)
    .maybeSingle();

  const aggregated = analytics?.aggregated_metrics || {};
  const { error } = await supabaseAdmin.from('content_performance').upsert(
    {
      site_id: siteId,
      outstand_post_id: postId,
      content_id: existing?.id || null,
      likes: aggregated.total_likes || 0,
      comments: aggregated.total_comments || 0,
      shares: aggregated.total_shares || 0,
      views: aggregated.total_views || 0,
      impressions: aggregated.total_impressions || 0,
      reach: aggregated.total_reach || 0,
      engagement_rate: aggregated.average_engagement_rate || 0,
      metrics_by_account: normalizeMetricsByAccount(analytics?.metrics_by_account || []),
      fetched_at: new Date().toISOString(),
    },
    { onConflict: 'site_id,outstand_post_id' }
  );

  if (error) throw error;
}

export function socialMediaAnalyticsTool(site_id: string) {
  return {
    name: 'social_media_analytics',
    description: 'Retrieve performance analytics for social media posts on this site. Reads the latest stored snapshot first. Optionally filter by content_id or outstand_post_id, or pass refresh=true to pull a fresh snapshot for a specific post.',
    parameters: {
      type: 'object',
      properties: {
        content_id: {
          type: 'string',
          description: 'Optional content_id to get analytics for a specific post.',
        },
        outstand_post_id: {
          type: 'string',
          description: 'Optional social post id to get analytics for a specific post.',
        },
        limit: {
          type: 'number',
          description: 'Number of top posts to return if no specific ID is provided (default 10).',
        },
        refresh: {
          type: 'boolean',
          description: 'If true and a post id is provided, fetch the latest metrics and store them before returning.',
        },
      },
      additionalProperties: false,
    },
    execute: async (args: SocialMediaAnalyticsParams) => {
      try {
        let postId = args.outstand_post_id;

        if (args.refresh) {
          if (!postId && args.content_id) {
            const { data: content } = await supabaseAdmin
              .from('content')
              .select('tags')
              .eq('id', args.content_id)
              .eq('site_id', site_id)
              .maybeSingle();
            const tag = (content?.tags || []).find((t: string) => t.startsWith('outstand_id_'));
            postId = tag ? tag.replace('outstand_id_', '') : undefined;
          }

          if (postId) {
            const client = getOutstandClient();
            const analytics = await client.getPostAnalytics(postId, site_id);
            await upsertPerformance(site_id, postId, analytics);
          }
        }

        let query = supabaseAdmin
          .from('content_performance')
          .select('*, content(title, status)')
          .eq('site_id', site_id)
          .order('engagement_rate', { ascending: false });

        if (args.content_id) {
          query = query.eq('content_id', args.content_id);
        } else if (postId) {
          query = query.eq('outstand_post_id', postId);
        } else {
          query = query.limit(args.limit || 10);
        }

        const { data, error } = await query;
        if (error) throw error;
        return { success: true, result: data };
      } catch (error: any) {
        console.error('[socialMediaAnalyticsTool Error]', error);
        return { success: false, error: error.message };
      }
    },
  };
}
