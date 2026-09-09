# @gadgets/i18n

Dependency-free translation core for Japanese and English. The browser entry shares the application's existing React 19 installation through an optional peer; no i18n library is used. Package exports point directly to TypeScript source, like `workshop-shared`.

```tsx
import { initI18n, useTranslation } from '@gadgets/i18n'

initI18n() // Call before rendering the application.

/** Displays a label that follows the selected language. */
const HomeLabel = () => {
  const { t } = useTranslation()
  return <span>{t('workshop-frontend.Sidebar.home')}</span>
}
```

`getLocale()` reads the active locale. `setLocale('ja' | 'en')` updates subscribers, `html.lang`, and the `locale` localStorage key. Initialization chooses a valid saved preference, then English for an English browser, otherwise Japanese. Unavailable storage is logged; initialization defaults to Japanese and switching still works in memory. No environment variables or credentials are required.

`t(key, params?)` and `t(key, fallback, params?)` interpolate `{name}` values (strings or numbers). Unknown parameters remain intact. Missing keys without an explicit fallback display `[missing: key]` in Vite development mode and the key itself in production. An empty fallback string is respected. React renders text normally; this API does not produce trusted HTML.

Workers use the React-free entry and pass a locale per call so concurrent requests never share locale state:

```ts
import { translate } from '@gadgets/i18n/core'

const label = translate('ja', 'workshop-frontend.Sidebar.home')
```

`translate` is also exported by the browser entry. The explicit-locale core always falls back to the key and never accesses browser globals.

Run from the repository root:

```sh
pnpm install --offline
node scripts/i18n/extract-from-fork.ts
node --test scripts/i18n/extract.test.ts
pnpm --filter @gadgets/i18n test:run
pnpm build
pnpm lint:check
```

Extraction requires the already-fetched `b07016d` commit and its parent. It uses the existing `typescript6` compiler API in `@gadgets/scripts`; this is build tooling, not a runtime dependency. Generated dictionaries and `scripts/i18n/extract-report.md` are deterministic. Add reviewed translations for new UI to `scripts/i18n/supplemental.ts`, then regenerate. Do not manually edit generated dictionaries. The report retains every unmatched old/new line for manual review, including interpolated templates whose placeholder mapping cannot be assumed.

Phase 1 wires `Sidebar.tsx`, `routes/__root.tsx`, and the new language preference at `/profile`. Other components and gatekeeper-provided titles retain their existing text until migrated.
