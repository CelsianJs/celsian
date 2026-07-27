---
"@celsian/jwt": minor
---

Close two cross-tenant authentication bypasses, and fail closed when a realm is ambiguous.

Both bypasses were reachable through the shape the plugin's own JSDoc documents,
and both are fixed.

- **A second realm could authenticate on the first realm's routes.** The realm
  census was documented as failing closed "the moment the answer becomes a
  guess", but it was only consulted when no scoped config was found. A realm
  registered WITHOUT a prefix creates a transparent context whose decorations
  propagate into the parent scope, so a scoped config was always present and the
  census never ran. Last registration won. Reproduced: tenant B's token returned
  200 on tenant A's route as its own subject, while tenant A's own token returned
  401 on that same route.
- **`app.jwt` bound app-wide to whichever realm registered first.** Core hoists
  decorations first-writer-wins, so a second tenant's login route calling the
  documented `app.jwt.sign()` minted a credential signed with the FIRST tenant's
  secret: valid on tenant A's protected routes, rejected by tenant B's own.
  `app.jwt` now throws once a second realm registers, naming `realm.sign()` /
  `realm.verify()` as the realm-bound alternative.

Internally, each realm now carries its own presence key rather than sharing one
symbol, so two realms covering the same route are both visible instead of one
silently overwriting the other.

**Behavior change.** Two realms registered WITHOUT prefixes on one app now refuse
to authenticate rather than appearing to isolate. That shape only ever produced
the right answer through a last-writer tie-break in scope resolution, which is
the same mechanism behind the bypass above, so it was never isolation. Give each
realm a prefix (`app.register(realm, { prefix: '/tenant-a' })`), or bind the
guard explicitly with `realm.guard()` or `createJWTGuard({ secret })`.

Single-realm apps are unaffected, and realms registered under distinct prefixes
keep working and isolating, both verified.
