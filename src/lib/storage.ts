/**
 * Small localStorage helpers.
 *
 * The storage keys were renamed when the app was named BaleBook. Reads fall
 * back to the old key and copy the data across, so anything saved before the
 * rename is picked up instead of appearing to have vanished.
 */

export function readLocal(key: string, legacyKey?: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const current = window.localStorage.getItem(key);
    if (current !== null) return current;
    if (!legacyKey) return null;

    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy === null) return null;
    // Migrate once, then leave the old copy alone as a safety net.
    window.localStorage.setItem(key, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage full or unavailable - not fatal */
  }
}

export function removeLocal(key: string, legacyKey?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
    if (legacyKey) window.localStorage.removeItem(legacyKey);
  } catch {
    /* ignore */
  }
}
