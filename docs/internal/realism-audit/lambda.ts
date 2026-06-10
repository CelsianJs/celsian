// AWS Lambda entry point — deploy as a Lambda function handler
import { buildApp } from "./app.js";
import { createLambdaHandler } from "../../../packages/adapter-lambda/src/index.js";

const { app } = buildApp();
await app.ready();

export const handler = createLambdaHandler(app);
