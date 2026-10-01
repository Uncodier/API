import { supabaseAdmin } from '@/lib/database/supabase-client';
import { OUTSTAND_NETWORKS } from '@/lib/integrations/outstand/social-networks';
import { validateSocialMediaAttachment } from '@/app/api/agents/tools/publish/social-media';

type ToolOverrides = Record<string, Record<string, unknown>>;
type RecordValue = Record<string, unknown>;
type MediaType = 'image' | 'video' | 'audio';
interface MediaOutput { type: MediaType; url: string }

export interface PublishNodeBinding {
  toolOverrides: ToolOverrides;
  instruction: string;
}

const MAX_ENTRIES = 20;
const MAX_RESULT_LENGTH = 1_000_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_URL_LENGTH = 8192;
const NODE_COLUMNS = 'id,instance_id,site_id,type,settings,result,status';
const NON_SOCIAL = new Set([
  'blog', 'mail', 'email', 'newsletter', 'whatsapp', 'telegram', 'sms',
  'voice', 'voice-agent-call', 'audio', 'message', 'mensaje',
]);
const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)$/i;
const VIDEO_EXTENSION = /\.(?:mp4|mov|m4v|webm|avi|mkv|mpeg|mpg)$/i;
const AUDIO_EXTENSION = /\.(?:mp3|wav|ogg|aac|m4a|flac)$/i;
const REFERENCE_LABEL = /\b(?:reference|prompt|context|(?:first|last|start|end)[ _-]?frame)\b/i;

function fail(message: string): never {
  throw new Error(`Publish Content binding: ${message}`);
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkedId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
}

function checkedRecord(value: unknown): RecordValue {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (!serialized || serialized.length > MAX_RESULT_LENGTH) fail('Invalid or oversized source data.');
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!isRecord(parsed)) fail('Source data must be an object.');
    return parsed;
  } catch {
    return fail('Invalid or oversized source data.');
  }
}

function mediaType(value: unknown): MediaType | null {
  const type = typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '';
  if (type === 'image' || type === 'generate-image') return 'image';
  if (type === 'video' || type === 'generate-video') return 'video';
  if (type === 'audio' || type === 'generate-audio') return 'audio';
  return null;
}

function expectedTypes(node: RecordValue): MediaType[] {
  const settings = node.settings == null ? {} : checkedRecord(node.settings);
  const values: unknown[] = [node.type, settings.media_type];
  for (const key of ['output_type', 'output_types']) {
    const value = settings[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length > MAX_ENTRIES || !Array.from(value).every(item => typeof item === 'string')) {
        fail('Invalid source output types.');
      }
      values.push(...value);
    } else if (typeof value === 'string') values.push(value);
    else fail('Invalid source output types.');
  }
  return values.map(mediaType).filter((type): type is MediaType => type !== null);
}

function urlType(value: string): MediaType | null {
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  if (VIDEO_EXTENSION.test(pathname)) return 'video';
  if (IMAGE_EXTENSION.test(pathname)) return 'image';
  if (AUDIO_EXTENSION.test(pathname)) return 'audio';
  return null;
}

function checkedMediaUrl(value: unknown, type: MediaType): string {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH
    || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) {
    fail('Invalid Content media URL.');
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || urlType(value) !== type) fail('Invalid Content media URL.');
    // Audio is not sent to the social tool. Image/video reuse its exact preflight.
    return type === 'audio' ? value : validateSocialMediaAttachment(value).url;
  } catch {
    return fail('Invalid Content media URL.');
  }
}

function isReference(output: RecordValue): boolean {
  return ['role', 'purpose', 'source', 'type', 'tool_name'].some(key =>
    typeof output[key] === 'string' && REFERENCE_LABEL.test(output[key] as string));
}

function sourceContent(node: RecordValue): { media: MediaOutput[]; hasText: boolean } {
  if (['running', 'pending', 'failed', 'cancelled', 'stopped'].includes(String(node.status))) {
    fail('The linked Content source is not complete.');
  }
  const result = checkedRecord(node.result);
  if (['running', 'streaming', 'failed', 'cancelled'].includes(String(result.status)) || result.error) {
    fail('The linked Content result is not complete.');
  }
  if (result.text !== undefined && (typeof result.text !== 'string' || result.text.length > MAX_TEXT_LENGTH)) {
    fail('Invalid or oversized Content text.');
  }
  const text = typeof result.text === 'string' ? result.text : '';
  const hasText = text.replace(/[\u0000-\u0020\u007f\u200b-\u200d\ufeff]/g, '').length > 0;
  const expected = expectedTypes(node);
  let media: MediaOutput[] = [];
  if (result.outputs !== undefined && !Array.isArray(result.outputs)) fail('Invalid Content outputs.');
  const outputs: unknown[] = Array.isArray(result.outputs) ? result.outputs : [];
  if (outputs.length > MAX_ENTRIES) fail('Too many Content outputs.');
  const candidates: Array<{ type: MediaType; url: unknown }> = [];
  for (const output of outputs) {
    if (!isRecord(output) || typeof output.type !== 'string') fail('Invalid Content output.');
    const type = mediaType(output.type);
    if (!type || isReference(output)) continue;
    if (output.data !== undefined && !isRecord(output.data)) fail('Invalid Content output data.');
    const data = isRecord(output.data) ? output.data : {};
    candidates.push({ type, url: data.url ?? output.url });
  }
  if (candidates.length) {
    // A video result can retain image references. Never publish those as photos.
    const selected = candidates.some(item => item.type === 'video')
      ? candidates.filter(item => item.type === 'video') : candidates;
    media = selected.map(item => ({ type: item.type, url: checkedMediaUrl(item.url, item.type) }));
  } else if (outputs.length === 0) {
    // Legacy results only: do not recursively inspect prompts, metadata or references.
    const links = /!?\[([^\]\n]*)\]\(\s*(https?:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = links.exec(text)) !== null) {
      if (REFERENCE_LABEL.test(match[1])) continue;
      const type = urlType(match[2]);
      if (!type) continue;
      if (media.length >= MAX_ENTRIES) fail('Too many Content media URLs.');
      media.push({ type, url: checkedMediaUrl(match[2], type) });
    }
    if (media.some(item => item.type === 'video')) media = media.filter(item => item.type === 'video');
  }
  if (expected.includes('video') && !media.some(item => item.type === 'video')) {
    fail('The linked video Content requires a completed video output URL.');
  }
  if (expected.length && !media.length) fail('The linked media Content has no completed output URL.');
  if (!media.length && !hasText) fail('The linked Content source is empty.');
  return { media, hasText };
}

function savedSocialDestinations(node: RecordValue): string[] {
  const settings = checkedRecord(node.settings);
  const destinations = settings.publish_destinations;
  if (!Array.isArray(destinations) || destinations.length > MAX_ENTRIES) {
    fail('Invalid saved publish destinations.');
  }
  const socials: string[] = [];
  for (const value of destinations) {
    if (typeof value !== 'string' || !value.trim() || value.length > 100
      || /[\u0000-\u001f\u007f]/.test(value)) fail('Invalid saved publish destination.');
    const destination = value.trim().toLowerCase();
    if (NON_SOCIAL.has(destination)) continue;
    if (!Object.prototype.hasOwnProperty.call(OUTSTAND_NETWORKS, destination)) {
      fail('Unknown saved social destination.');
    }
    // Keep network selectors; live, site-scoped account resolution owns identities.
    socials.push(destination);
  }
  return Array.from(new Set(socials));
}

/** Internal server boundary: the caller must already have authorized the site and instance. */
export async function resolvePublishNodeBinding(params: {
  instanceNodeId?: string;
  instanceId: string;
  siteId: string;
  toolOverrides?: ToolOverrides;
}): Promise<PublishNodeBinding | null> {
  if (params.instanceNodeId === undefined) return null;
  if (![params.instanceNodeId, params.instanceId, params.siteId].every(checkedId)) {
    fail('An authorized node, instance and site scope is required.');
  }
  const { instanceNodeId, instanceId, siteId } = params;
  const target = await supabaseAdmin.from('instance_nodes').select(NODE_COLUMNS)
    .eq('id', instanceNodeId).eq('instance_id', instanceId).eq('site_id', siteId).maybeSingle();
  const node: unknown = target.data;
  if (target.error || !isRecord(node) || node.id !== instanceNodeId
    || node.instance_id !== instanceId || node.site_id !== siteId) {
    fail('The node does not belong to the requested site and instance.');
  }
  if (node.type !== 'publish') return null;
  const socialAccounts = savedSocialDestinations(node);
  const refs = await supabaseAdmin.from('instance_node_contexts')
    .select('target_node_id,context_node_id,type,site_id')
    .eq('target_node_id', instanceNodeId).eq('site_id', siteId).eq('type', 'content')
    .order('created_at', { ascending: true }).limit(MAX_ENTRIES + 1);
  if (refs.error || !Array.isArray(refs.data) || !refs.data.length || refs.data.length > MAX_ENTRIES) {
    fail('Connect between 1 and 20 valid Content sources; generic Context is not Content.');
  }
  const ids: string[] = [];
  for (const ref of refs.data as unknown[]) {
    if (!isRecord(ref) || ref.target_node_id !== instanceNodeId || ref.site_id !== siteId
      || ref.type !== 'content' || !checkedId(ref.context_node_id)
      || ref.context_node_id === instanceNodeId || ids.includes(ref.context_node_id)) {
      fail('Invalid or out-of-scope Content reference.');
    }
    ids.push(ref.context_node_id);
  }
  const sources = await supabaseAdmin.from('instance_nodes').select(NODE_COLUMNS)
    .in('id', ids).eq('instance_id', instanceId).eq('site_id', siteId).limit(MAX_ENTRIES + 1);
  if (sources.error || !Array.isArray(sources.data) || sources.data.length !== ids.length) {
    fail('Every Content source must exist in the requested site and instance.');
  }
  const media: MediaOutput[] = [];
  for (const id of ids) {
    const source: unknown = sources.data.find((entry: RecordValue) => entry?.id === id);
    if (!isRecord(source) || source.site_id !== siteId || source.instance_id !== instanceId) {
      fail('Invalid or out-of-scope Content source.');
    }
    media.push(...sourceContent(source).media);
    if (media.length > MAX_ENTRIES) fail('At most 20 Content media URLs are allowed.');
  }
  const selected = media.some(item => item.type === 'video') ? media.filter(item => item.type === 'video') : media;
  if (socialAccounts.length && selected.some(item => item.type === 'audio')) {
    fail('Social Content must use image or video outputs, not audio attachments.');
  }
  const mediaUrls = Array.from(new Set(selected.map(item => item.url)));
  if (socialAccounts.includes('tiktok') && !mediaUrls.length) fail('TikTok Content requires an image or video output.');
  const publish = { ...params.toolOverrides?.publish };
  if (!socialAccounts.length) {
    // An empty array is rejected by publish. The router must disallow adding social targets.
    delete publish.social_accounts;
    delete publish.tiktok;
  }
  return {
    toolOverrides: {
      ...params.toolOverrides,
      publish: {
        ...publish,
        ...(socialAccounts.length ? { social_accounts: socialAccounts, media_urls: mediaUrls, assets: [], urls: [] } : {}),
      },
    },
    instruction: 'PUBLISH CONTENT CONTRACT: Only persisted Content links are publishable. '
      + 'Content output URLs and saved social destinations are authoritative and enforced by the server. '
      + 'Reference images, prompt attachments, generation inputs, generic Context and global assets are not publishable Content. '
      + (!socialAccounts.length ? 'No social destinations are selected; do not publish to social accounts. ' : '')
      + (selected.some(item => item.type === 'video') ? 'Publish only the selected video outputs, never their reference images. ' : '')
      + 'Use the linked Content result to write the caption; do not invent or substitute media or destinations. '
      + 'Preserve explicit TikTok options and test/audience settings; account identities are resolved server-side.',
  };
}