// celsian -- Meta-package re-exports
//
// This file deliberately re-exports with `export *` rather than naming each
// symbol. The hand-maintained list it replaced had drifted badly: it carried 33
// of core's 65 exports, so `celsian.upload` and `celsian.createSSEHub` were
// `undefined` even though `packages/core/README.md` documents both. Every
// feature added to core since that list was last touched was invisible to
// anyone who installed the umbrella package, and nothing failed loudly to say
// so.
//
// `export *` means the umbrella cannot drift again. `@celsian/core` and
// `@celsian/schema` share no export names, so there is nothing to disambiguate
// (a future collision would surface as a build error here, not a silent shadow).
export * from "@celsian/core";
export * from "@celsian/schema";
