// @celsian/core -- Isolated Node request-boundary regression fixture

import { ServerResponse } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app.js";
import { serve } from "../../src/serve.js";

const [target = "/", mode = "http", host = "127.0.0.1", hostHeader = "conflicting.test"] = process.argv.slice(2);
const app = createApp({ logger: false });
const echo = (req: Request & { query: unknown }) => ({ url: req.url, host: req.headers.get("host"), query: req.query });
app.get("/", echo);
app.get("/ok", echo);
app.get("/encoded/:value", echo);
app.ws("/ok", {
  open: (conn) => {
    if (mode === "upgrade-open") throw new Error("upgrade handler failed");
    conn.close();
  },
});

if (mode === "conversion") {
  const OriginalRequest = globalThis.Request;
  globalThis.Request = new Proxy(OriginalRequest, {
    construct() {
      globalThis.Request = OriginalRequest;
      throw new TypeError("request conversion failed");
    },
  });
}
if (mode === "static-write") {
  const original = ServerResponse.prototype.setHeader;
  ServerResponse.prototype.setHeader = (...args) => {
    ServerResponse.prototype.setHeader = original;
    throw new Error(`static response failed: ${args[0]}`);
  };
}
if (mode === "response-before" || mode === "response-after") {
  app.get(
    "/failure",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            if (mode === "response-after") {
              controller.enqueue(new TextEncoder().encode("partial"));
              setTimeout(() => controller.error(new Error("response failed")), 20);
            } else controller.error(new Error("response failed"));
          },
        }),
      ),
  );
}

let port = 0;
const server = await serve(app, {
  host,
  port: 0,
  shutdownTimeout: 1_500,
  ...(mode === "upgrade-open" || mode === "upgrade-invalid-host" ? { allowMissingOrigin: true } : {}),
  ...(mode === "static-write" || mode === "static" ? { staticDir: fileURLToPath(new URL(".", import.meta.url)) } : {}),
  onReady: (info) => {
    port = info.port;
  },
});

async function raw(requestTarget: string, upgrade = false, authority = hostHeader): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    let data = "";
    socket.setTimeout(3_000, () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("close", () => resolve(data));
    socket.on("connect", () =>
      socket.write(
        `${requestTarget}\r\n${authority ? `Host: ${authority}\r\n` : ""}${
          upgrade
            ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            : "Connection: close\r\n"
        }\r\n`,
      ),
    );
  });
}

const first = await raw(
  target,
  mode.startsWith("upgrade"),
  mode === "upgrade-invalid-host" ? "example.test:99999" : hostHeader,
);
const healthy = await raw("GET /ok HTTP/1.1");
const bound = await raw("GET /ok HTTP/1.0", false, "");
const start = Date.now();
await server.close();
console.log(
  JSON.stringify({
    first,
    healthy,
    bound,
    port,
    closeMs: Date.now() - start,
    connections: app.wsRegistry.getConnectionCount(),
  }),
);
