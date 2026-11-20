import type { ComposioToolkit } from './composio-catalog';

// The shared project only provisions reviewed presets. Never accept scopes or
// OAuth app credentials from a workspace when using the platform key.
const calendarScopes = ['https://www.googleapis.com/auth/calendar.events.readonly'];

export function managedOAuthPreset(toolkit: ComposioToolkit) {
  if (toolkit.slug !== 'googlecalendar' || toolkit.enabled === false ||
      !calendarScopes.every(scope => toolkit.managed_oauth_scopes?.includes(scope))) return null;
  return { name: 'Makinari Google Calendar (read-only)', scopes: calendarScopes.join(',') };
}