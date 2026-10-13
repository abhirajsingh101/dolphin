#!/usr/bin/env node
// The Homebrew cask for one stable release, from the template in
// packaging/homebrew/ and the release's two dmgs:
//   node scripts/render-cask.mjs <release dir> <version> > dolphin-desktop.rb
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(here, '..', 'packaging', 'homebrew', 'dolphin-desktop.rb.in');

export function renderCask(template, { version, arm64, x64 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`render-cask: ${version} is not a stable version; casks follow stable releases only`);
  for (const [arch, sum] of Object.entries({ arm64, x64 })) {
    if (!/^[0-9a-f]{64}$/.test(sum ?? '')) throw new Error(`render-cask: no sha256 for the ${arch} dmg`);
  }
  const cask = template.replaceAll('@VERSION@', version).replaceAll('@SHA256_ARM64@', arm64).replaceAll('@SHA256_X64@', x64);
  if (/@[A-Z0-9_]+@/.test(cask)) throw new Error('render-cask: the template has a placeholder this script does not fill');
  return cask;
}

export function caskFromRelease(dir, version) {
  const sha256 = (arch) => {
    const name = `Dolphin-${version}-mac-${arch}.dmg`;
    try {
      return createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex');
    } catch {
      throw new Error(`render-cask: ${name} is not in ${dir}`);
    }
  };
  return renderCask(readFileSync(TEMPLATE, 'utf8'), { version, arm64: sha256('arm64'), x64: sha256('x64') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, version] = process.argv.slice(2);
  try {
    process.stdout.write(caskFromRelease(dir, version));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
