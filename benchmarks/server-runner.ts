// benchmarks/server-runner.ts - Child-process entry point for one benchmark server.
//
// Usage: tsx benchmarks/server-runner.ts <framework-id> <port>
//
// run.ts spawns this so that each framework is measured in a FRESH process that
// does not share a V8 heap, JIT state or an event loop with the load generator
// or with any other framework.

import { getFramework } from "./frameworks.js";

const id = process.argv[2];
const port = Number(process.argv[3]);

if (!id || !Number.isInteger(port) || port <= 0) {
  console.error("usage: server-runner.ts <framework-id> <port>");
  process.exit(2);
}

const fw = getFramework(id);
if (!fw) {
  console.error(`unknown framework "${id}"`);
  process.exit(2);
}

const server = await fw.start(port);

const shutdown = () => {
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Tell the parent we are listening. The parent still polls the health endpoint
// before measuring, this is only a fast-path signal.
console.log(`ready ${port}`);
