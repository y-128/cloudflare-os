import { useState } from 'react'
import type { DirectoryLink } from '@gadgets/workshop-shared/api'

/** Loads only the destination-origin favicon and replaces failed images with the title's initial. */
export const LinkFavicon = ({ link }: { link: DirectoryLink }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return (
    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-lg font-semibold text-kumo-subtle">
      {failedUrl === link.icon
        ? link.title.trim().slice(0, 1).toUpperCase()
        : <img src={link.icon} alt="" className="size-6" loading="lazy" referrerPolicy="no-referrer"
            onError={() => setFailedUrl(link.icon)} />}
    </span>
  )
}
