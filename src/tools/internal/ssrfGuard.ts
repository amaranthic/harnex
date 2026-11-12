/**
 * @fileoverview SSRF (Server-Side Request Forgery) protection and URL validation utilities.
 * Ensures the WebFetch tool only reaches public, safe internet endpoints and rejects
 * private, loopback, cloud metadata, and link-local addresses using `ipaddr.js`.
 * @packageDocumentation
 */

import ipaddr from "ipaddr.js";

/**
 * Maximum permitted URL character length to prevent buffer and memory abuse.
 */
export const maxUrlLength = 2048;

/**
 * Common private or local domain suffixes rejected for security.
 */
const blockedHostSuffixes = [
  ".local",
  ".internal",
  ".localhost",
  ".lan",
  ".home",
  ".arpa",
];

/**
 * Explicit blocked hostnames.
 */
const blockedHostnames = new Set([
  "localhost",
  "loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/**
 * Checks whether an IP address string falls into private, loopback, link-local, or non-unicast ranges.
 *
 * @param ipString - IP address string (IPv4 or IPv6, possibly bracketed).
 * @returns True if private, loopback, or non-unicast; false otherwise.
 */
function isNonPublicIp(ipString: string): boolean {
  const normalized = ipString.trim().replace(/^\[|\]$/g, "");
  if (!ipaddr.isValid(normalized)) {
    return false;
  }
  try {
    const addr = ipaddr.process(normalized);
    return addr.range() !== "unicast";
  } catch {
    return true;
  }
}

/**
 * Evaluates whether a given hostname is a private, loopback, or internal address.
 *
 * @param hostname - The target hostname or IP string.
 * @returns True if the host is private, loopback, or internal.
 */
export function isPrivateOrBlockedHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (blockedHostnames.has(normalized)) {
    return true;
  }

  for (const suffix of blockedHostSuffixes) {
    if (normalized.endsWith(suffix)) {
      return true;
    }
  }

  // Single-label hostnames without any domain dot (e.g. 'localhost', 'router', 'corp-nas')
  if (!normalized.includes(".")) {
    return true;
  }

  // Check if it is any IP address (IPv4, IPv6, IPv4-mapped)
  if (ipaddr.isValid(normalized)) {
    return isNonPublicIp(normalized);
  }

  return false;
}

/**
 * Validates and normalizes an input URL for web fetching.
 *
 * @param rawUrl - The raw URL string provided by the caller or model.
 * @returns A parsed and validated URL object.
 * @throws Error if the URL is invalid, too long, uses credentials, or targets private IPs.
 */
export function validateWebUrl(rawUrl: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("URL must be a non-empty string.");
  }

  if (rawUrl.length > maxUrlLength) {
    throw new Error(
      `URL length (${rawUrl.length}) exceeds maximum permitted length of ${maxUrlLength} characters.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: Unable to parse '${rawUrl}'.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported protocol '${parsed.protocol}'. Only 'http:' and 'https:' are permitted.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      "URLs containing basic authentication credentials (username/password) are rejected for security.",
    );
  }

  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new Error(
      `Access to private or local host '${parsed.hostname}' is blocked for security (SSRF prevention).`,
    );
  }

  return parsed;
}

/**
 * Normalizes hostnames by stripping a leading 'www.' prefix for equivalence checks.
 *
 * @param hostname - The hostname to normalize.
 * @returns The hostname without a leading 'www.'.
 */
function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Evaluates whether a redirect from originalUrl to redirectUrl is permitted to be
 * followed automatically without returning a cross-host halt.
 *
 * Same-host redirects (and www <-> non-www variations) on the same protocol and port
 * are permitted. Cross-host redirects are rejected to preserve agent oversight.
 *
 * @param originalUrl - The starting URL string.
 * @param redirectUrl - The target location URL string.
 * @returns True if the redirect stays within the permitted same-domain scope.
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const original = new URL(originalUrl);
    const redirect = new URL(redirectUrl, originalUrl);

    if (redirect.protocol !== original.protocol) {
      return false;
    }

    if (redirect.port !== original.port) {
      return false;
    }

    if (redirect.username || redirect.password) {
      return false;
    }

    if (isPrivateOrBlockedHost(redirect.hostname)) {
      return false;
    }

    return stripWww(original.hostname) === stripWww(redirect.hostname);
  } catch {
    return false;
  }
}
