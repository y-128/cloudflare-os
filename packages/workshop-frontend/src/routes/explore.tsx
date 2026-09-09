import { useTranslation } from "@gadgets/i18n";
import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  const { t } = useTranslation();
  useDocumentTitle(t("workshop-frontend.explore.explore"))

  return <BlueprintsPage />
}
