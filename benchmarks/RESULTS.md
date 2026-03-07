# CelsianJS Benchmark Results

**Date:** 2026-03-06
**Node.js:** v22.13.1
**Platform:** macOS Darwin 25.2.0 (Apple Silicon)
**Config:** 10 connections, 10s per scenario

## Comparative Results

### JSON hello (GET /json)

| Framework    |      Req/s | P50 (ms) | P99 (ms) |
| ------------ | ---------- | -------- | -------- |
| Fastify      |     39,078 |      0.0 |      3.0 |
| Hono         |     33,010 |      0.0 |      4.0 |
| CelsianJS    |     22,590 |      0.0 |      3.0 |

### Params (GET /users/:id)

| Framework    |      Req/s | P50 (ms) | P99 (ms) |
| ------------ | ---------- | -------- | -------- |
| Fastify      |     38,730 |      0.0 |      3.0 |
| Hono         |     32,707 |      0.0 |      5.0 |
| CelsianJS    |     16,975 |      0.0 |      6.0 |

### Body parse (POST /echo with JSON)

| Framework    |      Req/s | P50 (ms) | P99 (ms) |
| ------------ | ---------- | -------- | -------- |
| Fastify      |     23,411 |      0.0 |      6.0 |
| Hono         |     15,217 |      0.0 |      7.0 |
| CelsianJS    |     10,096 |      0.0 |     10.0 |

### Hooks chain (GET /hooks with 3 onRequest hooks)

| Framework    |      Req/s | P50 (ms) | P99 (ms) |
| ------------ | ---------- | -------- | -------- |
| Fastify      |     35,594 |      0.0 |      4.0 |
| Hono         |     29,677 |      0.0 |      6.0 |
| CelsianJS    |     10,824 |      0.0 |     12.0 |

### Not found (GET /nonexistent)

| Framework    |      Req/s | P50 (ms) | P99 (ms) |
| ------------ | ---------- | -------- | -------- |
| Fastify      |     36,102 |      0.0 |      3.0 |
| Hono         |     31,090 |      0.0 |      5.0 |
| CelsianJS    |     20,075 |      0.0 |      8.0 |

## Summary

| Framework | JSON Req/s | vs Fastify |
| --------- | ---------- | ---------- |
| Fastify   | 39,078     | 100%       |
| Hono      | 33,010     | 84%        |
| CelsianJS | 22,590     | 58%        |

## Known Bottlenecks

1. **Web Standard API overhead**: CelsianJS creates Request → CelsianRequest proxy and Response objects per request. Fastify operates directly on Node.js http objects.
2. **buildRequest() proxy creation**: Each request creates a delegation object with ~15 getters.
3. **Hooks chain allocation**: Running hooks requires iterating arrays and checking early-return responses.
4. **Body parsing**: CelsianJS reads the full body as text then parses (double allocation). Fastify parses directly from the stream.

## Optimization Opportunities

- Pre-compile static route handler chains (skip hook iteration for routes with no hooks)
- Pool/reuse CelsianRequest objects
- Skip body-size-limit checking when Content-Length is below limit
- Avoid creating new Response objects in the onSend merge path (fixed in this session — reduced hooks overhead by 32%)
