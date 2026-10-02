import { supabaseAdmin } from '@/lib/database/supabase-client';
import { authorizeCommentAccount } from './ownership';
import { commentConversationId, conversationMetadata, record, safePreviewUrl, sameCommentScope, SocialCommentError, text } from './metadata';

export async function ensureCommentConversation(params: {
  siteId: string; metadata: Record<string, any>; conversationId?: string; leadId?: string; agentId?: string;
}) {
  const { siteId, metadata, leadId, agentId } = params;
  const id = commentConversationId(siteId, metadata);
  if (params.conversationId && params.conversationId !== id) {
    throw new SocialCommentError('Comment conversation does not match the site/account/post/author scope');
  }
  const owned = await authorizeCommentAccount(siteId, metadata);
  metadata.publisher_username = owned.username;
  if (owned.platformPostId) metadata.platform_post_id = owned.platformPostId;
  metadata.platform_post_url = safePreviewUrl(metadata.platform_post_url);
  if (metadata.content_id) {
    const { data: content, error } = await supabaseAdmin.from('content')
      .select('id, title, text, metadata').eq('site_id', siteId).eq('id', metadata.content_id).maybeSingle();
    if (error) throw new SocialCommentError('Comment post preview is unavailable', 503);
    const contentMetadata = record(content?.metadata);
    if (content && (contentMetadata.outstand_post_id === metadata.outstand_post_id
      || (Array.isArray(contentMetadata.outstand_post_ids) && contentMetadata.outstand_post_ids.includes(metadata.outstand_post_id)))) {
      metadata.post_title = text(content.title).slice(0, 200);
      metadata.post_text = text(content.text).slice(0, 2000);
    } else delete metadata.content_id;
  }
  const load = () => supabaseAdmin.from('conversations').select('id, site_id, custom_data')
    .eq('site_id', siteId).eq('id', id).maybeSingle();
  const existing = await load();
  if (existing.error) throw new SocialCommentError('Comment conversation lookup failed', 503);
  if (existing.data) {
    if (!sameCommentScope(record(existing.data.custom_data), metadata)) throw new SocialCommentError('Stored comment conversation scope mismatch');
    return id;
  }
  const { data: site, error: siteError } = await supabaseAdmin.from('sites')
    .select('user_id').eq('id', siteId).single();
  if (siteError || !site?.user_id) throw new SocialCommentError('Comment site is unavailable', 503);
  const { error } = await supabaseAdmin.from('conversations').insert({
    id, site_id: siteId, user_id: site.user_id, channel: metadata.network, status: 'active',
    ...(leadId ? { lead_id: leadId } : {}), ...(agentId ? { agent_id: agentId } : {}),
    title: metadata.post_title || 'Social post comments', custom_data: conversationMetadata(metadata),
  });
  if (error) {
    if (error.code !== '23505') throw new SocialCommentError('Comment conversation could not be created', 503);
    const winner = await load();
    if (winner.error || !winner.data || !sameCommentScope(record(winner.data.custom_data), metadata)) {
      throw new SocialCommentError('Comment conversation conflict could not be resolved', 503);
    }
  }
  return id;
}

export async function bindCommentAgent(siteId: string, conversationId: string, agentId: string) {
  const { error } = await supabaseAdmin.from('conversations').update({ agent_id: agentId })
    .eq('id', conversationId).eq('site_id', siteId).is('agent_id', null);
  if (error) throw new SocialCommentError('Comment agent could not be linked', 503);
}