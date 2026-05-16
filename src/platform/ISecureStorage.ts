/**
 * ISecureStorage — encrypt/decrypt arbitrary strings (API keys, refresh tokens).
 *
 * Architecture: §5 (`SecureStorageI` → `ElectronSafeStorage`), §12.2 (API keys
 * stored via Electron `safeStorage.encryptString`).
 *
 * Implementations are platform-bound: macOS uses Keychain via Electron's
 * safeStorage, Windows uses DPAPI via the same API. Both return opaque bytes
 * that round-trip through `encrypt`/`decrypt` only on the same machine + user.
 *
 * We persist the *encrypted* base64 string in JobStore.kv; the cleartext only
 * lives in memory inside a `getApiKey()` callback.
 */

export interface ISecureStorage {
  /** True if the platform OS keyring is reachable + provisioned. */
  isAvailable(): boolean;

  /** Encrypt a UTF-8 string; returns base64. Throws if `isAvailable()` is false. */
  encrypt(plain: string): string;

  /** Decrypt a base64 payload produced by `encrypt`. Throws on tampering / wrong user. */
  decrypt(encrypted: string): string;
}
