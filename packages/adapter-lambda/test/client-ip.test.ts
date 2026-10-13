// @celsian/adapter-lambda, request.ip comes from the event's source IP

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import {
  type ALBEvent,
  type APIGatewayProxyEventV1,
  type APIGatewayProxyEventV2,
  createLambdaHandler,
} from "../src/index.js";

function ipApp() {
  const app = createApp();
  app.get("/ip", (req) => ({ ip: req.ip ?? null }));
  return app;
}

async function ipFrom(event: APIGatewayProxyEventV2 | APIGatewayProxyEventV1 | ALBEvent): Promise<unknown> {
  const result = await createLambdaHandler(ipApp())(event);
  return JSON.parse(result.body ?? "null");
}

describe("@celsian/adapter-lambda request.ip", () => {
  it("is requestContext.http.sourceIp for an HTTP API (v2) event", async () => {
    const event: APIGatewayProxyEventV2 = {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/ip",
      rawQueryString: "",
      headers: { host: "api.example.com", "x-forwarded-for": "6.6.6.6" },
      isBase64Encoded: false,
      requestContext: {
        http: { method: "GET", path: "/ip", protocol: "HTTP/1.1", sourceIp: "198.51.100.23", userAgent: "test" },
        requestId: "r1",
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
    };

    expect(await ipFrom(event)).toEqual({ ip: "198.51.100.23" });
  });

  it("is requestContext.identity.sourceIp for a REST API (v1) event", async () => {
    const event: APIGatewayProxyEventV1 = {
      httpMethod: "GET",
      path: "/ip",
      headers: { host: "api.example.com" },
      requestContext: { requestId: "r2", identity: { sourceIp: "198.51.100.24" } },
    };

    expect(await ipFrom(event)).toEqual({ ip: "198.51.100.24" });
  });

  it("is undefined for an ALB event, which carries the client only in X-Forwarded-For", async () => {
    const event: ALBEvent = {
      httpMethod: "GET",
      path: "/ip",
      headers: { host: "api.example.com", "x-forwarded-for": "198.51.100.25" },
      requestContext: { elb: { targetGroupArn: "arn:aws:elasticloadbalancing:::targetgroup/x" } },
    };

    expect(await ipFrom(event)).toEqual({ ip: null });
  });

  it("reads X-Forwarded-For on ALB when the app opts in with clientIp", async () => {
    const app = createApp({ clientIp: { header: "x-forwarded-for" } });
    app.get("/ip", (req) => ({ ip: req.ip ?? null }));
    const event: ALBEvent = {
      httpMethod: "GET",
      path: "/ip",
      headers: { host: "api.example.com", "x-forwarded-for": "6.6.6.6, 198.51.100.25" },
      requestContext: { elb: { targetGroupArn: "arn:aws:elasticloadbalancing:::targetgroup/x" } },
    };

    const result = await createLambdaHandler(app)(event);

    expect(JSON.parse(result.body ?? "null")).toEqual({ ip: "198.51.100.25" });
  });
});
