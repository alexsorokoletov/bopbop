// Build the Chrome extension: compile extension/src/*.ts with tsrs (extension/tsconfig.json) and copy the static files.
// Output: dist/extension (or --out <dir>). Load it unpacked in Chrome, or zip it for the Chrome Web Store (--zip).
import { cpSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'extension');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const out = resolve(arg('--out') ?? join(root, 'dist', 'extension'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['manifest.json', 'options.html', 'icons']) cpSync(join(src, f), join(out, f), { recursive: true });
// tsrs (the Rust port of the TypeScript 7 compiler) in its WebAssembly build: the native launcher picks its binary by
// process.arch, and there is no darwin-x64 binary for a Node under Rosetta. The wasm build runs on any arch.
// Its JS entry through our runtime: Windows cannot execute the node_modules/.bin shim directly.
execFileSync(process.execPath, [join(root, 'node_modules', '@tsrs', 'wasm', 'bin', 'tsrs-wasm.js'), '-p', src, '--noEmit', 'false', '--outDir', out], {
  stdio: 'inherit',
});
// Keep the release version stable, but identify every build in Chrome's displayed version.
// Hash the emitted files (including local edits), not just the last Git commit.
const hash = createHash('sha256');
for (const file of readdirSync(out, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).slice(out.length + 1))
  .sort()) {
  hash
    .update(file)
    .update('\0')
    .update(readFileSync(join(out, file)))
    .update('\0');
}
const builtAt = new Date().toISOString();
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
// Store uploads need a higher version each time: --version 0.1.42 (the publish workflow passes one).
manifest.version = arg('--version') ?? manifest.version;
manifest.version_name = `${manifest.version} (${builtAt}; ${hash.digest('hex').slice(0, 12)})`;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${manifest.version_name}\n${out}`);
if (process.argv.includes('--zip')) {
  const zip = join(root, 'dist', `bopbop-extension-${manifest.version}-${builtAt.replace(/[-:.]/g, '')}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: out });
  console.log(zip);
}
