/** Shared labels keep the settings navigation and pane title in sync. */
export const MAIL_SETTINGS_SCREENS = {
  spam: 'spam_settings', notifications: 'notification_settings', domains: 'domain_settings', smtp: 'smtp_settings',
  filters: 'filter_settings', aliases: 'alias_settings', ai: 'ai_settings', activity: 'spam_activity_settings',
} as const
export type MailSettingsScreen = keyof typeof MAIL_SETTINGS_SCREENS
export const mailSettingsScreens = Object.keys(MAIL_SETTINGS_SCREENS) as MailSettingsScreen[]
