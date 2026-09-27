/**
 * Repair/backfill tool: regenerate the gallery's KV index from scratch by scanning every
 * `runs/<id>/meta.json` already in the R2 bucket (the ground truth), rather than trusting whatever
 * is currently in KV. Use this to:
 *   - backfill runs recorded before the KV index existed (e.g. anything uploaded while the index
 *     still lived in R2 as index.json),
 *   - recover from a lost/corrupted KV value,
 *   - repair a dropped entry from a rare concurrent-write race in addRunToGalleryIndex().
 *
 * Not part of the normal per-run path -- tools/agent-run.ts calls the O(1) addRunToGalleryIndex()
 * itself after every run. This is an explicit, O(n) (one list + one get per run) maintenance
 * operation you run by hand.
 *
 * Usage: npx tsx tools/rebuild-gallery-index.ts
 */
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const { rebuildGalleryIndex } = await import("../src/lib/gallery.js");

const entries = await rebuildGalleryIndex();
console.log(`Rebuilt gallery index: ${entries.length} run(s).`);
for (const e of entries) {
  console.log(`  ${e.date}  ${e.runId}  "${e.description}"`);
}
