// Vendors only-connect.js into an app as only-connect.<hash>.js and prints the
// import-map entry. The import map is the lock file.
//
//   node scripts/vendor.mjs <destination-directory> [url-prefix]
//
// url-prefix defaults to "./lib/" — the path the app serves the directory at.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [destination, prefix = './lib/'] = process.argv.slice(2);
if (!destination) {
  console.error('usage: node scripts/vendor.mjs <destination-directory> [url-prefix]');
  process.exit(2);
}

const source = path.join(root, 'only-connect.js');
const bytes = readFileSync(source);
const hex = createHash('sha256').update(bytes).digest('hex');
const sri = `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
const file = `only-connect.${hex.slice(0, 12)}.js`;

mkdirSync(destination, { recursive: true });
for (const stale of readdirSync(destination)) {
  if (/^only-connect\.[0-9a-f]{12}\.js$/.test(stale) && stale !== file) rmSync(path.join(destination, stale));
}
copyFileSync(source, path.join(destination, file));

console.log(`${file}  ${sri}`);
console.log(JSON.stringify({ imports: { 'only-connect': `${prefix}${file}` } }, null, 2));
