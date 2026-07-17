// Copy the server's committed golden wire vectors into the client tree so the
// TS decoder can be tested against the exact same bytes the Python encoder
// produced. The copies under client/tests/golden/ are committed as a contract
// snapshot: the cross-language byte contract lives in these .bin files, and any
// server-side wire change that regenerates them must be re-synced here on
// purpose (a diff in the snapshot === a diff in the contract).
//
// Source of truth: server/tests/proto/golden/*.bin (see
// flowmap_server.proto.wire.write_golden_vectors / golden_fixture_events).
//
// Run: node scripts/sync-golden.mjs   (from the client/ directory)

import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'server', 'tests', 'proto', 'golden');
const dstDir = join(here, '..', 'tests', 'golden');

const bins = readdirSync(srcDir).filter((f) => f.endsWith('.bin')).sort();
if (bins.length === 0) {
  throw new Error(`no golden .bin files found in ${srcDir}`);
}

// Wipe + recreate so a renamed/removed server golden does not leave a stale
// copy behind that would silently keep passing.
rmSync(dstDir, { recursive: true, force: true });
mkdirSync(dstDir, { recursive: true });

for (const name of bins) {
  cpSync(join(srcDir, name), join(dstDir, name));
}

console.log(`synced ${bins.length} golden vector(s) -> ${dstDir}`);
for (const name of bins) console.log(`  ${name}`);
