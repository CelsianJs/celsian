// @celsian/rate-limit, Dependency-free IP / CIDR parsing for the proxy trust boundary

/**
 * A parsed IP address as a fixed-width big-endian bit string is overkill; we
 * keep IPv4 as a 32-bit number and IPv6 as eight 16-bit groups so prefix
 * comparison is a couple of shifts either way. No third-party dependency: this
 * package deliberately ships with zero runtime deps.
 */
export type ParsedIp = { version: 4; value: number } | { version: 6; groups: number[] };

/** Strip the decorations that show up around addresses in real headers. */
function normalize(raw: string): string {
  let value = raw.trim();
  // `[2001:db8::1]:443`, bracketed IPv6 with a port.
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1]!;
  // `1.2.3.4:443`, IPv4 with a port. A bare IPv6 has more than one colon.
  if (value.includes(".") && value.split(":").length === 2) {
    value = value.split(":")[0]!;
  }
  // `::ffff:1.2.3.4`, IPv4-mapped IPv6 is the same host as the IPv4 address.
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(value);
  if (mapped) return mapped[1]!;
  return value;
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

function parseIpv6(value: string): number[] | null {
  if (!value.includes(":")) return null;

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const part of segment.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]!);
  if (head === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = toGroups(halves[1]!);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/** Parse an IPv4 or IPv6 address. Returns null for anything unrecognized. */
export function parseIp(raw: string): ParsedIp | null {
  const value = normalize(raw);
  const v4 = parseIpv4(value);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIpv6(value);
  if (v6 !== null) return { version: 6, groups: v6 };
  return null;
}

/**
 * The canonical text form of a parsed address, used as the rate-limit bucket
 * key. It is derived from the PARSED value, never from the raw header text, so
 * every spelling of one host collapses to exactly one bucket:
 * `1.2.3.4`, `01.02.03.04`, `::ffff:1.2.3.4`, `[1.2.3.4]` and `1.2.3.4:5000`
 * all format as `1.2.3.4`. Keying on the raw text instead gave each spelling
 * its OWN bucket, and since the `:<port>` suffix is unbounded that was an
 * unbounded quota bypass.
 *
 * IPv6 is emitted fully expanded and lowercased rather than `::`-compressed:
 * one address has many valid compressed spellings but only one expanded one,
 * and this string is compared for equality, never displayed.
 */
export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) {
    const v = ip.value;
    return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
  }
  return ip.groups.map((group) => group.toString(16).padStart(4, "0")).join(":");
}

/**
 * Parse `raw` and return its canonical form, or `null` when it is not an
 * address at all. Callers keying on a client-supplied header MUST fail closed
 * on `null` rather than fall back to the raw text: unparseable text is
 * attacker-chosen and rotating it mints an unlimited number of buckets.
 */
export function canonicalizeIp(raw: string): string | null {
  const ip = parseIp(raw);
  return ip === null ? null : formatIp(ip);
}

/** A CIDR block, or a single address (treated as a full-length prefix). */
export interface Cidr {
  ip: ParsedIp;
  prefix: number;
}

/** Parse `10.0.0.0/8`, `2001:db8::/32`, or a bare address. Returns null if invalid. */
export function parseCidr(raw: string): Cidr | null {
  const [address, prefixPart] = raw.trim().split("/");
  if (!address) return null;
  const ip = parseIp(address);
  if (!ip) return null;

  const maxPrefix = ip.version === 4 ? 32 : 128;
  if (prefixPart === undefined) return { ip, prefix: maxPrefix };
  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix > maxPrefix) return null;
  return { ip, prefix };
}

function ipv4InCidr(value: number, network: number, prefix: number): boolean {
  if (prefix === 0) return true;
  // `>>> 0` keeps the mask unsigned; a 32-bit shift is undefined in JS.
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function ipv6InCidr(groups: number[], network: number[], prefix: number): boolean {
  let remaining = prefix;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const bits = Math.min(16, remaining);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i]! & mask) !== (network[i]! & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/** Does `ip` fall inside `cidr`? Mixed IP versions never match. */
export function ipInCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.version !== cidr.ip.version) return false;
  if (ip.version === 4) return ipv4InCidr(ip.value, (cidr.ip as { value: number }).value, cidr.prefix);
  return ipv6InCidr(ip.groups, (cidr.ip as { groups: number[] }).groups, cidr.prefix);
}

/** Is `raw` (an untrusted header value) one of our own proxies? */
export function isTrustedProxy(raw: string, trusted: Cidr[]): boolean {
  const ip = parseIp(raw);
  if (!ip) return false;
  return trusted.some((cidr) => ipInCidr(ip, cidr));
}
