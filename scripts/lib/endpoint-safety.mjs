/**
 * Keeping a credential-bearing RPC endpoint out of every log and record.
 *
 * Until now the custody workflow used `https://api.devnet.solana.com`, a public
 * URL with nothing in it worth hiding, and the harness printed it freely — in
 * the mainnet refusal, in the genesis mismatch, and as `rpcEndpoint` in the
 * evidence record itself.
 *
 * A dedicated endpoint is not like that. It typically looks like
 * `https://devnet.example-rpc.com/?api-key=…` or carries the key as a path
 * segment, so every one of those sites becomes a way to publish a credential
 * into a permanent Actions log or a committed JSON file.
 *
 * Two defences, because the messages come from two different places:
 *
 *   * the ones this repository writes are rewritten to name no endpoint at all
 *     — `SAFE_ENDPOINT_LABEL` says "the configured RPC endpoint" and stops;
 *   * the ones it does not write — `@solana/web3.js` wrapping a fetch failure,
 *     undici reporting a DNS error, a provider's own error text — are scrubbed
 *     on the way out by `redact`, against endpoints registered at startup.
 *
 * The second is the one that matters. A rule that only covers the strings we
 * remembered to write is a rule that a dependency's error message walks around.
 */

/** What a message may say about the endpoint, and the most it may say. */
export const SAFE_ENDPOINT_LABEL = "the configured RPC endpoint";

/** What a redacted fragment is replaced with, so a reader sees that it happened. */
export const REDACTION = "<redacted rpc endpoint>";

/**
 * Registered endpoint fragments, longest first.
 *
 * Module-level because the code that formats an error — `describeError`, a
 * top-level handler — is nowhere near the code that knows the endpoint, and
 * threading it through every call site is exactly the kind of discipline that
 * fails quietly the first time someone adds a new one.
 */
const sensitive = new Set();

/**
 * Every substring of an endpoint that would identify or authenticate it.
 *
 * More than the URL itself, because an error rarely quotes the URL whole: a
 * DNS failure names the host, a provider names its path, a redirect names the
 * origin. Short, generic pieces are deliberately not included — redacting
 * `https` or `com` would turn every message into noise.
 */
export function endpointFragments(endpoint) {
  const raw = String(endpoint ?? "").trim();
  if (raw === "") return [];
  const fragments = new Set([raw]);

  let url;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL. The raw string is still registered above: if it reaches a log
    // it is just as revealing for not having parsed.
    return [...fragments];
  }

  fragments.add(url.href);
  fragments.add(url.origin);
  fragments.add(url.host);
  fragments.add(url.hostname);
  if (url.username) fragments.add(url.username);
  if (url.password) fragments.add(url.password);
  if (url.search) fragments.add(url.search.replace(/^\?/, ""));
  for (const value of url.searchParams.values()) {
    if (value.length >= 8) fragments.add(value);
  }
  for (const segment of url.pathname.split("/")) {
    if (segment.length >= 8) fragments.add(segment);
  }

  // Longest first, so redacting the host does not leave a truncated href behind.
  return [...fragments].filter((fragment) => fragment.length >= 4).sort((a, b) => b.length - a.length);
}

/**
 * Marks an endpoint as unprintable for the rest of the process.
 *
 * Called once, as early as the endpoint is known — before a client is built,
 * before a keypair is read, and before anything can throw.
 */
export function registerSensitiveEndpoint(endpoint) {
  for (const fragment of endpointFragments(endpoint)) sensitive.add(fragment);
}

/** Only for tests: forget everything registered. */
export function resetSensitiveEndpoints() {
  sensitive.clear();
}

/** Registered fragments, longest first. */
export function sensitiveFragments() {
  return [...sensitive].sort((a, b) => b.length - a.length);
}

/**
 * Removes every registered endpoint fragment from `text`.
 *
 * Applied at output boundaries rather than at throw sites, so it covers
 * messages this repository never wrote. It is a last line, not the only one:
 * the messages we do write name no endpoint in the first place.
 */
export function redact(text) {
  let out = String(text ?? "");
  for (const fragment of sensitiveFragments()) {
    if (fragment && out.includes(fragment)) out = out.split(fragment).join(REDACTION);
  }
  return out;
}

/**
 * Whether a string carries something that must never reach an evidence record.
 *
 * Aimed at an endpoint, not at addresses: a base58 pubkey is not a URL and does
 * not trip this. Any URL with a query string, with userinfo, or with a long
 * opaque path segment is treated as credential-bearing, because from the
 * outside those are indistinguishable from one that is.
 */
export function looksLikeCredentialUrl(value) {
  if (typeof value !== "string") return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return true;
  if (url.search) return true;
  return url.pathname.split("/").some((segment) => segment.length >= 16);
}
