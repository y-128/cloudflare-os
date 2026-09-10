import { useState } from 'react'

const DENSITY_KEY = 'cfos:mail-compact'

/** A device-local display preference shared by the list and settings on their next mount. */
export const useMailDensity = () => {
  const [compact, updateCompact] = useState(() => {
    try { return localStorage.getItem(DENSITY_KEY) === '1' }
    catch { return false }
  })
  const setCompact = (value: boolean) => {
    updateCompact(value)
    try { localStorage.setItem(DENSITY_KEY, value ? '1' : '0') }
    catch (error) { console.warn('[saveMailDensity] storage unavailable', { error }) }
  }
  return [compact, setCompact] as const
}
