// Simple benchmark app without rate limiting
import { createApp, nodeToWebRequest, writeWebResponse } from '@celsian/core';
import { createServer } from 'node:http';

const app = createApp();

app.get('/api/health', (_req, reply) => {
  return reply.json({ status: 'ok', timestamp: new Date().toISOString() });
});

await app.ready();

const PORT = 3456;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://0.0.0.0:${PORT}`);
  const webRequest = nodeToWebRequest(req, url);
  try {
    const response = await app.handle(webRequest);
    await writeWebResponse(res, response);
  } catch (error) {
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Bench] Server ready on http://0.0.0.0:${PORT}`);
});
