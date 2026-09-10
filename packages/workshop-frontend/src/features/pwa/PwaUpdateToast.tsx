import { useEffect, useEffectEvent } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'

/** Updates the shell in the background, leaving reload timing to the user. */
export const PwaUpdateToast = () => {
  const { t } = useTranslation()
  const { add, close } = useKumoToastManager()
  // Kumo returns fresh manager methods on render; keep the SW subscription alive across toasts.
  const showUpdate = useEffectEvent(() => add({
    title: t('workshop-frontend.PwaUpdateToast.available'),
    description: t('workshop-frontend.PwaUpdateToast.save_before_reload'),
    timeout: 0,
    actions: [{
      children: t('workshop-frontend.PwaUpdateToast.reload'),
      onClick: () => window.location.reload(),
    }],
  }))
  const closeUpdate = useEffectEvent((id: string) => close(id))

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

    const workers = navigator.serviceWorker
    let controller = workers.controller
    let toastId: string | undefined
    let registration: ServiceWorkerRegistration | undefined
    let disposed = false

    const onControllerChange = () => {
      const previous = controller
      controller = workers.controller
      // clientsClaim also fires on first installation; that isn't an available update.
      if (!previous || !controller || previous === controller || toastId) return
      toastId = showUpdate()
    }

    const checkForUpdate = () => {
      if (document.visibilityState !== 'visible' || !registration) return
      void registration.update().catch((error: unknown) => {
        console.warn('PWA update check failed', { scope: '/', error })
      })
    }

    workers.addEventListener('controllerchange', onControllerChange)
    document.addEventListener('visibilitychange', checkForUpdate)
    // Native registration avoids the virtual module's autoUpdate page-reload handler.
    void workers.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((result) => {
      if (!disposed) registration = result
    }).catch((error: unknown) => {
      console.error('PWA registration failed', { script: '/sw.js', error })
    })

    return () => {
      disposed = true
      workers.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', checkForUpdate)
      if (toastId) closeUpdate(toastId)
    }
  }, [])

  return null
}
