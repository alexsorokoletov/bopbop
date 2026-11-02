import { readFileSync } from 'node:fs';

// package.json is one folder up from src/ (a checkout) and two up from dist/npm/ (the npm package).
export function packageVersion(): string {
  for (const path of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
      if (pkg.name === 'bopbop') return pkg.version;
    } catch {}
  }
  return '0.0.0';
}
