import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PcmFileWriter } from '@core/audio/PcmFileWriter';

describe('PcmFileWriter', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-pcm-'));
    file = path.join(dir, 'test.pcm');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates an empty file on open (no header)', () => {
    const w = new PcmFileWriter(file);
    w.open();
    const closed = w.close();
    expect(closed.bytes).toBe(0);
    expect(fs.statSync(file).size).toBe(0);
  });

  it('appends raw int16 PCM bytes with no header prefix', () => {
    const w = new PcmFileWriter(file);
    w.open();
    // 1 second of 16 kHz int16 mono = 32 000 bytes.
    const pcm = Buffer.alloc(32_000, 0x42);
    w.append(pcm);
    const closed = w.close();
    expect(closed.bytes).toBe(32_000);

    const buf = fs.readFileSync(file);
    expect(buf.length).toBe(32_000);
    // No RIFF/WAVE wrapper — first bytes are the PCM payload itself.
    expect(buf[0]).toBe(0x42);
    expect(buf[buf.length - 1]).toBe(0x42);
  });

  it('multiple appends accumulate exactly', () => {
    const w = new PcmFileWriter(file);
    w.open();
    w.append(Buffer.alloc(1_000));
    w.append(Buffer.alloc(2_000));
    w.append(Buffer.alloc(3_000));
    const closed = w.close();
    expect(closed.bytes).toBe(6_000);
    expect(fs.statSync(file).size).toBe(6_000);
  });

  it('zero-length append is a no-op', () => {
    const w = new PcmFileWriter(file);
    w.open();
    w.append(Buffer.alloc(0));
    const closed = w.close();
    expect(closed.bytes).toBe(0);
  });

  it('abort() closes the FD and unlinks the file', () => {
    const w = new PcmFileWriter(file);
    w.open();
    w.append(Buffer.alloc(100));
    w.abort();
    expect(fs.existsSync(file)).toBe(false);
    expect(w.isOpen()).toBe(false);
  });

  it('refuses double-open', () => {
    const w = new PcmFileWriter(file);
    w.open();
    expect(() => w.open()).toThrow(/already open/);
    w.close();
  });

  it('refuses append before open', () => {
    const w = new PcmFileWriter(file);
    expect(() => w.append(Buffer.alloc(10))).toThrow(/not open/);
  });

  it('refuses close before open', () => {
    const w = new PcmFileWriter(file);
    expect(() => w.close()).toThrow(/not open/);
  });
});
