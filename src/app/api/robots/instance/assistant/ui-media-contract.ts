import { supabaseAdmin } from '@/lib/database/supabase-client';
import { fetchNodeContexts } from '@/lib/services/robot-instance/assistant-logging';

export type UiMediaOutputType = 'image' | 'video' | 'audio' | 'text';

type ToolOverrides = Record<string, Record<string, unknown>>;

interface ContextEntry {
  context_node_id: string;
  type: string | null;
  node: any;
}

export interface UiMediaContract {
  outputType: UiMediaOutputType;
  requiredTool: 'generate_image' | 'generate_video' | 'generate_audio' | null;
  toolOverrides: ToolOverrides;
  instruction: string;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function parseContext(contextString?: string): Record<string, any> {
  if (!contextString) return {};
  try {
    return record(JSON.parse(contextString));
  } catch {
    return {};
  }
}

function outputType(value: unknown): UiMediaOutputType | null {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replaceAll('_', '-')
    : '';
  if (normalized === 'image' || normalized === 'generate-image') return 'image';
  if (normalized === 'video' || normalized === 'generate-video') return 'video';
  if (normalized === 'audio' || normalized === 'generate-audio') return 'audio';
  if (normalized === 'text' || normalized === 'prompt' || normalized === 'response') return 'text';
  return null;
}

function extractImageUrls(node: any): string[] {
  const rawResult = node?.result;
  const result = typeof rawResult === 'string'
    ? (() => {
        try {
          return JSON.parse(rawResult);
        } catch {
          return {};
        }
      })()
    : record(rawResult);

  const urls = Array.isArray(result.outputs)
    ? result.outputs
        .filter((item: any) => item?.type === 'image')
        .map((item: any) => item?.data?.url ?? item?.url)
        .filter((url: unknown): url is string => typeof url === 'string' && url.length > 0)
    : [];

  const prompt = record(node?.prompt);
  if (Array.isArray(prompt.attachments)) {
    urls.push(...prompt.attachments.filter(
      (url: unknown): url is string =>
        typeof url === 'string' && /^https?:\/\//i.test(url),
    ));
  }
  return Array.from(new Set(urls));
}

function contextRole(value: unknown): 'start' | 'end' | 'reference' {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';
  if (['inicio', 'start', 'first', 'first_frame'].includes(normalized)) return 'start';
  if (['fin', 'end', 'last', 'last_frame'].includes(normalized)) return 'end';
  return 'reference';
}

function aspectRatio(parameters: Record<string, any>): string | undefined {
  const value = parameters.aspect_ratio ?? parameters.aspectRatio ?? parameters.ratio;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function duration(parameters: Record<string, any>): number | undefined {
  const value = parameters.duration_seconds ?? parameters.durationSeconds ?? parameters.duration;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function imageQuality(parameters: Record<string, any>): 'standard' | 'hd' | undefined {
  if (parameters.quality === 'standard' || parameters.quality === 'hd') {
    return parameters.quality;
  }
  return typeof parameters.quality === 'number' && Number.isFinite(parameters.quality)
    ? parameters.quality >= 85 ? 'hd' : 'standard'
    : undefined;
}

function videoQuality(parameters: Record<string, any>): 'preview' | 'standard' | 'pro' | undefined {
  if (['preview', 'standard', 'pro'].includes(parameters.quality)) {
    return parameters.quality;
  }
  if (parameters.resolution === '1080p') return 'pro';
  if (parameters.resolution === '720p') return 'standard';
  return undefined;
}

function audioFormat(parameters: Record<string, any>): 'mp3' | 'wav' | 'ogg' | undefined {
  const value = typeof parameters.format === 'string'
    ? parameters.format.trim().toLowerCase()
    : '';
  if (value === 'mp3' || value === 'wav' || value === 'ogg') return value;
  return value === 'aac' ? 'mp3' : undefined;
}

function restrictMediaOverrides(
  current: ToolOverrides | undefined,
  requiredTool: UiMediaContract['requiredTool'],
): ToolOverrides {
  const mediaTools = new Set(['generate_image', 'generate_video', 'generate_audio']);
  return Object.fromEntries(
    Object.entries(current ?? {}).filter(([toolName]) =>
      !mediaTools.has(toolName) || toolName === requiredTool),
  );
}

function mergeOverrides(
  current: ToolOverrides | undefined,
  toolName: string,
  enforced: Record<string, unknown>,
): ToolOverrides {
  return {
    ...current,
    [toolName]: {
      ...(current?.[toolName] ?? {}),
      ...enforced,
    },
  };
}

export function buildUiMediaContract(params: {
  node: any;
  contextEntries?: ContextEntry[];
  contextString?: string;
  toolOverrides?: ToolOverrides;
}): UiMediaContract | null {
  const context = parseContext(params.contextString);
  const settings = record(params.node?.settings);
  const type =
    outputType(params.node?.type)
    ?? outputType(context.nodeType)
    ?? outputType(context.mediaType)
    ?? outputType(context.media_type)
    ?? outputType(context.output_type)
    ?? outputType(settings.output_type)
    ?? outputType(settings.media_type);
  if (!type) return null;

  const requiredTool = type === 'image'
    ? 'generate_image'
    : type === 'video'
      ? 'generate_video'
      : type === 'audio'
        ? 'generate_audio'
        : null;

  const parameters = {
    ...record(context.parameters),
    ...record(settings.parameters),
  };
  const references = (params.contextEntries ?? []).flatMap((entry) =>
    extractImageUrls(entry.node).map((url) => ({
      url,
      role: contextRole(entry.type),
    })),
  );
  const start = references.find((item) => item.role === 'start')?.url;
  const end = references.findLast((item) => item.role === 'end')?.url;
  const generic = references.filter((item) => item.role === 'reference').map((item) => item.url);

  let toolOverrides = restrictMediaOverrides(params.toolOverrides, requiredTool);
  if (type === 'image') {
    toolOverrides = mergeOverrides(toolOverrides, 'generate_image', {
      ...(aspectRatio(parameters) ? { aspect_ratio: aspectRatio(parameters) } : {}),
      ...(imageQuality(parameters) ? { quality: imageQuality(parameters) } : {}),
      ...(references.length > 0
        ? { reference_images: Array.from(new Set(references.map((item) => item.url))) }
        : {}),
    });
  } else if (type === 'video') {
    const firstFrame = start ?? generic[0];
    const requestedQuality =
      videoQuality(parameters)
      ?? videoQuality(record(toolOverrides.generate_video));
    const proQuality = requestedQuality === 'pro';
    toolOverrides = mergeOverrides(toolOverrides, 'generate_video', {
      ...(proQuality ? { aspect_ratio: '16:9' } : aspectRatio(parameters) ? { aspect_ratio: aspectRatio(parameters) } : {}),
      ...(end || proQuality
        ? { duration: 8 }
        : duration(parameters) ? { duration: duration(parameters) } : {}),
      ...(requestedQuality ? { quality: requestedQuality } : {}),
      ...(firstFrame ? { first_frame_url: firstFrame } : {}),
      ...(end ? { last_frame_url: end } : {}),
      ...(generic.length > 0 ? { reference_images: Array.from(new Set(generic)) } : {}),
    });
  } else if (type === 'audio') {
    toolOverrides = mergeOverrides(toolOverrides, 'generate_audio', {
      ...(audioFormat(parameters) ? { format: audioFormat(parameters) } : {}),
    });
  }

  const referenceRule = type === 'video' && (start || end)
    ? 'Use the linked Inicio image as the first frame and the linked fin image as the last frame. These frame bindings are already enforced by the server.'
    : 'Use only the explicitly linked node references. Do not substitute images from conversation history or unrelated instance assets.';

  return {
    outputType: type,
    requiredTool,
    toolOverrides,
    instruction: requiredTool
      ? `UI OUTPUT CONTRACT: This node must produce ${type}. You MUST call ${requiredTool}; no other media generation tool is allowed. ${referenceRule}`
      : 'UI OUTPUT CONTRACT: This is a text node. Do not call any media generation tool.',
  };
}

export async function resolveUiMediaContract(params: {
  instanceNodeId?: string;
  instanceId: string;
  siteId: string;
  contextString?: string;
  toolOverrides?: ToolOverrides;
}): Promise<UiMediaContract | null> {
  if (!params.instanceNodeId) return null;

  const { data: node, error: nodeError } = await supabaseAdmin
    .from('instance_nodes')
    .select('*')
    .eq('id', params.instanceNodeId)
    .eq('instance_id', params.instanceId)
    .eq('site_id', params.siteId)
    .maybeSingle();
  if (nodeError || !node) {
    throw new Error('UI node does not belong to the requested site and instance');
  }

  const entries = await fetchNodeContexts(params.instanceNodeId, {
    instanceId: params.instanceId,
    siteId: params.siteId,
  }) as ContextEntry[];
  if (
    node.parent_node_id
    && !entries.some((entry) => entry.context_node_id === node.parent_node_id)
  ) {
    const { data: parent } = await supabaseAdmin
      .from('instance_nodes')
      .select('*')
      .eq('id', node.parent_node_id)
      .eq('instance_id', params.instanceId)
      .eq('site_id', params.siteId)
      .maybeSingle();
    if (parent) {
      entries.unshift({
        context_node_id: parent.id,
        type: 'parent_reference',
        node: parent,
      });
    }
  }

  return buildUiMediaContract({
    node,
    contextEntries: entries,
    contextString: params.contextString,
    toolOverrides: params.toolOverrides,
  });
}
