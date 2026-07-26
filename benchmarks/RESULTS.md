# CelsianJS Benchmark Results

**Date:** 2026-07-26 (first run of the rewritten harness)
**Node.js:** v24.18.0
**Platform:** macOS Darwin, Apple M5 Max, 18 cores
**Config:** 10 connections, 5s measured per pass, 2s discarded warmup, n=5 repetitions
**Frameworks:** CelsianJS (workspace), Express 5.x, Fastify 5.x, Hono 4.x

> Reproduce: `pnpm bench` (throughput) and
> `for fw in celsian express fastify hono; do NODE_OPTIONS=--expose-gc npx tsx benchmarks/mem.ts $fw; done` (memory).

---

## Retraction: "1.25x to 2.3x faster than Express"

**That claim is withdrawn. It was produced by a benchmark harness that could not support it, and
when the harness is fixed the result reverses: CelsianJS is currently SLOWER than Express in every
scenario we measure.**

The old harness (before 2026-07-26) had four defects, each of which is on its own enough to
invalidate a published comparison:

1. **Failures were invisible.** `run.ts` read `result.requests.average` and never looked at
   `errors`, `timeouts` or `non2xx`. A server that returned nothing but 500s, or that answered zero
   requests, was reported as a normal row in the table. One audit run recorded 0 req/s and printed
   it without comment.
2. **No warmup.** The harness slept 300ms and started measuring, so a large share of every "result"
   was V8 interpreting cold code.
3. **N=1, published to five significant figures.** A single 10s pass per cell, no repetition, no
   standard deviation, and numbers like "51,897 req/s" written down as though that digit meant
   something.
4. **Shared process, fixed order.** All frameworks ran in ONE process, in the same order every time,
   competing with autocannon for CPU. The file itself documented (in its own comments) that exactly
   this bias had already produced a bogus memory table. The same bias was never fixed for
   throughput, which is the number that got published.

Across three audit runs of the old harness, Express beat CelsianJS in 9 of 10 intra-run scenario
comparisons. The published table said the opposite.

This is the same class of error as the memory-table correction below, and it is being handled the
same way: the claim comes down, the methodology is written out, and the numbers get republished only
when they can be defended.

---

## Methodology (rewritten 2026-07-26)

`benchmarks/run.ts` now does the following:

- **Process isolation.** Each framework server runs in its own child process
  (`benchmarks/server-runner.ts`, spawned per measurement), so a server never shares a V8 heap, JIT
  state or event loop with autocannon or with another framework.
- **Readiness polling, not sleeping.** The harness polls `GET /json` until it answers 200 (30s
  ceiling) before any load is applied.
- **Real warmup.** Every measured pass is preceded by a 2s autocannon pass against the same
  endpoint, whose result is discarded.
- **Repetition and statistics.** Every (framework, scenario) cell is measured 5 times. We report the
  median, the sample standard deviation as a percentage of the mean, the min/max, and a 95%
  confidence interval of the mean (Student t, df = n-1). All req/s figures are rounded to the
  nearest 100, which is already finer than this harness can resolve.
- **Randomized order.** The framework order is reshuffled at the start of every repetition, so no
  framework systematically absorbs thermal or warm-up bias.
- **Hard failure on bad HTTP.** Any autocannon result with non-zero `errors` or `timeouts`, or with
  unexpected status codes, is recorded as a violation and the process exits non-zero. The error
  scenario inverts the check: it requires that *every* response was non-2xx, so a framework cannot
  win that scenario by failing to run its error path.
- **No memory numbers.** `run.ts` does not report memory at all. See the memory section.

Configurable via `BENCH_REPS`, `BENCH_DURATION`, `BENCH_WARMUP`, `BENCH_CONNECTIONS`, and
`--frameworks celsian,express`.

---

## Throughput by scenario

Median of 5 runs, rounded to the nearest 100 req/s. "SD" is the sample standard deviation as a
percentage of the mean. "CI" is the 95% confidence interval half-width of the mean.
**Read the SD column before reading anything else.**

### JSON response

| Framework | Median req/s |  +/- CI | SD (%) |         Min .. Max |
| --------- | -----------: | ------: | -----: | -----------------: |
| Fastify   |      114,800 |  33,700 |   25.1 |  61,500 .. 127,300 |
| Hono      |      108,800 |  26,200 |   21.1 |  62,300 .. 112,500 |
| Express   |       79,400 |   5,600 |    5.7 |   71,800 .. 83,700 |
| CelsianJS |       62,100 |  21,000 |   31.5 |   27,700 .. 68,600 |

### Route params

| Framework | Median req/s |  +/- CI | SD (%) |         Min .. Max |
| --------- | -----------: | ------: | -----: | -----------------: |
| Fastify   |      116,900 |  27,900 |   21.1 |  68,000 .. 121,700 |
| Hono      |      109,400 |   8,400 |    6.4 |  95,600 .. 111,000 |
| Express   |       71,400 |   3,100 |    3.5 |   67,700 .. 74,700 |
| CelsianJS |       66,500 |  11,200 |   14.3 |   47,100 .. 68,300 |

### Middleware chain (5)

| Framework | Median req/s |  +/- CI | SD (%) |         Min .. Max |
| --------- | -----------: | ------: | -----: | -----------------: |
| Fastify   |      110,900 |  13,800 |   10.5 |  90,100 .. 116,600 |
| Hono      |       85,900 |   4,900 |    4.6 |   83,300 .. 93,400 |
| Express   |       61,500 |  19,600 |   26.1 |   35,300 .. 74,400 |
| CelsianJS |       61,100 |  16,500 |   24.4 |   31,600 .. 63,500 |

### JSON body parsing

| Framework | Median req/s |  +/- CI | SD (%) |         Min .. Max |
| --------- | -----------: | ------: | -----: | -----------------: |
| Fastify   |       80,500 |   2,500 |    2.5 |   79,700 .. 84,100 |
| Express   |       54,600 |  15,300 |   24.5 |   29,000 .. 59,300 |
| Hono      |       45,900 |  11,100 |   19.3 |   32,500 .. 55,100 |
| CelsianJS |       41,800 |  15,300 |   34.1 |   19,900 .. 46,700 |

### Error handling

| Framework | Median req/s |  +/- CI | SD (%) |         Min .. Max |
| --------- | -----------: | ------: | -----: | -----------------: |
| Hono      |       79,300 |   7,100 |    7.5 |   66,800 .. 80,900 |
| Fastify   |       71,600 |   1,700 |    1.9 |   70,400 .. 73,900 |
| Express   |       55,300 |   1,800 |    2.6 |   53,300 .. 57,200 |
| CelsianJS |       32,200 |   2,500 |    6.3 |   28,600 .. 34,100 |

All 100 measured passes were clean: no socket errors, no timeouts, and the expected status code on
every response.

## CelsianJS vs Express

CelsianJS ranks **last of the four frameworks in all five scenarios**.

| Scenario             | Celsian / Express (medians) | Paired per-repetition ratios | Reps CelsianJS won |
| -------------------- | --------------------------: | ---------------------------- | -----------------: |
| JSON response        |                       0.78x | 0.90 0.58 0.78 0.33 0.84     |                0/5 |
| Route params         |                       0.93x | 0.63 0.93 0.96 0.98 0.95     |                0/5 |
| Middleware chain (5) |                       0.99x | 0.90 1.01 0.93 0.83 0.85     |                1/5 |
| JSON body parsing    |                       0.77x | 0.77 0.92 0.34 0.90 0.78     |                0/5 |
| Error handling       |                       0.58x | 0.51 0.59 0.58 0.59 0.60     |                0/5 |

Express won **24 of 25** paired within-repetition comparisons. The absolute magnitudes on this
machine are noisy, but the direction is not: on a same-repetition, same-conditions basis, CelsianJS
lost almost everywhere.

The one result that is both large and statistically clean is **error handling**, where both
frameworks had a tight spread (CelsianJS SD 6.3%, Express SD 2.6%) and CelsianJS ran at **0.58x
Express**. The error path is not fast-pathed through `fast-response.ts`; that is a known gap and it
is the clearest, most reproducible deficit in the suite.

## Trustworthiness of this run

**These absolute numbers should not be published as precise figures, and no "Nx faster" claim of any
direction should be built on them.**

- The machine is a developer laptop that was running other builds and test suites concurrently. Load
  average was 8.8 at the start of the run and 7.6 at the end, on 18 cores.
- The worst relative standard deviation across the 20 cells was **34.1%**. Several cells contain a
  single depressed sample (Fastify's JSON response ranges 61,500 to 127,300 for the same code on the
  same machine). Those are scheduler contention artifacts, not framework behavior. The median is
  reported precisely because it survives them.
- The harness prints this assessment itself at the end of every run, from the measured spread. On a
  quiet machine we would expect the worst SD to be low single digits.

What that does and does not permit:

- **Not defensible:** any specific req/s number, and any ratio between two frameworks whose CIs
  overlap (which is most of them).
- **Defensible:** the ranking, because it is consistent across all 5 randomized repetitions and 25
  paired comparisons, and the error-handling gap, because that cell is tight for both frameworks.
- **Required before republishing any performance claim:** a run on an otherwise idle machine (ideally
  a dedicated box or CI runner with no other jobs), with the worst SD under about 5%.

## Memory usage (isolated, n=1)

Each framework runs in its own fresh process, driven by an external autocannon client so the load
generator's memory is not counted, then RSS and heap are read after a forced GC.

| Framework | RSS (MB) | Heap used (MB) |
| --------- | -------: | -------------: |
| CelsianJS |    328.1 |           19.2 |
| Express   |    164.2 |           20.7 |
| Fastify   |    138.3 |           23.1 |
| Hono      |    133.1 |           20.7 |

These are **single measurements on a loaded machine**, not repeated ones, so treat them as
indicative only. Retained heap is comparable across all four (19 to 23 MB). RSS is not: CelsianJS
sits at roughly twice Express and 2.5x Hono. RSS on a Node process includes a lot that is not
retained data, so this is a lead to investigate rather than a finding.

> **Correction (retained from the previous revision).** Earlier results reported CelsianJS at ~94 MB
> vs "2.5 MB" for Express. That was a **measurement artifact**, not real usage: the old `run.ts`
> hosted all servers in a single shared process and reported per-framework RSS *deltas*. Whichever
> framework ran first (CelsianJS) absorbed the entire one-time process warm-up (V8 heap growth, JIT,
> and autocannon's connection pools) while the others, running into an already-grown heap, showed
> impossibly small deltas. An absolute RSS of "2.5 MB" is below Node's ~40 MB floor. Memory is now
> measured only by `benchmarks/mem.ts`, in isolated processes.

## Known gaps in the harness

Stated plainly, because a benchmark that hides its own limits is how the last claim happened:

- Single machine, single Node version, no CI runner, no quiet-machine baseline.
- 10 connections and 5s passes. Neither high-concurrency behavior nor sustained-load behavior is
  covered here (`benchmarks/soak.ts` covers RSS under sustained load, nothing else).
- Only four frameworks, five hand-written scenarios, all trivially small payloads.
- The memory numbers are n=1.
- `benchmarks/` is not part of the repo's `pnpm typecheck` gate. It has its own
  `benchmarks/tsconfig.json` and is checked with `npx tsc -p benchmarks/tsconfig.json`, but nothing
  runs that automatically.

## Optimization leads

Unchanged from the previous revision, and now better motivated by the error-handling result:

- Fast-path the error response through `fast-response.ts`. Error handling is by far the weakest
  scenario (0.58x Express, and that number is one of the few we trust).
- Lightweight or lazy `Request` (defer header and URL materialization). This is the largest
  remaining structural cost of the Web Standard `Request`/`Response` round-trip on Node.
- `fast-json-stringify` for routes with a declared response schema.
- Stream body parsing instead of read-full-text-then-parse, to avoid double allocation on POST.
- Investigate the RSS gap against Express and Hono.
