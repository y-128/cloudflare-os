import { createFileRoute } from '@tanstack/react-router'
import { LinksPage } from '../pages/links/LinksPage'

export const Route = createFileRoute('/worksets')({ component: () => <LinksPage worksets /> })
