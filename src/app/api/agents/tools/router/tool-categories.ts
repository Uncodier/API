export type ToolCategory =
  | 'media'
  | 'messaging'
  | 'crm'
  | 'commerce'
  | 'social'
  | 'content'
  | 'infra'
  | 'research'
  | 'ui'
  | 'other';

// Category assignment is best-effort metadata for the `list` action so the
// model can filter/narrow (e.g. "show me all media tools"). Unknown names
// fall back to "other".
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // media
  generate_image: 'media',
  generate_video: 'media',
  generate_audio: 'media',
  audio_to_text: 'media',
  analyze_video: 'media',

  // messaging
  sendEmail: 'messaging',
  sendWhatsApp: 'messaging',
  whatsappTemplate: 'messaging',
  sendBulkMessages: 'messaging',
  placeVoiceCall: 'messaging',
  configure_email: 'messaging',
  configure_whatsapp: 'messaging',
  conversations: 'messaging',
  messages: 'messaging',

  // crm / growth
  leads: 'crm',
  sales: 'crm',
  deals: 'crm',
  sales_order: 'crm',
  quotations: 'commerce',
  quotation_items: 'commerce',
  entitlements: 'commerce',
  subscription_plan_items: 'commerce',
  subscriptions: 'commerce',
  price_lists: 'commerce',
  pass_redeemable_items: 'commerce',
  reservation_schedules: 'commerce',
  calendars: 'crm',
  reservations: 'commerce',
  catalog_commerce: 'commerce',
  promotions: 'commerce',
  checkout: 'commerce',
  purchases: 'commerce',
  purchase_items: 'commerce',
  procurement_requests: 'commerce',
  procurement_tenders: 'commerce',
  procurement_quotations: 'commerce',
  procurement_orders: 'commerce',
  procurement_approvals: 'commerce',
  procurement_policy: 'commerce',
  transactions: 'commerce',
  audience: 'crm',
  segments: 'crm',
  campaigns: 'crm',
  analyzeICPTotalCount: 'crm',
  createIcpMining: 'crm',
  getFinderCategoryIds: 'crm',
  search_region_venues: 'crm',
  categories: 'content',

  // social
  social_media_accounts: 'social',
  social_media_publish: 'social',
  social_media_posts: 'social',
  social_media_analytics: 'social',
  publish: 'social',

  // content / assets
  content: 'content',
  copywriting: 'content',
  assets: 'content',
  site_settings: 'content',
  record_category: 'content',
  record: 'content',
  read_document: 'content',

  // infra / ops
  create_project: 'infra',
  create_secret: 'infra',
  webhooks: 'infra',
  workflows: 'infra',
  scheduling: 'infra',
  system_notification: 'infra',
  tasks: 'infra',
  report: 'infra',
  instance: 'infra',
  instance_project: 'infra',
  instance_logs: 'infra',
  instance_history: 'infra',
  update_repo: 'infra',
  createAccount: 'infra',
  verifyAccount: 'infra',
  memories: 'infra',
  save_on_memory: 'infra',
  get_memories: 'infra',

  // research
  webSearch: 'research',
  url_to_markdown: 'research',
  url_to_sitemap: 'research',

  // ui
  show_artifact: 'ui',
};

export function categoryOf(name: string): ToolCategory {
  return TOOL_CATEGORIES[name] ?? 'other';
}

