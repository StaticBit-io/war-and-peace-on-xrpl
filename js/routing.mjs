/**
 * URL routing for the reader.
 *
 * Chapter 0 is the front matter, which makes the id falsy — every check against
 * a parsed route has to test for null rather than truthiness.
 */

/**
 * Reads a chapter id out of a location hash.
 * @param {string} hash e.g. "#/chapter/42"
 * @returns {number|null} the id, or null when the hash is not a chapter route
 */
export function parseChapterRoute(hash) {
  const match = /^#\/chapter\/(\d+)$/.exec(hash ?? '');
  return match ? Number(match[1]) : null;
}

/** Builds the hash for a chapter id. */
export const chapterRoute = (id) => `#/chapter/${id}`;
