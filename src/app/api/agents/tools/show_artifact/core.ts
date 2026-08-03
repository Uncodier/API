import { supabaseAdmin } from '@/lib/database/supabase-client';

export const SCREEN_MAP = {
  // Marketing
  campaigns: '/campaigns',
  segments: '/segments',
  content: '/content',
  assets: '/assets',
  // Sales
  sales_home: '/sales-home',
  control_center: '/control-center',
  sales: '/sales',
  leads: '/leads',
  deals: '/deals',
  chat: '/chat',
  people: '/people',
  // Automation
  context: '/context',
  agents_configuration: '/agents',
  requirements: '/requirements',
  channels_settings: '/settings?tab=channels',
  activities_settings: '/settings?tab=activities',
  skills: '/skills',
  // Applications
  applications_database: '/applications/database',
  applications_repositories: '/applications/repositories',
  // Commerce
  catalog: '/catalog',
  reservations: '/reservations',
  reservation_schedules: '/reservations?tab=schedules',
  quotations: '/quotations',
  buyer_quotes: '/buyer/quotes',
  buyer_library: '/buyer/library',
  buyer_orders: '/buyer/orders',
  // Reports
  performance_report: '/dashboard?tab=performance',
  overview_report: '/dashboard?tab=overview',
  analytics_report: '/dashboard?tab=analytics',
  traffic_report: '/dashboard?tab=traffic',
  costs_report: '/costs',
  sales_report: '/dashboard?tab=sales',
} as const;

export type ScreenKey = keyof typeof SCREEN_MAP;

export function buildArtifactUrl(screen: ScreenKey, extraParams?: Record<string, any>): string {
  const basePath = SCREEN_MAP[screen];
  if (!basePath) {
    throw new Error(`Invalid screen key: ${screen}`);
  }

  let url = basePath;
  const hasQuery = url.includes('?');

  if (extraParams && Object.keys(extraParams).length > 0) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += (hasQuery ? '&' : '?') + queryString;
    }
  }

  return url + (url.includes('?') ? '&' : '?') + 'artifact=true';
}

export type CreateInstanceArtifactParams = {
  site_id: string;
  instance_id: string;
  user_id?: string;
  screen: string;
  title?: string;
  description?: string;
  extra_params?: Record<string, any>;
  should_reload?: boolean;
};

export async function createInstanceArtifactCore(params: CreateInstanceArtifactParams) {
  const {
    site_id,
    instance_id,
    user_id,
    screen,
    title,
    description,
    extra_params,
    should_reload = false,
  } = params;

  if (!site_id || !instance_id || !screen) {
    throw new Error('site_id, instance_id, and screen are required');
  }

  if (!(screen in SCREEN_MAP)) {
    throw new Error(`Invalid screen: ${screen}. Must be one of: ${Object.keys(SCREEN_MAP).join(', ')}`);
  }

  const computedUrl = buildArtifactUrl(screen as ScreenKey, extra_params);

  const { data, error } = await supabaseAdmin
    .from('instance_artifacts')
    .insert([
      {
        site_id,
        instance_id,
        user_id: user_id || null,
        screen,
        url: computedUrl,
        title: title || null,
        description: description || null,
        should_reload,
        context: extra_params || {},
      },
    ])
    .select()
    .single();

  if (error) {
    console.error('Error inserting instance_artifact:', error);
    throw new Error(`Failed to create instance artifact: ${error.message}`);
  }

  return { success: true, data };
}
