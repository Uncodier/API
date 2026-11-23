// Release and structural fingerprints from the public docs' versioned schema viewer:
// https://docs.composio.dev/api/tools/{slug}?version={version}. See the offline fixtures.
// Membership selects a projection, never authorization. A new release needs fresh evidence.
const calendarScope = 'https://www.googleapis.com/auth/calendar';
const calendarReadScopes = [`${calendarScope}.calendarlist.readonly`, `${calendarScope}.readonly`];
const calendarScopes = [calendarScope, `${calendarScope}.calendarlist`, ...calendarReadScopes];
const crmList = (resource: 'companies' | 'deals', shape: string) => ({
  kind: 'hubspot' as const, toolkit: 'hubspot', resource, version: '20261116_01', shape,
  limitField: 'limit', nameField: resource === 'companies' ? 'name' : 'dealname',
  description: `Retrieves a paginated list of HubSpot ${resource}.`,
  scopes: [`crm.objects.${resource}.read`], tags: ['Basic', 'openWorldHint', 'readOnlyHint'],
});
const profiles = {
  HUBSPOT_LIST_COMPANIES: crmList('companies', 'dfe6a64165e246a72b2f4a0ea740b13420ad78af34a6b0aa3a3672908a2d6d4f'),
  HUBSPOT_LIST_DEALS: crmList('deals', '4e513b61c6592ea5ae68c26ac4ac689e9001fa26c947a577a366d92a7dd9f080'),
  GOOGLECALENDAR_LIST_CALENDARS: { kind: 'calendar' as const, toolkit: 'googlecalendar', resource: 'calendars',
    version: '20261116_00', shape: '2373212904f1934daf0bf7606cd219c2a8277643bd986ad1090aebd863776f51',
    description: 'Lists calendars accessible through the connected user\'s CalendarList, returning IDs and user-specific metadata such as access role, color, visibility, selection, and reminders. '
      + 'Hidden calendars are omitted unless show_hidden is true; min_access_role and show_deleted provide additional filtering. '
      + 'Continue with page_token until next_page_token is absent; for incremental synchronization, pass next_sync_token back as sync_token. '
      + 'Use returned IDs, not display names, with event actions, and use GOOGLECALENDAR_GET_CALENDAR for canonical metadata about one known calendar.',
    limitField: 'max_results', scopes: calendarScopes, tags: ['readOnlyHint', 'idempotentHint', 'openWorldHint'] },
};
export type PublishedList = typeof profiles[keyof typeof profiles];
export function publishedList(toolkit: string, slug: string): PublishedList | undefined {
  if (!Object.hasOwn(profiles, slug)) return;
  const profile = profiles[slug as keyof typeof profiles];
  return profile.toolkit === toolkit ? profile : undefined;
}
export function sameSet(actual: unknown, expected: readonly string[]) {
  return Array.isArray(actual) && actual.length === expected.length && expected.every(value => actual.includes(value));
}
