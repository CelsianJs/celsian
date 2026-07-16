# @celsian/schema

## 0.5.5

## 0.5.4

### Patch Changes

- 74898eb: Fail loud instead of silently pretending to work (framework-wide silent-failure sweep):

  - **@celsian/schema**: `fromValibot()` now validates modern Valibot schemas (>=0.31, incl. 1.x) through the Standard Schema `~standard.validate()` contract. Previously it only tried the legacy `_parse`/`safeParse` methods — which modern Valibot no longer exposes — so every validation silently failed with a generic "Unknown valibot schema format" issue, rejecting valid input with no field-level detail. Async Valibot schemas now fail with a clear, explicit error instead of leaking a dangling Promise.
  - **@celsian/adapter-node**: the vestigial `nodeAdapter.buildEnd()` build hook now throws a clear not-implemented error directing callers to the runtime `serve()` export, instead of logging "Generated server entry" while writing nothing to disk.

## 0.5.3

## 0.5.2

## 0.5.1
