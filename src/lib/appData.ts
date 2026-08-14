/**
 * Everything this app keeps in the browser, in one place, so it can be listed,
 * backed up and cleared.
 *
 * Two things make clearing worth doing carefully rather than calling
 * localStorage.clear():
 *
 *   Legacy keys. Reads fall back to an older key and copy the data forward, so
 *   deleting only the current key would make the data reappear on the next load
 *   and look like the clear had failed.
 *
 *   Reference numbers. The device tag, the daily counter and the ledger of
 *   issued references are not working data - they exist so that no reference is
 *   ever printed twice. They are left alone by default, and when they do go,
 *   they go together. See IDENTITY_KEYS.
 */

/** The slice of the localStorage API used here, so a fake can be passed in. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** The browser's store, or null when there isn't one (server rendering). */
export function browserStore(): KeyValueStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Prefixes this app owns. Anything else in the store is somebody else's. */
export const OWNED_PREFIXES = ["balebook.", "vbuild."];

export interface DataSection {
  id: string;
  label: string;
  /** Where it is used, so the dialog can say what will be emptied. */
  page: string;
  key: string;
  /** Older names the same data may still be sitting under. */
  legacyKeys: string[];
  /** A short human count of what is stored, e.g. "3 order sheets". */
  describe: (parsed: unknown) => string;
  /** Field holding when it was last written, if the document records one. */
  timestampField?: "updatedAt" | "savedAt";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Length of an array field on a parsed document, or 0. */
function countOf(parsed: unknown, field: string): number {
  if (!parsed || typeof parsed !== "object") return 0;
  const value = (parsed as Record<string, unknown>)[field];
  return Array.isArray(value) ? value.length : 0;
}

export const DATA_SECTIONS: DataSection[] = [
  {
    id: "orderEditor",
    label: "Order Editor",
    page: "/edit",
    key: "balebook.orderEditor.v3",
    // v1 is read by the bag manifests page too, and the vbuild name predates
    // the rename, so both have to go or the sheets come back.
    legacyKeys: ["balebook.orderEditor.v1", "vbuild.orderEditor.v1"],
    describe: (p) => plural(countOf(p, "sheets"), "open order sheet"),
    timestampField: "savedAt",
  },
  {
    id: "bagManifests",
    label: "Bag Manifests",
    page: "/bag-manifests",
    key: "balebook.bagManifests.v1",
    legacyKeys: ["balebook.bagLists.v1"],
    describe: (p) => plural(countOf(p, "manifests"), "manifest"),
    timestampField: "updatedAt",
  },
  {
    id: "stockpile",
    label: "Stockpile",
    page: "/stockpile",
    key: "balebook.stockpile.v1",
    legacyKeys: ["vbuild.stockpile.v1"],
    describe: (p) =>
      `${plural(countOf(p, "items"), "item")}, ${plural(countOf(p, "history"), "movement")}`,
    timestampField: "updatedAt",
  },
  {
    id: "requests",
    label: "Buyer Requests",
    page: "/requests",
    key: "balebook.buyerRequests.v1",
    legacyKeys: [],
    describe: (p) =>
      `${plural(countOf(p, "requests"), "request list")}, ${plural(countOf(p, "sources"), "uploaded file")}`,
    timestampField: "updatedAt",
  },
  {
    id: "balanceSheet",
    label: "Balance Sheet",
    page: "/balance",
    key: "balebook.balanceSheet.v1",
    legacyKeys: [],
    describe: (p) =>
      `${plural(countOf(p, "expenses"), "expense")}, ${plural(countOf(p, "turnover"), "turnover entry", "turnover entries")}`,
    timestampField: "updatedAt",
  },
  {
    id: "buyers",
    label: "Saved buyers",
    page: "used on every document",
    key: "balebook.buyers.v1",
    legacyKeys: ["vbuild.buyers.v1"],
    describe: (p) => plural(Array.isArray(p) ? p.length : 0, "buyer"),
  },
];

/**
 * The keys that keep reference numbers from repeating.
 *
 * These are cleared only as one unit, and never as part of the ordinary clear.
 * The reason is a trap: a reference is the device tag, the date and a counter.
 * Wiping the counter while keeping the tag restarts it at 001 for today, so the
 * next document could carry a reference already printed on one that has gone
 * out. Wiping the tag as well is safe, because a fresh tag cannot reproduce any
 * reference issued under the old one.
 */
export const IDENTITY_KEYS = [
  "balebook.deviceId.v1",
  "balebook.refCounter.v1",
  "vbuild.refCounter.v1",
  "balebook.usedRefs.v1",
];

export const IDENTITY_LABEL = "Reference numbering for this device";

/* -------------------------------- inspecting ------------------------------- */

export interface SectionState {
  id: string;
  label: string;
  page: string;
  present: boolean;
  /** What is in it, or why it is empty. */
  detail: string;
  bytes: number;
  /** ISO time it was last written, when the document records one. */
  savedAt: string | null;
  /** The key it lives under, so the page can be plain about what it deletes. */
  keys: string[];
}

export interface StoredDataReport {
  sections: SectionState[];
  /** Reference numbering, reported apart from the working data. */
  identity: { present: boolean; detail: string; bytes: number };
  /** Keys this app owns that no section claims - older versions, mostly. */
  leftovers: string[];
  totalBytes: number;
  /** True when there is nothing of ours in the browser at all. */
  empty: boolean;
}

function sizeOf(store: KeyValueStore, key: string): number {
  const raw = store.getItem(key);
  return raw === null ? 0 : raw.length;
}

/** Every key in the store that belongs to this app. */
function ownedKeys(store: KeyValueStore): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && OWNED_PREFIXES.some((p) => key.startsWith(p))) keys.push(key);
  }
  return keys;
}

/** What is currently stored, for showing before anything is deleted. */
export function inspectStoredData(
  store: KeyValueStore | null = browserStore(),
): StoredDataReport {
  const blank: StoredDataReport = {
    sections: DATA_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      page: s.page,
      present: false,
      detail: "nothing saved",
      bytes: 0,
      savedAt: null,
      keys: [s.key, ...s.legacyKeys],
    })),
    identity: { present: false, detail: "not set up yet", bytes: 0 },
    leftovers: [],
    totalBytes: 0,
    empty: true,
  };
  if (!store) return blank;

  try {
    const claimed = new Set<string>();
    const sections = DATA_SECTIONS.map((section) => {
      for (const key of [section.key, ...section.legacyKeys]) claimed.add(key);

      // The same fallback the app itself uses, so what is reported is what the
      // page would actually load.
      const raw =
        store.getItem(section.key) ??
        section.legacyKeys.map((k) => store.getItem(k)).find((v) => v !== null) ??
        null;

      const bytes =
        sizeOf(store, section.key) +
        section.legacyKeys.reduce((sum, k) => sum + sizeOf(store, k), 0);

      const keys = [section.key, ...section.legacyKeys];
      if (raw === null) {
        return {
          id: section.id,
          label: section.label,
          page: section.page,
          present: false,
          detail: "nothing saved",
          bytes,
          savedAt: null,
          keys,
        };
      }
      let detail: string;
      let savedAt: string | null = null;
      try {
        const parsed = JSON.parse(raw);
        detail = section.describe(parsed);
        if (section.timestampField && parsed && typeof parsed === "object") {
          const stamp = (parsed as Record<string, unknown>)[section.timestampField];
          // Only a date that actually parses, so a junk value is shown as
          // unknown rather than as "Invalid Date".
          if (typeof stamp === "string" && !Number.isNaN(Date.parse(stamp))) {
            savedAt = stamp;
          }
        }
      } catch {
        detail = "saved, but unreadable";
      }
      return {
        id: section.id,
        label: section.label,
        page: section.page,
        present: true,
        detail,
        bytes,
        savedAt,
        keys,
      };
    });

    for (const key of IDENTITY_KEYS) claimed.add(key);
    // Read through the store that was passed in, not through window, or this
    // reports on a different store from the one being described.
    const device = store.getItem("balebook.deviceId.v1");
    const identityBytes = IDENTITY_KEYS.reduce(
      (sum, k) => sum + sizeOf(store, k),
      0,
    );
    const usedRaw = store.getItem("balebook.usedRefs.v1");
    let issued = 0;
    try {
      const parsed = usedRaw === null ? [] : JSON.parse(usedRaw);
      issued = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      issued = 0;
    }
    const identityPresent = IDENTITY_KEYS.some(
      (k) => store.getItem(k) !== null,
    );

    const leftovers = ownedKeys(store).filter((k) => !claimed.has(k));

    const totalBytes =
      sections.reduce((sum, s) => sum + s.bytes, 0) +
      identityBytes +
      leftovers.reduce((sum, k) => sum + sizeOf(store, k), 0);

    return {
      sections,
      identity: {
        present: identityPresent,
        detail: identityPresent
          ? `device ${device ?? "?"}, ${plural(issued, "reference")} issued`
          : "not set up yet",
        bytes: identityBytes,
      },
      leftovers,
      totalBytes,
      empty: !sections.some((s) => s.present) && !identityPresent && leftovers.length === 0,
    };
  } catch {
    return blank;
  }
}

/* --------------------------------- backup --------------------------------- */

export interface BackupFile {
  app: "balebook-backup";
  version: 1;
  savedAt: string;
  /** Every key this app owns, exactly as stored. */
  data: Record<string, string>;
}

/**
 * Everything, raw.
 *
 * Deliberately a dump of the keys rather than a tidied export: its only job is
 * to be able to put things back, so it must not lose anything the app might
 * later understand, including keys this version has stopped using.
 */
export function backupStoredData(
  store: KeyValueStore | null = browserStore(),
): BackupFile {
  const data: Record<string, string> = {};
  if (store) {
    try {
      for (const key of ownedKeys(store)) {
        const raw = store.getItem(key);
        if (raw !== null) data[key] = raw;
      }
    } catch {
      /* a partial backup is still better than none */
    }
  }
  return {
    app: "balebook-backup",
    version: 1,
    savedAt: new Date().toISOString(),
    data,
  };
}

/* --------------------------------- clearing -------------------------------- */

export interface ClearOptions {
  /** Sections to empty. Defaults to all of them. */
  sectionIds?: string[];
  /** Also reset reference numbering. All of those keys go together. */
  includeIdentity?: boolean;
  store?: KeyValueStore | null;
}

export interface ClearResult {
  /** Keys actually deleted. */
  removed: string[];
  /** Sections emptied, by id. */
  sections: string[];
  identityCleared: boolean;
  /** Unclaimed keys of ours that were swept up. */
  leftovers: string[];
}

/**
 * Delete stored data.
 *
 * Only keys under this app's own prefixes are ever touched, so anything else on
 * the domain is left alone. Leftover keys from older versions are swept only on
 * a full clear, since on a partial clear there is no way to know which section
 * they belonged to.
 */
export function clearStoredData(options: ClearOptions = {}): ClearResult {
  const store = options.store === undefined ? browserStore() : options.store;
  const ids = options.sectionIds ?? DATA_SECTIONS.map((s) => s.id);
  const chosen = DATA_SECTIONS.filter((s) => ids.includes(s.id));
  const full = chosen.length === DATA_SECTIONS.length;

  const result: ClearResult = {
    removed: [],
    sections: chosen.map((s) => s.id),
    identityCleared: false,
    leftovers: [],
  };
  if (!store) return result;

  const drop = (key: string) => {
    try {
      if (store.getItem(key) === null) return;
      store.removeItem(key);
      result.removed.push(key);
    } catch {
      /* ignore a key that will not budge */
    }
  };

  try {
    for (const section of chosen) {
      drop(section.key);
      // Legacy keys must go too, or the next read copies the data forward and
      // it looks as though nothing was cleared.
      for (const key of section.legacyKeys) drop(key);
    }

    if (options.includeIdentity) {
      // As one unit: see IDENTITY_KEYS.
      for (const key of IDENTITY_KEYS) drop(key);
      result.identityCleared = true;
    }

    if (full) {
      const claimed = new Set<string>([
        ...DATA_SECTIONS.flatMap((s) => [s.key, ...s.legacyKeys]),
        ...(options.includeIdentity ? [] : IDENTITY_KEYS),
      ]);
      for (const key of ownedKeys(store)) {
        if (claimed.has(key)) continue;
        drop(key);
        result.leftovers.push(key);
      }
    }
  } catch {
    /* whatever was removed before the failure stays removed */
  }

  return result;
}


/* -------------------------------- restoring ------------------------------- */

export interface RestoreResult {
  /** Keys written back. */
  restored: string[];
  /** Keys in the file that were refused, and why. */
  refused: Array<{ key: string; reason: string }>;
  problem?: string;
}

/**
 * Put a backup file back.
 *
 * Two things are checked rather than trusted. The file has to actually be one of
 * ours, so a wrong file chosen by accident is refused instead of scattering
 * nonsense through the store. And every key in it is checked against this app's
 * own prefixes before being written, because a hand-edited file could otherwise
 * name any key in localStorage and reach data belonging to something else on the
 * domain.
 *
 * Restoring replaces a key outright rather than merging. Merging two versions of
 * an accounting document without being asked is a worse outcome than replacing
 * one, and the caller is expected to have said so.
 */
export function restoreStoredData(
  file: unknown,
  store: KeyValueStore | null = browserStore(),
): RestoreResult {
  const result: RestoreResult = { restored: [], refused: [] };

  if (!file || typeof file !== "object") {
    result.problem = "That file is not a BaleBook backup.";
    return result;
  }
  const backup = file as Partial<BackupFile>;
  if (backup.app !== "balebook-backup") {
    result.problem =
      "That file is not a BaleBook backup. Use a file downloaded from this page.";
    return result;
  }
  if (!backup.data || typeof backup.data !== "object") {
    result.problem = "That backup has no data in it.";
    return result;
  }
  if (!store) {
    result.problem = "This browser will not let the app save anything.";
    return result;
  }

  const entries = Object.keys(backup.data as Record<string, unknown>);
  if (entries.length === 0) {
    result.problem = "That backup is empty, so there is nothing to put back.";
    return result;
  }

  for (const key of entries) {
    const value = (backup.data as Record<string, unknown>)[key];
    if (typeof value !== "string") {
      result.refused.push({ key, reason: "not text" });
      continue;
    }
    if (!OWNED_PREFIXES.some((p) => key.startsWith(p))) {
      result.refused.push({ key, reason: "not a BaleBook key" });
      continue;
    }
    try {
      store.setItem(key, value);
      result.restored.push(key);
    } catch {
      result.refused.push({ key, reason: "could not be saved" });
    }
  }

  if (result.restored.length === 0) {
    result.problem = "Nothing in that file could be restored.";
  }
  return result;
}

/** Read a backup file's text. Kept here so the page does not parse JSON itself. */
export function parseBackupText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
