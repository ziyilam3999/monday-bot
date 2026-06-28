/**
 * Shared schema for the Confluence feature/flow catalog (#1314 S2).
 *
 * The catalog is a tidy two-list "menu" distilled from the internal wiki: a list
 * of product FEATURES and a list of user-FLOWS. It is written to a GITIGNORED
 * file because the labels carry internal product names; nothing here is ever
 * printed to stdout or committed.
 *
 * These interfaces are dependency-free (no fs, no network, no creds) so the
 * distill core and CLI core can be unit-tested with stubs.
 */

/** Structural subset of `ConfluencePage` the distiller needs. */
export interface CatalogPage {
  id: string;
  title: string;
  body: string;
}

/** One catalog entry (a feature or a flow). */
export interface CatalogEntry {
  /** STABLE, deterministic id derived from the label (see distill.ts). */
  id: string;
  /** Human-readable name — INTERNAL; lives only in the gitignored output file. */
  label: string;
  /** Corpus page ids this entry was distilled from (always a subset of the corpus). */
  provenancePageIds: string[];
}

/** The full catalog document — the stable contract S3 will consume. */
export interface FeatureCatalog {
  /** ISO timestamp; an injected `now()` keeps tests deterministic. */
  generatedAt: string;
  /** Always `false` on generation — the operator flips it after hand-editing. */
  reviewed: boolean;
  features: CatalogEntry[];
  flows: CatalogEntry[];
}

/** A raw entry as returned by the distiller, BEFORE validation/id-assignment. */
export interface RawCatalogEntry {
  label: string;
  provenancePageIds: string[];
}

/**
 * The SINGLE LLM boundary of the catalog tooling. The production implementation
 * wraps `getClient().messages.create(...)` and parses the JSON reply; tests
 * inject a fake that returns canned raw entries, so the unit suite makes ZERO
 * network and ZERO real model calls.
 */
export interface CatalogDistiller {
  distill(pages: CatalogPage[]): Promise<{
    features: RawCatalogEntry[];
    flows: RawCatalogEntry[];
  }>;
}
