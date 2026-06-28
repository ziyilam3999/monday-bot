/**
 * Single canonical slug source (#1322).
 *
 * Promoted out of `distill.ts` so the catalog id-assignment AND the
 * `mb-`-namespaced Jira label writer share ONE lowercase-kebab function. If these
 * ever drifted, a label string would stop matching its catalog id and the bot's
 * "controlled vocabulary" guarantee would silently break — so there is exactly
 * ONE slug function and both sites import it.
 *
 * Behaviour: lowercase, collapse every run of non-alphanumeric chars to a single
 * hyphen, and trim leading/trailing hyphens.
 */
export function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
