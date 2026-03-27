// @celsian/rpc — Pure fetch-based RPC client proxy

import { decode, encode } from "./wire.js";

export interface RPCClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export function createRPCClient<TRouter>(options: RPCClientOptions = {}): RPCClientProxy<TRouter> {
  const baseUrl = options.baseUrl ?? "http://localhost:3000/_rpc";
  const fetchFn = options.fetch ?? globalThis.fetch;
  const defaultHeaders = options.headers ?? {};

  function createProxy(path: string[] = []): unknown {
    return new Proxy(() => {}, {
      get(_target, prop: string) {
        if (prop === "then") return undefined;

        if (prop === "query") {
          return async (input?: unknown) => {
            const procedurePath = path.join(".");
            const url = new URL(`${baseUrl}/${procedurePath}`);
            if (input !== undefined) {
              url.searchParams.set("input", JSON.stringify(encode(input)));
            }
            const res = await fetchFn(url.toString(), {
              headers: { ...defaultHeaders },
            });
            const data: any = await res.json();
            if (data.error) throw new RPCError(data.error);
            return decode(data.result);
          };
        }

        if (prop === "mutate") {
          return async (input?: unknown) => {
            const procedurePath = path.join(".");
            const url = `${baseUrl}/${procedurePath}`;
            const res = await fetchFn(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...defaultHeaders,
              },
              body: JSON.stringify(encode(input)),
            });
            const data: any = await res.json();
            if (data.error) throw new RPCError(data.error);
            return decode(data.result);
          };
        }

        return createProxy([...path, prop]);
      },

      apply(_target, _thisArg, args) {
        const procedurePath = path.join(".");
        const input = args[0];
        const url = `${baseUrl}/${procedurePath}`;

        return fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...defaultHeaders,
          },
          body: JSON.stringify(encode(input)),
        }).then(async (res) => {
          const data: any = await res.json();
          if (data.error) throw new RPCError(data.error);
          return decode(data.result);
        });
      },
    });
  }

  return createProxy() as RPCClientProxy<TRouter>;
}

export class RPCError extends Error {
  code: string;
  issues?: Array<{ message: string; path?: (string | number)[] }>;

  constructor(error: {
    message: string;
    code: string;
    issues?: Array<{ message: string; path?: (string | number)[] }>;
  }) {
    super(error.message);
    this.name = "RPCError";
    this.code = error.code;
    this.issues = error.issues;
  }
}

// ─── Type-level proxy ───

type RPCClientProxy<T> = {
  [K in keyof T]: T[K] extends { type: "query"; handler: (opts: { input: infer I; ctx: unknown }) => Promise<infer O> }
    ? { query(input: I): Promise<O> }
    : T[K] extends { type: "mutation"; handler: (opts: { input: infer I; ctx: unknown }) => Promise<infer O> }
      ? { mutate(input: I): Promise<O> }
      : T[K] extends Record<string, unknown>
        ? RPCClientProxy<T[K]>
        : never;
};
