/**
 * DarwinSecureStorage — Electron `safeStorage` wrapper.
 *
 * Architecture: §12.2 — encrypted Groq key stored as a base64 string in
 * JobStore.kv. The cleartext only leaves Keychain inside the GroqAsrClient's
 * `getApiKey` callback (composition reads + decrypts it on demand).
 *
 * The same code works on Windows (DPAPI) and macOS (Keychain) because
 * `safeStorage` abstracts both; the "darwin" naming reflects file placement,
 * not platform-specific code.
 */

import { safeStorage } from 'electron';
import type { ISecureStorage } from '../ISecureStorage';

export class DarwinSecureStorage implements ISecureStorage {
  /** True if Keychain (mac) / DPAPI (win) is available + provisioned. */
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  /** Encrypt `plain` and return base64. Throws if encryption isn't available. */
  encrypt(plain: string): string {
    if (!this.isAvailable()) {
      throw new Error('DarwinSecureStorage: encryption not available');
    }
    return safeStorage.encryptString(plain).toString('base64');
  }

  /** Decrypt a base64 payload produced by `encrypt`. Throws on tampering. */
  decrypt(encrypted: string): string {
    if (!this.isAvailable()) {
      throw new Error('DarwinSecureStorage: encryption not available');
    }
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }
}
