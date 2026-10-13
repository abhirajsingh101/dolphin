#!/usr/bin/env node
// The installers one Desktop build target must produce, named as the README
// links them and as src/releases.ts reads them. CI runs it after packaging:
//   node scripts/check-artifacts.mjs <release dir> <target>
// Names follow electron-builder 26's arch words (builder-util getArtifactArchName).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER = /\.(AppImage|deb|rpm|dmg|zip)$/;
const channelOf = (version) => (version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest');

export function expectedInstallers(version, target) {
  const name = (suffix) => `Dolphin-${version}-${suffix}`;
  switch (target) {
    case 'linux-x64': return [name('linux-x86_64.AppImage'), name('linux-amd64.deb'), name('linux-x86_64.rpm')];
    case 'linux-arm64': return [name('linux-arm64.AppImage'), name('linux-arm64.deb'), name('linux-aarch64.rpm')];
    case 'darwin-arm64': return [name('mac-arm64.dmg'), name('mac-arm64.zip')];
    case 'darwin-x64': return [name('mac-x64.dmg'), name('mac-x64.zip')];
    default: return null;
  }
}

/** The AppImage's own update file. The Mac feed names both architectures, so
 *  the release job writes it once (mac-update-feed.mjs); none is expected here. */
export function expectedUpdateFiles(version, target) {
  const channel = channelOf(version);
  if (target === 'linux-x64') return [`${channel}-linux.yml`];
  if (target === 'linux-arm64') return [`${channel}-linux-arm64.yml`];
  return [];
}

export function checkArtifacts(names, version, target) {
  const installers = expectedInstallers(version, target);
  if (!installers) return [`unknown target ${target}`];
  const wanted = [...installers, ...expectedUpdateFiles(version, target)];
  return [
    ...wanted.filter((name) => !names.includes(name)).map((name) => `missing ${name}`),
    ...names.filter((name) => INSTALLER.test(name) && !installers.includes(name)).map((name) => `unexpected installer ${name}`),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, target] = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const version = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  const problems = checkArtifacts(readdirSync(dir), version, target);
  if (problems.length) {
    console.error(`check-artifacts (${target}, ${version}):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`check-artifacts: ${target} ${version} OK`);
}
