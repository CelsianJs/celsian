// @celsian/adapter-lambda — AWS Lambda adapter (API Gateway v2, v1/REST, and ALB)

import type { CelsianApp } from "@celsian/core";

/** API Gateway HTTP API (payload format 2.0) event. */
export interface APIGatewayProxyEventV2 {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  /** Request cookies — APIGW v2 strips `cookie` from headers and delivers them here. */
  cookies?: string[];
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: {
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    time: string;
    timeEpoch: number;
  };
}

/** API Gateway REST API (payload format 1.0) event. */
export interface APIGatewayProxyEventV1 {
  httpMethod: string;
  path: string;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId?: string;
    identity?: { sourceIp?: string; userAgent?: string };
    [key: string]: unknown;
  };
}

/** Application Load Balancer (Lambda target) event. */
export interface ALBEvent {
  httpMethod: string;
  path: string;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    elb: { targetGroupArn: string };
  };
}

/** Any Lambda HTTP event the adapter can handle. */
export type LambdaEvent = APIGatewayProxyEventV2 | APIGatewayProxyEventV1 | ALBEvent;

/** API Gateway v2 structured response. */
export interface APIGatewayProxyStructuredResultV2 {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

/** API Gateway v1 / ALB response. */
export interface APIGatewayProxyResultV1 {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body?: string;
  isBase64Encoded?: boolean;
}

export type LambdaResult = APIGatewayProxyStructuredResultV2 | APIGatewayProxyResultV1;

type EventShape = "v2" | "v1" | "alb";

/** Detect which Lambda event source produced the event. */
function detectEventShape(event: LambdaEvent): EventShape {
  const e = event as unknown as Record<string, unknown>;
  const requestContext = e.requestContext as Record<string, unknown> | undefined;
  if (e.version === "2.0" || (requestContext && typeof requestContext.http === "object" && requestContext.http)) {
    return "v2";
  }
  if (requestContext && typeof requestContext.elb === "object" && requestContext.elb) {
    return "alb";
  }
  return "v1";
}

/** Decode the event body: base64 bodies stay binary (never round-tripped through utf-8). */
function decodeBody(
  body: string | null | undefined,
  isBase64Encoded: boolean | undefined,
): string | Uint8Array | undefined {
  if (body === undefined || body === null || body === "") return undefined;
  if (isBase64Encoded) {
    const buffer = Buffer.from(body, "base64");
    // Pass raw bytes through — utf-8 decoding corrupts binary payloads
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return body;
}

function v2EventToRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value) headers.set(key, value);
  }

  // APIGW v2 delivers request cookies in event.cookies, not in headers
  if (event.cookies && event.cookies.length > 0 && !headers.has("cookie")) {
    headers.set("cookie", event.cookies.join("; "));
  }

  const host = headers.get("host") ?? "localhost";
  const rawProto = headers.get("x-forwarded-proto") ?? "https";
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : "https";
  const queryString = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${proto}://${host}${event.rawPath}${queryString}`;
  const method = event.requestContext.http.method;

  const body = decodeBody(event.body, event.isBase64Encoded);
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });
}

function v1EventToRequest(event: APIGatewayProxyEventV1 | ALBEvent): Request {
  const headers = new Headers();
  // multiValueHeaders take precedence (REST APIs / ALB with multi-value enabled)
  if (event.multiValueHeaders) {
    for (const [key, values] of Object.entries(event.multiValueHeaders)) {
      if (!values) continue;
      for (const value of values) {
        headers.append(key, value);
      }
    }
  }
  if (event.headers) {
    for (const [key, value] of Object.entries(event.headers)) {
      if (value && !headers.has(key)) headers.set(key, value);
    }
  }

  const host = headers.get("host") ?? "localhost";
  const rawProto = headers.get("x-forwarded-proto") ?? "https";
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : "https";

  const search = new URLSearchParams();
  if (event.multiValueQueryStringParameters) {
    for (const [key, values] of Object.entries(event.multiValueQueryStringParameters)) {
      if (!values) continue;
      for (const value of values) {
        search.append(key, value);
      }
    }
  } else if (event.queryStringParameters) {
    for (const [key, value] of Object.entries(event.queryStringParameters)) {
      if (value !== undefined) search.append(key, value);
    }
  }
  const queryString = search.toString();
  const url = `${proto}://${host}${event.path}${queryString ? `?${queryString}` : ""}`;
  const method = event.httpMethod;

  const body = decodeBody(event.body, event.isBase64Encoded);
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });
}

function lambdaEventToRequest(event: LambdaEvent, shape: EventShape): Request {
  return shape === "v2"
    ? v2EventToRequest(event as APIGatewayProxyEventV2)
    : v1EventToRequest(event as APIGatewayProxyEventV1 | ALBEvent);
}

interface ConvertedResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body?: string;
  isBase64Encoded: boolean;
}

async function convertResponse(response: Response): Promise<ConvertedResponse> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() !== "set-cookie") {
      headers[key] = value;
    }
  }

  // Use getSetCookie() for proper multi-cookie extraction (avoids comma-joining)
  const cookies: string[] = response.headers.getSetCookie?.() ?? [];

  const contentType = response.headers.get("content-type") ?? "";
  const isText =
    contentType.includes("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/javascript") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("+json") ||
    contentType.includes("+xml");
  const isBinary = contentType !== "" && !isText;

  let body: string | undefined;
  let isBase64Encoded = false;

  if (response.body) {
    if (isBinary) {
      const buffer = await response.arrayBuffer();
      body = Buffer.from(buffer).toString("base64");
      isBase64Encoded = true;
    } else {
      body = await response.text();
    }
  }

  return { statusCode: response.status, headers, cookies, body, isBase64Encoded };
}

async function responseToV2Result(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const { statusCode, headers, cookies, body, isBase64Encoded } = await convertResponse(response);
  return {
    statusCode,
    headers,
    body,
    isBase64Encoded,
    ...(cookies.length > 0 ? { cookies } : {}),
  };
}

async function responseToV1Result(
  response: Response,
  usesMultiValueHeaders: boolean,
): Promise<APIGatewayProxyResultV1> {
  const { statusCode, headers, cookies, body, isBase64Encoded } = await convertResponse(response);
  const result: APIGatewayProxyResultV1 = { statusCode, headers, body, isBase64Encoded };

  if (cookies.length > 0) {
    if (usesMultiValueHeaders) {
      // ALB with multi-value headers enabled / REST API: set-cookie as multiValueHeaders
      result.multiValueHeaders = { "set-cookie": cookies };
    } else if (cookies.length === 1) {
      result.headers = { ...headers, "set-cookie": cookies[0] as string };
    } else {
      // Single-value header mode cannot carry duplicate keys; include
      // multiValueHeaders (REST APIs honour it) plus the first cookie as fallback.
      result.headers = { ...headers, "set-cookie": cookies[0] as string };
      result.multiValueHeaders = { "set-cookie": cookies };
    }
  }

  return result;
}

/**
 * Create an AWS Lambda handler for API Gateway (HTTP API v2, REST API v1) and ALB.
 * Detects the event shape, converts it to a Web Standard Request,
 * processes via app.handle(), and returns the matching Lambda response format.
 */
export function createLambdaHandler(app: CelsianApp) {
  return async (event: LambdaEvent): Promise<LambdaResult> => {
    try {
      const shape = detectEventShape(event);
      const request = lambdaEventToRequest(event, shape);
      const response = await app.handle(request);
      if (shape === "v2") {
        return await responseToV2Result(response);
      }
      const usesMultiValueHeaders = shape === "alb" ? (event as ALBEvent).multiValueHeaders != null : true;
      return await responseToV1Result(response, usesMultiValueHeaders);
    } catch (error) {
      console.error("[celsian] Unhandled error in Lambda handler:", error);
      return {
        statusCode: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Internal Server Error", statusCode: 500 }),
      };
    }
  };
}
