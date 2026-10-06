import type { ChatGptPlanHandoff } from '@gadgets/workshop-shared/api'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Shell-quote the deployment origin and account identifiers; credentials never enter this command. */
export const connectionCommand = (origin: string, handoff: ChatGptPlanHandoff): string => {
  const args = ['--host', origin, '--locator', handoff.locator, '--handoff', handoff.code,
    '--nonce', handoff.nonce, '--host-id', handoff.extAgentHostId, '--expires', String(handoff.expiresAt)]
  if (handoff.clientId && handoff.subject) args.push('--client-id', handoff.clientId, '--subject', handoff.subject)
  return `pnpm chatgpt:connect ${args.map(quote).join(' ')}`
}
