import { describe, it, expect, vi } from 'vitest';
import {
  DiskMonitor,
  DISK_STOP_FREE_BYTES,
  DISK_WARN_FREE_BYTES,
} from '@core/audio/DiskMonitor';

/** Build a fake statfs that always reports `free` free bytes (block size 4096). */
function fakeStatfs(free: number) {
  return () => ({ bavail: BigInt(Math.floor(free / 4096)), bsize: 4096 });
}

describe('DiskMonitor — thresholds', () => {
  it('emits `stop` below 200 MB free', () => {
    const onStop = vi.fn();
    const onWarn = vi.fn();
    const m = new DiskMonitor({ dir: '/', statfs: fakeStatfs(DISK_STOP_FREE_BYTES - 1) });
    m.onStop(onStop);
    m.onWarn(onWarn);
    m.poll();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('emits `warn` between 200 MB and 2 GB free, not `stop`', () => {
    const onStop = vi.fn();
    const onWarn = vi.fn();
    const m = new DiskMonitor({ dir: '/', statfs: fakeStatfs(DISK_WARN_FREE_BYTES - 1) });
    m.onWarn(onWarn);
    m.onStop(onStop);
    m.poll();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('emits neither when there is plenty of free space', () => {
    const onStop = vi.fn();
    const onWarn = vi.fn();
    const m = new DiskMonitor({ dir: '/', statfs: fakeStatfs(DISK_WARN_FREE_BYTES * 2) });
    m.onWarn(onWarn);
    m.onStop(onStop);
    m.poll();
    expect(onWarn).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('start() polls immediately + on interval', () => {
    vi.useFakeTimers();
    try {
      const onWarn = vi.fn();
      const m = new DiskMonitor({ dir: '/', statfs: fakeStatfs(1_000_000_000) }); // 1 GB → warn
      m.onWarn(onWarn);
      m.start();
      expect(onWarn).toHaveBeenCalledTimes(1); // immediate
      vi.advanceTimersByTime(60_000); // two more ticks (every 30 s)
      expect(onWarn).toHaveBeenCalledTimes(3);
      m.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
