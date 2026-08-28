export const NOTIFICATION_CATEGORY_IDS = [
  "lead_management",
  "tasks_reminders",
  "analysis_insights",
  "human_intervention",
  "system_alerts",
] as const

export type NotificationCategoryId = (typeof NOTIFICATION_CATEGORY_IDS)[number]

export type SiteNotificationPreferences = {
  email_enabled?: boolean | null
  push_enabled?: boolean | null
  categories?: Record<string, boolean> | null
} | null

export type ProfileNotificationFlags = {
  email?: boolean
  push?: boolean
} | null

function isPrivilegedRole(role?: string | null): boolean {
  return role === "admin" || role === "owner"
}

function profileChannelEnabled(
  flags: ProfileNotificationFlags,
  role: string | null | undefined,
  channel: "email" | "push"
): boolean {
  if (flags && typeof flags === "object") {
    return flags[channel] === true
  }
  return isPrivilegedRole(role)
}

export function isSiteChannelEnabled(params: {
  sitePreferences: SiteNotificationPreferences
  profileNotifications?: ProfileNotificationFlags
  role?: string | null
  channel: "email" | "push"
}): boolean {
  const { sitePreferences, profileNotifications, role, channel } = params
  
  if (profileNotifications && profileNotifications[channel] === false) {
    return false // Master switch overriding all sites
  }

  if (sitePreferences) {
    const enabled =
      channel === "email"
        ? sitePreferences.email_enabled
        : sitePreferences.push_enabled
    return enabled !== false
  }
  return profileChannelEnabled(profileNotifications ?? null, role, channel)
}

export function shouldDeliverSiteNotification(params: {
  sitePreferences: SiteNotificationPreferences
  profileNotifications?: ProfileNotificationFlags
  role?: string | null
  channel: "email" | "push"
  notificationCategories?: string[]
}): boolean {
  if (!isSiteChannelEnabled(params)) return false

  const notificationCategories = params.notificationCategories ?? []
  if (notificationCategories.length === 0) return true

  const userCategories = params.sitePreferences?.categories
  if (!userCategories) return true

  return !notificationCategories.some((category) => userCategories[category] === false)
}
