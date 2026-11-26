/**
 * Is the chat model running on this machine or on a private network?
 *
 * The answer changes what the interface may promise: with a local model, a
 * scanned page that is "sent to the model" never leaves the building. Only the
 * OpenAI-compatible provider can be local, because it is the only one whose
 * address is configurable; the hosted providers are always remote.
 */

/** True for localhost, loopback and the private address ranges (RFC 1918, IPv6 unique local). */
export function isLocalAddress(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL keeps the brackets around an IPv6 literal.
  host = host.replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  // fc00::/7: unique local addresses, the IPv6 counterpart of 10.0.0.0/8.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  if (octets.slice(1).some((part) => Number(part) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isLocalModel(provider: string | null, baseUrl: string | null): boolean {
  return provider === "openai-compatible" && baseUrl !== null && isLocalAddress(baseUrl);
}
