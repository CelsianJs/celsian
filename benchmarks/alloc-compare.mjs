// What makes a `--compare` row of the allocation gate like for like.
//
// Within a scenario every framework must answer with the same status, every
// header with the same value, and the same body bytes as CelsianJS, or the
// counts beside each other measure different work. alloc-gate.mjs stops the
// run when they do not; this is the check it makes, kept apart so that
// alloc-compare.test.mjs can hold it to that.

/** The parts of a response, as alloc-gate.mjs's describeResponse() records them, that must match. */
export const LIKE_FOR_LIKE = Object.freeze(["status", "headers", "body"]);

/**
 * Why `wire` (what `framework` answered) is not like for like with
 * `celsianWire`, as the message the run stops with, or `undefined` when it is.
 */
export function notLikeForLike(scenario, framework, wire, celsianWire) {
  for (const key of LIKE_FOR_LIKE) {
    if (wire[key] !== celsianWire[key]) {
      return (
        `${scenario}: not like for like. ${framework} answered with ${key} ${JSON.stringify(wire[key])}, ` +
        `celsian with ${JSON.stringify(celsianWire[key])}. Make the servers in alloc-server.mjs answer alike.`
      );
    }
  }
  return undefined;
}
