// create-celsian — Centralized dependency version pins
// Single source of truth for the versions scaffolded into new projects.
// Keeping these here prevents drift across the individual templates.

/** Pin used for every Celsian package (celsian, @celsian/*). Tracks the unified
 *  fixed-group release line — bump in lockstep with the published version. */
export const CELSIAN_VERSION = "^0.5.0";

/** Third-party dependency pins shared across templates. */
export const DEPS = {
  typebox: "^0.34.0",
} as const;

/** Dev-dependency pins shared across templates. */
export const DEV_DEPS = {
  typescript: "^5.7.0",
  tsx: "^4.0.0",
  vitest: "^4.0.0",
  typesNode: "^22.0.0",
} as const;
