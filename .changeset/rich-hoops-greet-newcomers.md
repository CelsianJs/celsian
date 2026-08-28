---
"create-celsian": patch
"@celsian/core": patch
---

Three first-run fixes, two of which change behaviour. Read those two before upgrading.

**BEHAVIOUR CHANGE: the dev server now binds `127.0.0.1` instead of the name
`localhost`.** Node stopped reordering resolver results in v17, so
`listen("localhost")` binds whichever family DNS returns first, in practice
`::1` alone. The server printed `http://[::1]:3000` and answered
`http://localhost:3000`, while `curl http://127.0.0.1:3000` was refused, which
is the address most tooling, documentation and muscle memory reaches for. The
`basic` template sets no `HOST`, so the simplest template was the one that
broke. Binding the IPv4 literal serves both spellings: a client that resolves
`localhost` to `::1` first falls back to `127.0.0.1` when that connection is
refused. Anything binding the dev default and then connecting to `::1`
explicitly must now set `HOST=::1`. Production is untouched: `0.0.0.0` under
`NODE_ENV=production`, and the loopback-in-production warning still fires.

**BEHAVIOUR CHANGE: `create-celsian` now refuses an argv it used to accept
silently.** `npm create celsian@latest my-api --template basic` never delivers
the flag. npm claims every flag after the package name unless a `--` separates
them, so it ate `--template` and passed the value through as a bare positional.
That positional was discarded and the default `full` template was scaffolded
instead, with no warning: a user who asked for a minimal server got JWT, CSRF
and a Dockerfile. A second positional is now an error that names the likely
cause and prints both invocations that survive npm's parsing, and nothing is
written to disk. Inferring the template from the leftover would only move the
guess one level up, where a wrong guess is invisible again. `--template=<id>`,
`-t <id>` and `-t=<id>` are now honoured (the README already documented `-t`,
and both spellings previously fell through to `full`), and an unknown flag is
an error rather than being ignored.

**A port that is already in use now explains itself.** `PORT=3000 npm run dev`
against a taken port surfaced as `unhandledRejection, shutting down` plus a
`node:net` stack, which reads like the framework crashed. `serve()` now rejects
with a `ServeListenError` carrying one plain line ("Port 3000 is already in
use ... pick another port with PORT=3001"), the original Node error is kept as
`cause`, and the fatal handler prints that line on its own without the crash
framing. `EACCES` on a privileged port and `EADDRNOTAVAIL` on a host this
machine does not own get the same treatment. The exit code is still non-zero
and unrecognised listen failures are passed through untouched.
