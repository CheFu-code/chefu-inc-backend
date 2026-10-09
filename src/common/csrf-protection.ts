export function isAllowedCookieMutationOrigin(
  origin: string | undefined,
  referer: string | undefined,
  allowedOrigins: string[],
) {
  if (origin) {
    return matchesAllowedOrigin(origin, allowedOrigins);
  }

  if (!referer) return false;

  try {
    return matchesAllowedOrigin(new URL(referer).origin, allowedOrigins);
  } catch {
    return false;
  }
}

function matchesAllowedOrigin(value: string, allowedOrigins: string[]) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.origin === 'null') {
      return false;
    }
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}
