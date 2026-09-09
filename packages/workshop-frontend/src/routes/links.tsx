import { createFileRoute } from '@tanstack/react-router'
import { LinksPage } from '../pages/links/LinksPage'

/** Registers the authenticated links directory in the existing application shell. */
export const Route = createFileRoute('/links')({ component: LinksPage })
