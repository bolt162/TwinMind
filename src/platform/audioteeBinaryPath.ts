/**
 * audiotreeBinaryPath — resolve the on-disk path to the `audiotee` Swift binary.
 *
 * The audiotee npm module's own path-resolution does `join(__dirname, '..',
 * 'bin', 'audiotee')`, which in a packaged Electron app yields a path inside
 * `app.asar` — fine for fs reads (Electron's asar shim transparently handles
 * those) but `child_process.spawn` can't exec a file inside an asar archive
 * and fails with `ENOTDIR`. asarUnpack copies the binary to
 * `app.asar.unpacked/` at build time; we just have to swap the segment.
 *
 * Used by both the main-process audio-capture probe and the audio-process
 * AudioTeeAdapter so the same fix applies wherever AudioTee is constructed.
 */

import path from 'node:path';

const ASAR_SEGMENT = `${path.sep}app.asar${path.sep}`;
const UNPACKED_SEGMENT = `${path.sep}app.asar.unpacked${path.sep}`;

export function resolveAudioteeBinaryPath(): string | null {
  let entryPath: string;
  try {
    // Resolve the main entry rather than `audiotee/package.json`: audiotee's
    // `exports` field restricts subpaths, and Node's package.json-bypass
    // rule isn't honored consistently inside an asar archive. The main
    // entry IS in exports, so this works in both dev and packaged builds.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    entryPath = require.resolve('audiotee');
  } catch {
    return null;
  }
  // Entry is <pkgRoot>/dist/index.js — binary lives at <pkgRoot>/bin/audiotee.
  const binPath = path.join(path.dirname(entryPath), '..', 'bin', 'audiotee');
  // spawn() can't exec a file inside app.asar; asarUnpack copies it out at
  // build time, so we point at the unpacked twin.
  return binPath.includes(ASAR_SEGMENT)
    ? binPath.replace(ASAR_SEGMENT, UNPACKED_SEGMENT)
    : binPath;
}
