// @celsian/core — Content negotiation utilities

interface AcceptEntry {
  type: string;
  quality: number;
}

function parseAccept(header: string): AcceptEntry[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [type, ...params] = part.trim().split(';');
      let quality = 1;
      for (const param of params) {
        const [key, value] = param.trim().split('=');
        if (key === 'q') quality = parseFloat(value) || 0;
      }
      return { type: type.trim().toLowerCase(), quality };
    })
    .filter((e) => e.quality > 0)
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Select the best match from available types based on the Accept header.
 * Returns the matched type, or null if none match.
 * Matching is case-insensitive per RFC 7231.
 *
 * @example
 * const type = accepts(request, ['application/json', 'text/html']);
 * if (type === 'application/json') return reply.json(data);
 * if (type === 'text/html') return reply.html(renderHtml(data));
 * return reply.notFound('Not Acceptable');
 */
export function accepts(request: Request, available: string[]): string | null {
  const header = request.headers.get('accept') ?? '*/*';
  const entries = parseAccept(header);

  for (const entry of entries) {
    if (entry.type === '*/*') return available[0] ?? null;
    const [mainType, subType] = entry.type.split('/');
    for (const avail of available) {
      const [aMain, aSub] = avail.toLowerCase().split('/');
      if (
        (mainType === aMain || mainType === '*') &&
        (subType === aSub || subType === '*')
      ) {
        return avail;
      }
    }
  }
  return null;
}

/**
 * Select the best encoding from available encodings based on Accept-Encoding.
 * Matching is case-insensitive per RFC 7231.
 */
export function acceptsEncoding(request: Request, available: string[]): string | null {
  const header = request.headers.get('accept-encoding') ?? '';
  if (!header) return available[0] ?? null;
  const entries = parseAccept(header);
  const availLower = available.map((a) => a.toLowerCase());

  for (const entry of entries) {
    if (entry.type === '*') return available[0] ?? null;
    const idx = availLower.indexOf(entry.type);
    if (idx !== -1) return available[idx];
  }
  return null;
}

/**
 * Select the best language from available languages based on Accept-Language.
 * Matching is case-insensitive per RFC 4647.
 */
export function acceptsLanguage(request: Request, available: string[]): string | null {
  const header = request.headers.get('accept-language') ?? '';
  if (!header) return available[0] ?? null;
  const entries = parseAccept(header);
  const availLower = available.map((a) => a.toLowerCase());

  for (const entry of entries) {
    if (entry.type === '*') return available[0] ?? null;
    // Exact match (case-insensitive)
    const exactIdx = availLower.indexOf(entry.type);
    if (exactIdx !== -1) return available[exactIdx];
    // Prefix match with hyphen boundary (e.g., 'en' matches 'en-US' but not 'endeavour')
    const prefix = entry.type.split('-')[0];
    const prefixIdx = availLower.findIndex((a) => a === prefix || a.startsWith(prefix + '-'));
    if (prefixIdx !== -1) return available[prefixIdx];
  }
  return null;
}
