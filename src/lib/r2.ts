// Public URL for an MP3 stored in R2 under media.floorisrising.com.
// Captivate filenames already include things like "%20" half-decoded as "20",
// but they are still safe URL-path characters, so no further encoding needed
// for the typical filenames in our manifest. We do `encodeURI` (not encodeURIComponent)
// so any odd characters get percent-encoded without mangling slashes.

export const R2_PUBLIC_BASE = "https://media.floorisrising.com";

export function r2Url(filename: string): string {
  return `${R2_PUBLIC_BASE}/${encodeURI(filename)}`;
}
