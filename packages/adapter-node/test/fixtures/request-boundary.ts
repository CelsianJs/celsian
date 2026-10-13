// @celsian/adapter-node -- isolated raw HTTP boundary probe

import { Server } from "node:http";
import { connect } from "node:net";
import { createApp } from "../../../core/src/app.js";
import { serve } from "../../src/index.js";

const host = process.argv[2] ?? "127.0.0.1";
const targets = JSON.parse(process.argv[3] ?? "[]") as string[];
const app = createApp();
app.get("/*", (req, reply) =>
  reply.json({ url: req.url, rawUrl: req.headers.get("x-adapter-url"), host: req.headers.get("host") }),
);
app.get("/", (req, reply) =>
  reply.json({ url: req.url, rawUrl: req.headers.get("x-adapter-url"), host: req.headers.get("host") }),
);
const handle = app.handle.bind(app);
app.handle = async (req) => {
  req.headers.set("x-adapter-url", req.url);
  if (new URL(req.url).pathname === "//healthy") {
    return Response.json({ url: req.url, host: req.headers.get("host") });
  }
  if (req.url.endsWith("/handler-failure")) throw new Error("handler failed");
  if (req.url.endsWith("/response-failure")) {
    const response = new Response("unused");
    Object.defineProperty(response, "headers", {
      get() {
        throw new Error("response failed");
      },
    });
    return response;
  }
  if (req.url.endsWith("/stream-failure")) {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          setTimeout(() => controller.error(new Error("stream failed")), 10);
        },
      }),
    );
  }
  return handle(req);
};

// The adapter intentionally returns void; locate its ephemeral listener for teardown.
const startup = new Promise<string>((resolve) => {
  console.log = (line: string) => resolve(line);
});
serve(app, { host, port: 0 });
const startupLine = await startup;
const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
const server = handles.find((value) => value instanceof Server) as Server;
const address = server.address();
if (!address || typeof address === "string") throw new Error("missing server address");
const boundPort = address.port;

async function raw(line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(boundPort, host);
    let response = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("request timed out")));
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
    socket.write(`${line}\r\nHost: conflicting.test\r\nConnection: close\r\n\r\n`, "latin1");
  });
}

const results: Array<{ response: string; healthy: string }> = [];
for (const target of targets) {
  const response = await raw(target);
  const healthy = await raw("GET /healthy HTTP/1.1");
  results.push({ response, healthy });
}
await new Promise<void>((resolve) => server.close(() => resolve()));
process.stdout.write(JSON.stringify({ port: address.port, startupLine, results }));
