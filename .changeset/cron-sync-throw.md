---
"@celsian/core": patch
---

A cron job that throws synchronously no longer takes the server down. The scheduler caught a rejected promise from a job but not a plain `throw` from a non-async handler. That throw skipped every other job due in the same minute and escaped the timer as an uncaught exception, which under `serve()` shuts the process down with exit code 1. It is now reported exactly like a rejection (`[celsian] Cron job error:` on `console.error`) and the remaining jobs run.
