// @celsian/rpc, Server-side error classes

/**
 * Thrown by {@link decode} when a wire payload cannot be safely decoded,
 * currently, when it nests deeper than the decoder's depth cap.
 *
 * Both `handle()` call sites wrap decoding in try/catch and turn any throw into
 * a clean `400 PARSE_ERROR`, so this never reaches a client verbatim.
 */
export class WireDecodeError extends Error {
  readonly code = "WIRE_DECODE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "WireDecodeError";
  }
}
