// @celsian/adapter-lambda — AWS Lambda (API Gateway v2) adapter

import type { CelsianApp } from "@celsian/core";

export interface APIGatewayProxyEventV2 {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
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

export interface APIGatewayProxyStructuredResultV2 {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

function lambdaEventToRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value) headers.set(key, value);
  }

  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  const queryString = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${proto}://${host}${event.rawPath}${queryString}`;
  const method = event.requestContext.http.method;

  let body: string | undefined;
  if (event.body) {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
  }

  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });
}

async function responseToLambdaResult(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() !== "set-cookie") {
      headers[key] = value;
    }
  }

  // Use getSetCookie() for proper multi-cookie extraction (avoids comma-joining)
  const cookies: string[] = response.headers.getSetCookie?.() ?? [];

  const contentType = response.headers.get("content-type") ?? "";
  const isBinary =
    !contentType.includes("text/") &&
    !contentType.includes("application/json") &&
    !contentType.includes("application/xml");

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

  return {
    statusCode: response.status,
    headers,
    body,
    isBase64Encoded,
    ...(cookies.length > 0 ? { cookies } : {}),
  };
}

/**
 * Create an AWS Lambda handler for API Gateway v2.
 * Converts API Gateway events to Web Standard Request,
 * processes via app.handle(), and returns Lambda-compatible result.
 */
export function createLambdaHandler(app: CelsianApp) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      const request = lambdaEventToRequest(event);
      const response = await app.handle(request);
      return responseToLambdaResult(response);
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
