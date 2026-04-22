/**
 * Canonical catalog of scopes exposed by the Uncodie Platform API to apps
 * generated inside the sandbox. The catalog is the single place to register a
 * new capability — handlers, quotas, and the audit log all reference these
 * identifiers. `test_only` variants are the default posture for new keys and
 * are promoted to prod via a manual action from the site owner's dashboard.
 */

export interface PlatformScopeDescriptor {
  scope: string;
  capability: string;
  description: string;
  /** When true, the scope is only usable against resources marked `is_test=true`. */
  test_only: boolean;
  /** Suggested quota bucket id (mapped to `platform_quotas.capability`). */
  quota_bucket: string;
}

const emailScopes: PlatformScopeDescriptor[] = [
  {
    scope: 'email.send.test-only',
    capability: 'email',
    description: 'Send a transactional email. Allowed recipients must be marked is_test=true for the active site.',
    test_only: true,
    quota_bucket: 'email.send',
  },
  {
    scope: 'email.send',
    capability: 'email',
    description: 'Send a transactional email to any lead belonging to the active site (manual promote-to-prod).',
    test_only: false,
    quota_bucket: 'email.send',
  },
];

const whatsappScopes: PlatformScopeDescriptor[] = [
  {
    scope: 'whatsapp.send.test-only',
    capability: 'whatsapp',
    description: 'Send a WhatsApp message to a test recipient (is_test=true in leads).',
    test_only: true,
    quota_bucket: 'whatsapp.send',
  },
  {
    scope: 'whatsapp.send',
    capability: 'whatsapp',
    description: 'Send a WhatsApp message to any lead belonging to the active site (manual promote-to-prod).',
    test_only: false,
    quota_bucket: 'whatsapp.send',
  },
];

const leadScopes: PlatformScopeDescriptor[] = [
  {
    scope: 'leads.read',
    capability: 'leads',
    description: 'List leads belonging to the active site.',
    test_only: false,
    quota_bucket: 'leads.read',
  },
  {
    scope: 'leads.write',
    capability: 'leads',
    description: 'Create or update leads belonging to the active site.',
    test_only: false,
    quota_bucket: 'leads.write',
  },
];

const notificationScopes: PlatformScopeDescriptor[] = [
  {
    scope: 'notifications.create',
    capability: 'notifications',
    description: 'Create in-app notifications for the active site.',
    test_only: false,
    quota_bucket: 'notifications.create',
  },
];

const trackingScopes: PlatformScopeDescriptor[] = [
  {
    scope: 'tracking.event.write',
    capability: 'tracking',
    description: 'Ingest a tracking event associated to the active site.',
    test_only: false,
    quota_bucket: 'tracking.event.write',
  },
];

const agentScopes: PlatformScopeDescriptor[] = [
  {
    scope: 'agents.invoke',
    capability: 'agents',
    description: 'Invoke an Uncodie agent tool (scope suffix selects the tool).',
    test_only: false,
    quota_bucket: 'agents.invoke',
  },
];

const dbScopes: PlatformScopeDescriptor[] = [
  {
    scope: 'db.migrate',
    capability: 'db',
    description: 'Apply vetted SQL migrations to the tenant schema (linted before execution).',
    test_only: false,
    quota_bucket: 'db.migrate',
  },
];

export const PLATFORM_SCOPES: PlatformScopeDescriptor[] = [
  ...emailScopes,
  ...whatsappScopes,
  ...leadScopes,
  ...notificationScopes,
  ...trackingScopes,
  ...agentScopes,
  ...dbScopes,
];

const SCOPE_MAP = new Map(PLATFORM_SCOPES.map((s) => [s.scope, s]));

export function getScopeDescriptor(scope: string): PlatformScopeDescriptor | null {
  return SCOPE_MAP.get(scope) ?? null;
}

/**
 * Returns the list of scopes any key exchanged for a new test-only requirement
 * should hold. New requirements default to the read+test-only posture.
 */
export function defaultTestOnlyScopesForRequirement(): string[] {
  return [
    'email.send.test-only',
    'whatsapp.send.test-only',
    'leads.read',
    'leads.write',
    'notifications.create',
    'tracking.event.write',
    'agents.invoke',
    'db.migrate',
  ];
}

/**
 * `has(scopes, required)` — returns true when `scopes` satisfies `required`.
 * Handles the promote-to-prod hierarchy: the presence of `email.send` implies
 * `email.send.test-only`.
 */
export function hasScope(keyScopes: string[], required: string): boolean {
  if (!Array.isArray(keyScopes) || keyScopes.length === 0) return false;
  if (keyScopes.includes(required)) return true;
  // Promote-to-prod implies the test-only variant.
  if (required.endsWith('.test-only')) {
    const prod = required.replace(/\.test-only$/, '');
    return keyScopes.includes(prod);
  }
  return false;
}
