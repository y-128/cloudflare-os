/** Allows only absolute HTTP(S) destinations without embedded credentials. */
export const safeHttpUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
