import { describe, expect, it } from 'vitest'
import { queryForView, searchForView, viewFromSearch, type PhotosView } from './photosView'

describe('photos views', () => {
  it('round-trips every view through the URL', () => {
    const views: PhotosView[] = [
      { kind: 'library' }, { kind: 'recent' }, { kind: 'favorites' }, { kind: 'trash' }, { kind: 'storage' }, { kind: 'imports' },
      { kind: 'album', id: 'alb_01J00000000000000000000000' },
      { kind: 'tag', id: 'tag_01J00000000000000000000000' },
      { kind: 'photographer', id: 'pgr_01J00000000000000000000000' },
      { kind: 'visibility', value: 'unlisted' },
    ]
    for (const view of views) expect(viewFromSearch(searchForView(view))).toEqual(view)
  })

  it('falls back to the library for malformed parameters', () => {
    expect(viewFromSearch({ view: 'album', id: 'tag_x' })).toEqual({ kind: 'library' })
    expect(viewFromSearch({ view: 'visibility', id: 'secret' })).toEqual({ kind: 'library' })
    expect(viewFromSearch({ view: 'nope' })).toEqual({ kind: 'library' })
  })

  it('maps views to searches', () => {
    expect(queryForView({ kind: 'favorites' })).toEqual({ favorite: true })
    expect(queryForView({ kind: 'album', id: 'alb_01J00000000000000000000000' }))
      .toEqual({ albumId: 'alb_01J00000000000000000000000', sort: 'taken_asc' })
  })
})
