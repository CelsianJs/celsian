---
"@celsian/core": minor
"@celsian/rate-limit": minor
---

Close an open redirect, a static-file symlink escape, an upload path escape, and two rate-limit key bypasses.

- **Open redirect via TAB, LF and CR.** `safeRedirectLocation` normalized `\` to
  `/` and rejected `//`, but a URL parser also DELETES ASCII tab, newline and
  carriage return before parsing. `/<TAB>/evil.com` passed validation and was
  emitted as a `Location`, and the browser resolved it to `https://evil.com/`.
  Those characters are now stripped before validation, to a fixed point.
- **`serve({ staticDir })` followed symlinks out of its root.** An earlier change
  hardened `reply.sendFile()` with `O_NOFOLLOW` and left the static path on a
  lexical check only, so the same process refused a symlinked file through
  `sendFile` (403) and served it through `staticDir` (200). Both paths now share
  one confinement helper, so they cannot drift apart again. Note a symlink INSIDE
  the served root is now also refused.
- **Upload filenames could escape the upload directory.** `sanitizeFileName`
  stripped leading dots BEFORE trimming whitespace, so a leading space shielded
  the dots and the trim then re-exposed them: `" .."` came back as `".."`, which
  joined onto the upload directory escapes it. Trimming and dot-stripping now run
  as a loop to a fixed point, and `.`, `..`, empty results, Windows reserved
  device names and trailing dots are all rejected.
- **`reply.redirect()` returned 500 on control characters**, against a docblock
  promising a 400; **`reply.download()` reported 404 for files that exist** when
  the filename was not Latin-1, and did not basename the filename or emit an RFC
  6266 `filename*`.
- **The cookie `Secure` warn-once set was unbounded** and keyed on the
  client-controlled `Host` header, so spoofed hosts grew it without limit.
- **The rate limiter handed its bucket key to the client.** When the forwarded
  chain was shorter than the configured hop count, the clamp selected the
  leftmost, fully client-supplied entry. That gave unlimited quota by rotating
  one header, and let an attacker exhaust a DIFFERENT user's bucket. It now fails
  closed. Separately, the key was raw header text, so `1.2.3.4`, `01.02.03.04`,
  `::ffff:1.2.3.4` and `1.2.3.4:<port>` each got their own bucket; keys are now
  canonicalized, and over-long custom keys are hashed rather than sharing one
  bucket.
