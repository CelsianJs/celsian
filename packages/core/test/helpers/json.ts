// @celsian/core -- test helper: read a Response body as a typed JSON value.
//
// `Response.json()` is typed `Promise<unknown>` (undici / @types/node), which
// is correct: nothing about a wire response proves its shape. Tests do know
// the shape, so they state it once at the read site instead of re-narrowing at
// every property access.
//
// Pass the shape the route under test is expected to return, e.g.
// `await json<{ id: string }>(res)`. The default is deliberately weak so that
// a body whose shape is not asserted still reads as `unknown` per property.

export type JsonResponse = { json(): Promise<unknown> };

export async function json<T = Record<string, unknown>>(res: JsonResponse): Promise<T> {
  return (await res.json()) as T;
}
