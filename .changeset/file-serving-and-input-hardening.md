---
"@celsian/core": minor
---

Confine file serving, harden router paths, and tighten CSRF, SSE, uploads, cookies and redirects.

Sprint Track 2 shipped these without a changeset, so none of them reached the
generated changelog. Every item below can reject a request that previously
succeeded, so read this before upgrading.

- **`reply.sendFile()` / `reply.download()` are confined to a root.** The
  resolved path must stay inside `options.root` (default: the process CWD).
  An escape is a 403, a missing file is a 404. Symlinks pointing outside the
  root are refused unless `followSymlinks: true` is passed. Previously any path
  a handler produced was served, so a handler interpolating user input into a
  path served arbitrary files.
- **`reply.redirect()` validates its target.** Protocol-relative targets
  (`//evil.example`) and absolute URLs to hosts outside `options.allowedHosts`
  are rejected with a 400 instead of becoming an open redirect. Relative paths
  are unaffected.
- **Aliased request paths no longer resolve.** `//admin`, `/./admin` and
  `/admin//` used to reach the same handler as `/admin`, which lets a request
  walk around an upstream gateway rule written against the canonical path. They
  are now 404s. Plain trailing-slash tolerance is preserved and configurable via
  the router's `ignoreTrailingSlash` (default `true`, matching pre-0.6.0).
- **New `strictParams` router option.** With it enabled, a route param that
  percent-decodes to a value containing `/`, `\` or NUL is a 400. `%2F` inside a
  single segment decodes back into a slash, which is how a "one segment" param
  turns into a traversal payload. Off by default because runtimes differ in
  whether they pre-decode the path.
- **Malformed percent-encoding in a matched param is a 400.** `MALFORMED_URI`,
  rather than an uncaught `URIError` crashing the request.
- **Duplicate and conflicting route registrations throw.** Registering the same
  method and path twice used to silently replace the first handler. Two sibling
  routes declaring different param names at the same position (`/a/:id` and
  `/a/:slug`) also throw, because only the first name was ever populated and the
  second arrived `undefined` at runtime.
- **Cookies default to `Secure`.** `serializeCookie()` no longer infers
  "not production" from `NODE_ENV`, which is routinely unset in containers and
  shipped session cookies with no `Secure` flag. See the follow-up release note
  for how this default now derives from the request protocol.
- **CSRF tokens are bound to the session.** A token is re-issued whenever the
  session id changes, so a token minted before login is useless after it.
  State-changing requests announcing themselves as cross-site via
  `Sec-Fetch-Site` or a mismatched `Origin` are rejected with a 403 before the
  token is even checked.
- **SSE fields are sanitized.** CR/LF is stripped from `event:` and `id:`, and
  `retry:` only emits finite numbers. A newline smuggled into any of them could
  close the frame and forge extra events into a victim's stream.
- **Uploads enforce limits and verify content.** `maxFiles` and per-file size
  limits return 413, a MIME allowlist returns 415, and file bytes are sniffed
  for magic-byte signatures so a declared content type that contradicts the
  content is refused. `file.filename` is now a sanitized basename with path
  separators, NUL, control characters and leading dots removed; the raw,
  attacker-controlled value is preserved on a separate field.
- **ETags use SHA-256 truncated to 128 bits.** The previous 32-bit
  non-cryptographic hash collided easily, and an ETag collision serves a 304 for
  content that changed.
- **413 responses name the limit.** The body reports the byte limit and the
  config key that raises it, instead of a bare "Payload Too Large".
- **Swagger UI assets are pinned with subresource integrity.** Exact version
  plus `sha384` SRI hashes, so a compromised CDN cannot inject script into the
  docs page. `/docs` remains unauthenticated by default and the option docs now
  say to gate it in production.
