import type { RedisOptions } from 'ioredis';

function integerOption(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error('Invalid Redis numeric option');
  }
  return number;
}

/**
 * Passing a URL string to ioredis invokes its deprecated Node url.parse() path.
 * Use WHATWG URL instead and pass only an options object to the constructor.
 */
export function parseRedisUrl(value: string): RedisOptions {
  try {
    const url = new URL(value.trim());
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
      throw new Error('Unsupported Redis URL');
    }

    // Preserve URL query options, with authority/path taking precedence as in ioredis.
    const query = Object.fromEntries(url.searchParams);
    const options: RedisOptions = {
      ...query,
      // WHATWG URL includes IPv6 brackets; Node's socket host must not include them.
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: integerOption(url.port || query.port || '6379', 1, 65_535),
      db: integerOption(url.pathname.slice(1) || query.db || '0', 0),
    };

    if (url.username || url.password) {
      options.username = decodeURIComponent(url.username);
      options.password = decodeURIComponent(url.password);
    }
    if (query.family !== undefined) {
      const family = integerOption(query.family, 0, 6);
      if (![0, 4, 6].includes(family)) throw new Error('Invalid Redis address family');
      options.family = family;
    }
    if (url.protocol === 'rediss:') options.tls = {};

    return options;
  } catch {
    // URL parsing errors can include the input, which may contain credentials.
    throw new Error('Invalid Redis URL configuration');
  }
}