import { useTranslation } from "@gadgets/i18n";
import { Select, type PortalContainer } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionConfigField } from './ConnectionConfigField'

export interface AiModelConnectionConfigProps {
  availableModels: AiChatAuthorInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
  selectContainer?: PortalContainer
}

export function AiModelConnectionConfig({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
  selectContainer,
}: AiModelConnectionConfigProps) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label={t("workshop-frontend.AiModelConnectionConfig.model")}
        description={t("workshop-frontend.AiModelConnectionConfig.choose_the_model_this_connection_can_use")}
      >
        <Select
          aria-label={t("workshop-frontend.AiModelConnectionConfig.select_an_ai_model")}
          className="w-full text-sm [&_button]:!h-9"
          container={selectContainer}
          placeholder={t("workshop-frontend.AiModelConnectionConfig.select_an_ai_model")}
          // `null`, not the prop's `undefined`: Base UI treats an undefined value as an
          // uncontrolled Select, so choosing a model would switch the component from
          // uncontrolled to controlled and warn. The prop type stays as callers declare it.
          value={selectedModelId ?? null}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => availableModels.find((m) => m.id === id)?.name ?? id}
        >
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
