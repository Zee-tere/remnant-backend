export function parseOriginList(...values: Array<string | undefined>) {
  return values
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(
  origin: string | undefined,
  configuredOrigins: string[],
  options: { allowPrivateLan?: boolean } = {},
) {
  if (!origin) return true;
  if (configuredOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();

    if (
      hostname === 'remnant.africa' ||
      hostname.endsWith('.remnant.africa') ||
      hostname === 'remnantmarket.co' ||
      hostname.endsWith('.remnantmarket.co')
    ) {
      return true;
    }

    if (options.allowPrivateLan) {
      return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
      );
    }
  } catch {
    return false;
  }

  return false;
}
