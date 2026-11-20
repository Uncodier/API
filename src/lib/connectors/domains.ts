/** Discovery metadata only. Neither a domain nor a skill grants execution rights. */
export const CONNECTOR_REGISTRY_VERSION = '2026-11-20.1';
export type ConnectorDomain = {
  id: string; label: string; aliases: string[]; skillSlugs: string[]; categories: string[];
};

export const CONNECTOR_DOMAINS: ConnectorDomain[] = [
  { id: 'ai', label: 'Artificial Intelligence', aliases: ['ai', 'artificial intelligence', 'machine learning'], skillSlugs: ['ai-media-generation'], categories: ['media'] },
  { id: 'crm', label: 'Sales & CRM', aliases: ['crm', 'sales', 'customer relationship management', 'contacts', 'hubspot', 'salesforce'], skillSlugs: ['connector-crm-operations', 'makinari-outbound-campaign'], categories: ['crm'] },
  { id: 'marketing', label: 'Marketing', aliases: ['marketing', 'advertising', 'seo'], skillSlugs: ['ads-meta-google', 'marketing-seo-gtm', 'website-seo', 'makinari-outbound-campaign'], categories: ['crm', 'social'] },
  { id: 'communication', label: 'Communication', aliases: ['communication', 'messaging', 'email', 'gmail', 'slack', 'teams'], skillSlugs: ['connector-messaging', 'makinari-rol-content', 'makinari-outbound-campaign'], categories: ['messaging'] },
  { id: 'productivity', label: 'Productivity & Projects', aliases: ['productivity', 'project management', 'tasks', 'issues'], skillSlugs: ['makinari-obj-workflow-designer', 'automations-n8n-zapier'], categories: ['infra'] },
  { id: 'calendar', label: 'Calendar', aliases: ['calendar', 'scheduling', 'googlecalendar', 'outlook calendar'], skillSlugs: ['makinari-commerce'], categories: ['crm'] },
  { id: 'files', label: 'Content & Files', aliases: ['content', 'files', 'documents', 'drive', 'dropbox'], skillSlugs: ['makinari-rol-content', 'technical-copywriting', 'file-delivery'], categories: ['content'] },
  { id: 'commerce', label: 'Commerce & Payments', aliases: ['commerce', 'payments', 'ecommerce', 'checkout'], skillSlugs: ['makinari-commerce'], categories: ['commerce'] },
  { id: 'support', label: 'Customer Support', aliases: ['customer support', 'helpdesk', 'tickets', 'zendesk'], skillSlugs: [], categories: ['messaging'] },
  { id: 'developer', label: 'Developer Tools', aliases: ['developer tools', 'development', 'github', 'gitlab'], skillSlugs: ['makinari-rol-backend', 'makinari-rol-devops', 'qa-jest-testing'], categories: ['infra'] },
  { id: 'analytics', label: 'Data & Analytics', aliases: ['data analytics', 'analytics', 'business intelligence', 'bi'], skillSlugs: ['marketing-seo-gtm', 'ads-meta-google'], categories: ['research'] },
  { id: 'storage', label: 'Databases & Storage', aliases: ['databases', 'storage', 'database storage'], skillSlugs: ['makinari-obj-apps-supabase', 'file-delivery'], categories: ['infra', 'content'] },
  { id: 'hr', label: 'HR & Recruiting', aliases: ['hr', 'human resources', 'recruiting', 'recruitment'], skillSlugs: [], categories: ['infra'] },
  { id: 'finance', label: 'Finance & Accounting', aliases: ['finance', 'accounting', 'bookkeeping', 'reconciliation'], skillSlugs: ['makinari-expenses', 'makinari-purchases'], categories: ['commerce'] },
  { id: 'security', label: 'IT & Security', aliases: ['it', 'information technology', 'security', 'identity management', 'it operations', 'security & identity tools'], skillSlugs: ['makinari-rol-devops', 'makinari-rol-backend'], categories: ['infra'] },
  { id: 'procurement', label: 'Procurement', aliases: ['procurement', 'suppliers', 'purchasing'], skillSlugs: ['makinari-procurement'], categories: ['commerce'] },
];

const toolkitOverrides: Record<string, string[]> = {
  supabase: ['storage', 'developer'],
  gmail: ['communication'], slack: ['communication'], microsoft_teams: ['communication'],
  hubspot: ['crm', 'marketing'], salesforce: ['crm'], pipedrive: ['crm'],
  googlecalendar: ['calendar'], outlook: ['communication', 'calendar'],
  googledrive: ['files', 'storage'], dropbox: ['files', 'storage'], notion: ['files', 'productivity'],
  github: ['developer', 'productivity'], gitlab: ['developer', 'productivity'],
  asana: ['productivity'], linear: ['productivity'], jira: ['productivity'],
  stripe: ['commerce'], shopify: ['commerce'], zendesk: ['support'], intercom: ['support'],
  quickbooks: ['finance'], xero: ['finance'], bamboohr: ['hr'], workable: ['hr'],
  coupa: ['finance', 'procurement'], zip: ['finance', 'procurement', 'productivity'],
};
const normalize = (value: string) => value.toLowerCase().replace(/[_&-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Curated toolkit mappings take precedence; unknown categories remain unmapped. */
export function getToolkitDomains(slug: string, categories: readonly string[] = []): string[] {
  if (Object.hasOwn(toolkitOverrides, slug.toLowerCase())) return [...toolkitOverrides[slug.toLowerCase()]];
  const labels = categories.map(normalize);
  return CONNECTOR_DOMAINS.filter(domain => [domain.id, domain.label, ...domain.aliases]
    .some(alias => labels.includes(normalize(alias)))).map(domain => domain.id);
}

export function getDomainSkills(ids: readonly string[]): string[] {
  return [...new Set(CONNECTOR_DOMAINS.filter(domain => ids.includes(domain.id)).flatMap(domain => domain.skillSlugs))];
}

export function getSkillDomains(slug: string): ConnectorDomain[] {
  return CONNECTOR_DOMAINS.filter(domain => domain.skillSlugs.includes(slug));
}

export function getSkillDomainAliases(slug: string): string[] {
  return getSkillDomains(slug).flatMap(domain => [domain.label, ...domain.aliases]);
}

export function expandDomainQuery(query: string): string {
  return query.replace(/\bhr\b/gi, 'human resources recruiting').replace(/\bit\b/gi, 'information technology');
}