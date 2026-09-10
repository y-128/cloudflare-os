/** Shared labels keep the settings navigation and pane title in sync. */
export const MAIL_SETTINGS_SCREENS = {
  general: 'general_settings', accounts: 'account_settings',
  spam: 'spam_settings', notifications: 'notification_settings', domains: 'domain_settings', smtp: 'smtp_settings',
  filters: 'filter_settings', aliases: 'alias_settings', ai: 'ai_settings', activity: 'spam_activity_settings',
} as const
export type MailSettingsScreen = keyof typeof MAIL_SETTINGS_SCREENS
export const mailSettingsScreens = Object.keys(MAIL_SETTINGS_SCREENS) as MailSettingsScreen[]

/** Top-level categories follow the mock; existing specialized settings remain one level below. */
export const MAIL_SETTINGS_GROUPS = [
  { label: 'general_settings', screens: ['general'] },
  { label: 'account_settings', screens: ['accounts', 'aliases', 'smtp'] },
  { label: 'sending_domains', screens: ['domains'] },
  { label: 'notification_settings', screens: ['notifications'] },
  { label: 'advanced_settings', screens: ['filters', 'spam', 'ai', 'activity'] },
] as const satisfies readonly { label: string; screens: readonly MailSettingsScreen[] }[]
