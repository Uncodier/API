import type { ComposioToolkit } from './composio-catalog';

// Preserve the reviewed Calendar scope instead of using the managed default.
const calendarScopes = ['https://www.googleapis.com/auth/calendar.events.readonly'];

export function managedOAuthPreset(toolkit: ComposioToolkit) {
  if (toolkit.slug !== 'googlecalendar' || toolkit.enabled === false ||
      !calendarScopes.every(scope => toolkit.managed_oauth_scopes?.includes(scope))) return null;
  return { name: 'Makinari Google Calendar (read-only)', scopes: calendarScopes.join(',') };
}