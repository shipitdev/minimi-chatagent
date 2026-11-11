/** Canonical URL form used by the golden runner's source checks. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}
