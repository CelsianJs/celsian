// benchmarks/frameworks.ts - Single registry of benchmark target servers.
//
// Shared by run.ts (spawns one child process per framework), server-runner.ts
// (the child entry point) and mem.ts (isolated RSS measurement).

import { startBenchServer } from "./server.js";
import { startExpressServer } from "./server-express.js";
import { startFastifyServer } from "./server-fastify.js";
import { startHonoServer } from "./server-hono.js";

export type ServerStarter = (port: number) => Promise<{ close: () => Promise<void> }>;

export interface FrameworkDef {
  /** argv-friendly id, e.g. "celsian" */
  id: string;
  /** display name used in tables */
  label: string;
  start: ServerStarter;
}

export const frameworks: FrameworkDef[] = [
  { id: "celsian", label: "CelsianJS", start: startBenchServer },
  { id: "express", label: "Express", start: startExpressServer },
  { id: "fastify", label: "Fastify", start: startFastifyServer },
  { id: "hono", label: "Hono", start: startHonoServer },
];

export function getFramework(id: string): FrameworkDef | undefined {
  return frameworks.find((f) => f.id === id);
}
