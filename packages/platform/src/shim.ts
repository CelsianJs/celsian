/**
 * Shared req/reply shim — single source of truth.
 *
 * This shim is injected into bundled worker scripts (CF Workers, Lambda handlers)
 * to provide a CelsianJS-compatible request/reply interface on top of Web Standard
 * Request/Response objects.
 */
export const REQ_REPLY_SHIM = `
function createReq(request, url, params) {
  return {
    method: request.method,
    url: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
    params,
    query: Object.fromEntries(url.searchParams.entries()),
    parsedBody: null,
    _request: request,
  };
}

function createReply() {
  let statusCode = 200;
  const headers = { 'content-type': 'application/json' };

  const reply = {
    status(code) { statusCode = code; return reply; },
    header(name, value) { headers[name] = value; return reply; },
    json(data) {
      return new Response(JSON.stringify(data), {
        status: statusCode,
        headers,
      });
    },
    send(body) {
      if (typeof body === 'string') {
        headers['content-type'] = headers['content-type'] || 'text/plain';
      }
      return new Response(body, { status: statusCode, headers });
    },
  };
  return reply;
}

async function parseBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE') {
    return null;
  }
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { return await request.json(); } catch { return null; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  try { return await request.text(); } catch { return null; }
}
`;
