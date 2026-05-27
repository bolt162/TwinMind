/**
 * FakePasteService — no-op IPasteService for e2e tests.
 *
 * Records the last paste payload on `globalThis.__e2e` so specs can assert
 * what would have been pasted without actually synthesizing system keystrokes.
 */

import type { IPasteService, PasteResult } from '../IPasteService';

export class FakePasteService implements IPasteService {
  lastText: string | null = null;
  pasteCalls = 0;

  async paste(text: string): Promise<PasteResult> {
    this.lastText = text;
    this.pasteCalls += 1;
    return { pasted: true, clipboardOnly: false, target: 'test:fake' };
  }
}
