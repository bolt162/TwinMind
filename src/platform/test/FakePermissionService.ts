/**
 * FakePermissionService — in-memory IPermissionService for e2e tests.
 *
 * Only constructed when `TWINMIND_E2E=1`. macOS TCC prompts are OS-level
 * modals Playwright can't drive; the real DarwinPermissionService is
 * swapped out for this one so the wizard's state machine and the IPC
 * plumbing run unmodified against test-controlled grant state.
 *
 * The test (running outside Electron) mutates state via
 * `globalThis.__e2e.permissions.set(kind, grant)`. See `src/main.ts` for
 * the hook registration.
 */

import type {
  IPermissionService,
  PermissionGrant,
  PermissionKind,
} from '../IPermissionService';

const ALL_KINDS: ReadonlyArray<PermissionKind> = [
  'mic',
  'audioCapture',
  'accessibility',
  'notifications',
];

export class FakePermissionService implements IPermissionService {
  private readonly grants = new Map<PermissionKind, PermissionGrant>();

  constructor(initial?: Partial<Record<PermissionKind, PermissionGrant>>) {
    for (const k of ALL_KINDS) {
      this.grants.set(k, initial?.[k] ?? 'not_determined');
    }
  }

  read(kind: PermissionKind): PermissionGrant {
    return this.grants.get(kind) ?? 'not_determined';
  }

  async request(kind: PermissionKind): Promise<PermissionGrant> {
    // request() in production triggers the OS dialog. In tests we just
    // return the currently-set grant — the test "approves" by calling
    // .set(kind, 'granted') before invoking the IPC. If the current grant
    // is `not_determined` we promote it to `granted` to model the common
    // "click Allow when prompted" path; tests that want a deny just set
    // 'denied' first.
    const current = this.grants.get(kind) ?? 'not_determined';
    if (current === 'not_determined') {
      this.grants.set(kind, 'granted');
      return 'granted';
    }
    return current;
  }

  async openSystemSettings(_kind: PermissionKind): Promise<void> {
    /* no-op in tests */
  }

  // ─── Test-only mutators ─────────────────────────────────────────────────
  set(kind: PermissionKind, grant: PermissionGrant): void {
    this.grants.set(kind, grant);
  }

  setAll(grant: PermissionGrant): void {
    for (const k of ALL_KINDS) this.grants.set(k, grant);
  }

  snapshot(): Record<PermissionKind, PermissionGrant> {
    const out = {} as Record<PermissionKind, PermissionGrant>;
    for (const k of ALL_KINDS) out[k] = this.grants.get(k) ?? 'not_determined';
    return out;
  }
}
