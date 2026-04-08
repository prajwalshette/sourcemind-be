import dns from 'dns/promises';
import net from 'net';

const BLOCKED_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,  // link-local (AWS metadata)
  /^fc00:/,       // IPv6 unique local
  /^fe80:/,       // IPv6 link-local
  /^::1$/,        // IPv6 loopback
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',  // AWS/GCP metadata
]);

export async function validateUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Protocol not allowed: ${parsed.protocol}. Use HTTP or HTTPS.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Hostname blocked: ${hostname}`);
  }

  // DNS resolution check for SSRF
  if (!net.isIP(hostname)) {
    try {
      const addresses = await dns.resolve4(hostname);
      for (const ip of addresses) {
        if (isPrivateIp(ip)) {
          throw new Error(`URL resolves to private IP: ${ip}`);
        }
      }
    } catch (err) {
      if ((err as Error).message.includes('private IP')) throw err;
      // DNS resolution failed → still try (might just be slow)
    }
  } else {
    if (isPrivateIp(hostname)) {
      throw new Error(`Private IP not allowed: ${hostname}`);
    }
  }
}

function isPrivateIp(ip: string): boolean {
  return BLOCKED_IP_RANGES.some(range => range.test(ip));
}

// Strip potential prompt injection from crawled content
export function sanitizeContent(text: string): string {
  return text
    // Remove null bytes
    .replace(/\0/g, '')
    // Remove common injection patterns
    .replace(/ignore\s+(all\s+)?previous\s+instructions?/gi, '[REMOVED]')
    .replace(/you\s+are\s+now\s+/gi, '[REMOVED] ')
    .replace(/system\s*:\s*/gi, '[REMOVED]: ')
    .replace(/assistant\s*:\s*/gi, '[REMOVED]: ')
    // Limit repeated characters (padding attacks)
    .replace(/(.)\1{50,}/g, '$1$1...')
    // Truncate excessively long lines
    .split('\n')
    .map(line => (line.length > 2000 ? line.slice(0, 2000) + '...' : line))
    .join('\n')
    .trim();
}

export function createCacheKey(...parts: (string | undefined)[]): string {
  const str = parts.filter(Boolean).join(':');
  // Simple hash using built-in crypto
  const { createHash } = require('crypto');
  return createHash('sha256').update(str).digest('hex').slice(0, 32);
}

export function hashText(text: string): string {
  const { createHash } = require('crypto');
  return createHash('sha256').update(text).digest('hex');
}
