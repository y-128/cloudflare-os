import { createFileRoute } from '@tanstack/react-router'
import { WorkHubPage } from '../pages/work-hub/WorkHubPage'

export const Route = createFileRoute('/status')({ component: () => <WorkHubPage mode="status" /> })
