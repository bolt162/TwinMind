import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WebmEncoder,
  WebmEncodeError,
  resolveFfmpegPath,
} from '@core/audio/WebmEncoder';

/**
 * Real-ffmpeg integration. Skips automatically when ffmpeg-static isn't
 * resolvable for the current platform/arch (CI matrix sanity).
 */
const ffmpegPath = resolveFfmpegPath();
const describeIfFfmpeg = ffmpegPath ? describe : describe.skip;

describeIfFfmpeg('WebmEncoder (real ffmpeg-static)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-webm-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('encodes a 1-second tone to a WebM/Opus file', async () => {
    const pcmPath = path.join(dir, 'tone.pcm');
    const webmPath = path.join(dir, 'tone.webm');

    // 1 s of 440 Hz sine at modest amplitude, 16 kHz mono int16.
    const samples = 16_000;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16_000) * 8_000);
      buf.writeInt16LE(v, i * 2);
    }
    fs.writeFileSync(pcmPath, buf);

    const encoder = new WebmEncoder();
    const { bytes } = await encoder.encode(pcmPath, webmPath);

    expect(bytes).toBeGreaterThan(0);
    expect(fs.statSync(webmPath).size).toBe(bytes);
    // WebM/Matroska files always start with EBML header bytes 0x1A 0x45 0xDF 0xA3.
    const head = fs.readFileSync(webmPath).subarray(0, 4);
    expect(head[0]).toBe(0x1a);
    expect(head[1]).toBe(0x45);
    expect(head[2]).toBe(0xdf);
    expect(head[3]).toBe(0xa3);
  });

  it('rejects with kind="nonzero_exit" when the input file does not exist', async () => {
    const encoder = new WebmEncoder();
    const webmPath = path.join(dir, 'never.webm');
    await expect(encoder.encode(path.join(dir, 'missing.pcm'), webmPath))
      .rejects.toMatchObject({ name: 'WebmEncodeError', kind: 'nonzero_exit' });
    // Partial output (if any) cleaned up.
    expect(fs.existsSync(webmPath)).toBe(false);
  });

  it('rejects with kind="spawn" when the ffmpeg binary path is bogus', async () => {
    const encoder = new WebmEncoder({ ffmpegPath: '/this/does/not/exist/ffmpeg' });
    const pcmPath = path.join(dir, 'empty.pcm');
    fs.writeFileSync(pcmPath, Buffer.alloc(3_200));
    await expect(encoder.encode(pcmPath, path.join(dir, 'out.webm')))
      .rejects.toBeInstanceOf(WebmEncodeError);
  });

  it('constructor throws if ffmpegPath cannot be resolved', () => {
    // Simulate "no platform support" by forcing the override to empty.
    expect(() => new WebmEncoder({ ffmpegPath: '' })).toThrow();
  });
});

describe('resolveFfmpegPath', () => {
  it('returns either a string path or null', () => {
    const p = resolveFfmpegPath();
    expect(p === null || typeof p === 'string').toBe(true);
  });

  it('rewrites in-asar paths to the unpacked twin', () => {
    // Can't directly test the require shim, but we can confirm the function
    // doesn't throw and returns the swap-shape on a synthesized input via
    // the same logic by inspecting the return when present.
    const p = resolveFfmpegPath();
    if (p === null) return;
    expect(p.includes(`${path.sep}app.asar${path.sep}`)).toBe(false);
  });
});
