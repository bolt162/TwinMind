import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WavFileWriter } from '@core/audio/WavFileWriter';

describe('WavFileWriter', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-wav-'));
    file = path.join(dir, 'test.wav');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a 44-byte header on open', () => {
    const w = new WavFileWriter(file);
    w.open();
    w.close();
    const buf = fs.readFileSync(file);
    expect(buf.length).toBe(44);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
    expect(buf.toString('ascii', 36, 40)).toBe('data');
    // Sample rate (offset 24) = 16000
    expect(buf.readUInt32LE(24)).toBe(16_000);
    // Channels (offset 22) = 1
    expect(buf.readUInt16LE(22)).toBe(1);
    // Bits per sample (offset 34) = 16
    expect(buf.readUInt16LE(34)).toBe(16);
  });

  it('appends int16 PCM bytes and patches the size fields on close', () => {
    const w = new WavFileWriter(file);
    w.open();
    // 1 second of 16 kHz int16 mono = 32 000 bytes.
    const pcm = Buffer.alloc(32_000, 0x00);
    w.append(pcm);
    const closed = w.close();
    expect(closed.bytes).toBe(44 + 32_000);
    expect(closed.dataBytes).toBe(32_000);
    expect(closed.durationMs).toBe(1_000);

    const buf = fs.readFileSync(file);
    // RIFF chunk size at offset 4 = total - 8
    expect(buf.readUInt32LE(4)).toBe(44 + 32_000 - 8);
    // data chunk size at offset 40 = pcm length
    expect(buf.readUInt32LE(40)).toBe(32_000);
  });

  it('multiple appends accumulate', () => {
    const w = new WavFileWriter(file);
    w.open();
    w.append(Buffer.alloc(1_000));
    w.append(Buffer.alloc(2_000));
    w.append(Buffer.alloc(3_000));
    const closed = w.close();
    expect(closed.dataBytes).toBe(6_000);
  });

  it('abort() closes the FD and unlinks the file', () => {
    const w = new WavFileWriter(file);
    w.open();
    w.append(Buffer.alloc(100));
    w.abort();
    expect(fs.existsSync(file)).toBe(false);
    expect(w.isOpen()).toBe(false);
  });

  it('refuses double-open', () => {
    const w = new WavFileWriter(file);
    w.open();
    expect(() => w.open()).toThrow(/already open/);
    w.close();
  });
});
