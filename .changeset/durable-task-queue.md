---
"@celsian/queue-redis": minor
"@celsian/core": minor
---

Make the durable task queue actually durable.

- **Dead-letter queue.** Jobs that exhaust their retries are moved to a dead-letter queue with the final error and the full attempt history, instead of being logged and acked away. Both the in-memory and Redis backends implement `deadLetter`, `listDeadLetters`, `redriveDeadLetter`, `redriveDeadLetters`, `purgeDeadLetters` and `deadLetterSize`. New `onFailure` and `onDeadLetter` worker hooks report every failed attempt and every dead-lettered job.
- **Atomic delayed-message promotion (Redis).** `promoteDelayed` used `pipeline()`, which batches but is not atomic, so every concurrent worker duplicated each delayed retry, and removal by score range silently deleted messages pushed into the window. It is now a single Lua script that removes by member and gates promotion on `ZREM`.
- **Lease tokens and heartbeats.** Each delivery gets a distinct lease token; `ack`, `nack` and `extend` only affect the delivery that owns the lease, so a slow worker can no longer complete the job another worker has taken over. Tasks receive `ctx.heartbeat()` and the worker heartbeats automatically.
- **At-least-once in-memory backend.** `MemoryQueue` reclaims and redelivers messages whose lease expires rather than losing them, and its durability limits are documented honestly in code.
- **Task timeouts.** Tasks now default to a timeout below the queue's visibility timeout, the timer is always cleared, and a timed-out task is cancelled through `ctx.signal` instead of merely losing a race while continuing to run. Registering a task whose timeout is not below the visibility timeout throws unless `longRunning: true` is set.
- **Loud shutdown.** A worker that hits its drain deadline reports exactly how many jobs it abandoned, on both the logger and `console.error`.
- **Serverless cron warning.** `CronScheduler.start()` detects Cloudflare Workers, AWS Lambda, Vercel, Netlify, Deno Deploy and Cloud Run, and warns that its in-process timer will never fire there, naming the platform-native alternative.
