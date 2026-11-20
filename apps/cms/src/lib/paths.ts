/**
 * Where to go after signing in. Only a path on this site is accepted, so a crafted
 * `/sign-in?redirect=` link cannot send someone elsewhere. A tab, CR or LF is refused as the router
 * refuses it: URL parsing drops them, so `/\t/x` reads as `//x`, another host.
 */
export function safeRedirect(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\t\n\r]/.test(value)) return fallback;
  if (isSignIn(new URL(value, 'https://cms.invalid').pathname) || value.startsWith('/api/')) return fallback;
  return value;
}

/**
 * Whether a URL's pathname is sign-in's as the router matches it (any case, letters percent-encoded
 * or not) or redirects to it (stray slashes). A path that does not decode is the router's 404.
 */
function isSignIn(pathname: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  return path.toLowerCase().replace(/\/+/g, '/').replace(/\/$/, '') === '/sign-in';
}

/**
 * Where sign-in should come back to when a tool call finds the session ended: the page itself on a
 * page load (`url`); on a server function's call, the page that made it (`referer`). A call made
 * from sign-in itself, a read of the page before that ends once the address is sign-in's, keeps
 * sign-in's own way back, so a late redirect never nests the first one.
 */
export function signInBack(url: string, referer: string | null): string {
  const page = new URL(new URL(url).pathname.startsWith('/_serverFn/') ? (referer ?? '/') : url, url);
  if (isSignIn(page.pathname)) return safeRedirect(page.searchParams.get('redirect'));
  return page.pathname + page.search;
}

/** A URL slug from an organization name: lowercase ASCII words joined by hyphens. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'org';
}

/** Initials for an avatar: up to two letters from a name or an email address. */
export function initials(text: string): string {
  const words = text
    .split('@')[0]!
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
