#!/usr/bin/env node
// The macOS update feed for one release: latest-mac.yml (beta-mac.yml for a
// prerelease), naming both architectures' zips, in electron-updater's format.
// Each Mac build job only knows its own zip, so the release job writes the
// combined feed instead:
//   node scripts/mac-update-feed.mjs <release dir> <version>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const feedName = (version) => `${version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest'}-mac.yml`;

export function macFeed(version, files, releaseDate) {
  const zips = files.filter((file) => file.name.endsWith('.zip')).sort((a, b) => a.name.localeCompare(b.name));
  if (zips.length === 0) return null;
  const main = zips.find((file) => !file.name.includes('-arm64')) ?? zips[0];
  return [
    `version: ${version}`,
    'files:',
    ...zips.flatMap((file) => [`  - url: ${file.name}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`]),
    `path: ${main.name}`,
    `sha512: ${main.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

export function describeFile(dir, name) {
  const file = path.join(dir, name);
  return { name, size: statSync(file).size, sha512: createHash('sha512').update(readFileSync(file)).digest('base64') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, version] = process.argv.slice(2);
  const prefix = `Dolphin-${version}-mac-`;
  const files = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.zip')).map((name) => describeFile(dir, name));
  const feed = macFeed(version, files, new Date().toISOString());
  if (!feed) {
    console.log('mac-update-feed: no Mac zips for this version, so no feed');
  } else {
    writeFileSync(path.join(dir, feedName(version)), feed);
    console.log(`mac-update-feed: wrote ${feedName(version)} for ${files.map((file) => file.name).join(', ')}`);
  }
}
