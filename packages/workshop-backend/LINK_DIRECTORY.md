# Private links directory

`AuthenticatedApi.getLinkDirectory()` mints a Cap'n Web capability for the signed-in user's
private directory. The frontend reaches it over the existing authenticated RPC connection;
there is no REST endpoint and no caller-supplied user identifier. `/links` is protected by the
existing root route's authentication guard.

## Storage and migration

Each user has one `LinkDirectoryDurableObject`, addressed through `ctx.exports` using the
immutable authenticated `UserDurableObject` ID string. This follows the existing per-entity
SQLite DO model and keeps directory code out of the user account implementation. D1 would
introduce the repository's first D1 binding, deployment inputs, and a separate migration path
without providing a benefit for this private, bounded directory.

Wrangler migration `v3` registers the class in `new_sqlite_classes`. On first activation,
schema version 1 creates `link_categories`, `links`, and the category/order index in a
`transactionSync`, then records `schemaVersion` in that same transaction. Subsequent activations
retain the tables and data. Future schema versions should extend this constructor migration;
Wrangler class migrations and per-instance SQL schema migrations are distinct concerns.

The release manifest golden file includes this new class migration. There are no new secrets,
environment variables, service bindings, dependencies, or setup commands beyond the existing
application build and deployment process.

## Behavior

- Categories and links support listing, creation, editing, deletion, and ordering.
- Empty queries list everything; literal, case-insensitive queries search title, URL, tags, and note.
- Moves use a destination category and a sibling ID (or null for the end). They operate on the
  latest server state atomically, avoiding overwriting unrelated edits from stale client snapshots.
- Only empty categories can be deleted; deletion never silently cascades through saved links.
- Shared named limits bound all input strings, tag count, categories, and links. URLs must be
  absolute HTTP(S) and cannot contain embedded credentials. Favicon URLs are derived from the
  normalized destination origin. The icon is server-managed metadata, not an arbitrary fetch URL.
- The browser fetches `/favicon.ico` from that origin with no referrer. The Worker does not fetch
  icons. `global_fetch_strictly_public` changes Worker global-fetch routing to the public Internet;
  it does not govern browser image requests. Failed favicons display the title's first character.
- Drag handles reorder categories and links, including moves to empty categories. Arrow buttons
  offer equivalent within-category ordering, and the editor's category selector supports moves
  across categories using a keyboard or touch. Layout uses responsive Kumo surfaces and controls.
- Capabilities are pipelined and disposed after each request. Failed writes keep the form open;
  committed writes with failed refreshes close it and offer a reload to avoid duplicate creation.
- New failure logs follow the Phase 7 request's `[processName] failed` console convention and
  omit URLs, notes, tags, and other submitted contents.

## Agent integration decision

Agent search/add tools are deferred to a dedicated gatekeeper phase. The existing Context
Library has two distinct surfaces: `ContextAccount.startAppUi()` supplies management authority,
while `ContextGatekeeper.startSession()` and `LibraryReadSession` give the agent a separately
authorized read capability. Reads call `authorizeObservation()` and track observer access.
The deployment's provisioning policy, rather than the gatekeeper itself, determines whether a
singleton is ambient. Agent writes in the gatekeeper architecture also participate in the
approval queue instead of inheriting a UI's immediate write authority.

Passing this directory's management capability directly to an agent would bypass those
observation, sharing, and approval boundaries. A complete integration needs a user-configured
links resource, observer verification for private links, and an approval-backed add action,
with tests covering shared workspaces and rejected actions. None of those paths are partially
installed here. The current capability is only minted for the authenticated UI.

## Development and verification

From the repository root, using the required Node 24 installation:

```sh
PATH="/usr/local/bin:$PATH" pnpm dev-server
PATH="/usr/local/bin:$PATH" pnpm --dir packages/workshop-backend exec vitest run __tests__/link-directory.test.ts
PATH="/usr/local/bin:$PATH" pnpm --dir packages/workshop-frontend exec vitest run src/pages/links/LinksPage.test.tsx
PATH="/usr/local/bin:$PATH" pnpm build
PATH="/usr/local/bin:$PATH" VP_RUN_CONCURRENCY_LIMIT=4 pnpm test
PATH="/usr/local/bin:$PATH" pnpm lint:check
```

The TanStack Vite plugin generates `src/routeTree.gen.ts` when the frontend build/test/dev
configuration loads; do not edit that file manually. The backend test uses the existing
workerd pool and actual SQLite Durable Objects, including eviction and migration persistence.
The frontend tests mount the actual `/links` route with the real Kumo components and i18n;
only authentication/transport and site configuration are mocked.
