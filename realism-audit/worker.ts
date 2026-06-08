// Cloudflare Worker entry point
import { buildApp } from "./app.js";
import { createCloudflareHandler } from "../packages/adapter-cloudflare/src/index.js";

const { app } = buildApp();
await app.ready();

export default createCloudflareHandler(app);
