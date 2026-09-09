import { useTranslation } from "@gadgets/i18n";
import { Switch, Tooltip } from '@cloudflare/kumo'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

/** Enable/disable toggle for bound hooks. Used in the Connections tab, Activity log, and inline chat. */
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm' }: HookToggleProps) {
  const { t } = useTranslation();
  return (
    <Tooltip content={enabled ? t("workshop-frontend.HookToggle.disable_this_hook") : t("workshop-frontend.HookToggle.enable_this_hook")} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={enabled ? t("workshop-frontend.HookToggle.disable_hook") : t("workshop-frontend.HookToggle.enable_hook")}
        />
      </span>
    </Tooltip>
  )
}
