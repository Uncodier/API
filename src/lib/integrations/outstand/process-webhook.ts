import type { OutstandWebhookPayload } from './webhook-types';
import { supabaseAdmin } from '../../database/supabase-client';

/**
 * Handles verified Outstand webhook events. Keep side effects async-friendly
 * (respond 2xx quickly; queue heavy work elsewhere if needed).
 */
export async function processOutstandWebhookPayload(
  payload: OutstandWebhookPayload
): Promise<void> {
  switch (payload.event) {
    case 'post.published':
      console.log('[Outstand webhook] post.published', {
        postId: payload.data.postId,
        orgId: payload.data.orgId,
        accounts: payload.data.socialAccounts?.length ?? 0,
        timestamp: payload.timestamp,
      });

      // Update content item tags with platform post IDs to link comments back to content
      if (payload.data.postId && payload.data.orgId && payload.data.socialAccounts?.length > 0) {
        try {
          const outstandIdTag = `outstand_id_${payload.data.postId}`;
          
          // Find content item with this outstand ID tag
          const { data: contents, error: searchError } = await supabaseAdmin
            .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
            .from('content')
            .select('id, tags')
            .eq('site_id', payload.data.orgId)
            .contains('tags', [outstandIdTag]);

          if (searchError) {
            console.error('[Outstand webhook] Error finding content item:', searchError);
          } else if (contents && contents.length > 0) {
            const content = contents[0];
            const currentTags = content.tags || [];
            const newTags = new Set(currentTags);
            
            payload.data.socialAccounts.forEach(acc => {
              if (acc.platformPostId) {
                newTags.add(`platform_post_id_${acc.platformPostId}`);
                // Also add a network-specific one just in case
                newTags.add(`platform_post_id_${acc.network}_${acc.platformPostId}`);
              }
            });

            const tagsArray = Array.from(newTags);
            
            if (tagsArray.length > currentTags.length) {
              const { error: updateError } = await supabaseAdmin
                .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
                .from('content')
                .update({ tags: tagsArray })
                .eq('id', content.id);
                
              if (updateError) {
                console.error('[Outstand webhook] Error updating content tags:', updateError);
              } else {
                console.log(`[Outstand webhook] Updated tags for content ${content.id} with platform post IDs`);
              }
            }
          }
        } catch (e) {
          console.error('[Outstand webhook] Exception linking post.published:', e);
        }
      }
      break;
    case 'post.error':
      console.log('[Outstand webhook] post.error', {
        postId: payload.data.postId,
        orgId: payload.data.orgId,
        errors: payload.data.socialAccounts?.map((a) => ({
          network: a.network,
          username: a.username,
          error: a.error,
        })),
        timestamp: payload.timestamp,
      });
      break;
    case 'account.token_expired':
      console.log('[Outstand webhook] account.token_expired', {
        orgId: payload.data.orgId,
        accountId: payload.data.accountId,
        network: payload.data.network,
        username: payload.data.username,
        error: payload.data.error,
        timestamp: payload.timestamp,
      });
      break;
    case 'test':
      console.log('[Outstand webhook] test', {
        message: payload.data.message,
        endpointId: payload.data.endpointId,
        timestamp: payload.timestamp,
      });
      break;
  }
}
