/**
 * Verifies listing, backing up and clearing the browser store:
 *  - what is reported is what the pages would actually load, legacy keys and all
 *  - clearing removes the legacy copies too, so nothing reappears afterwards
 *  - reference numbering survives an ordinary clear, and only ever goes as a set
 *  - keys belonging to anything else on the domain are never touched
 *  - a backup captures every key, including ones this version no longer uses
 *  - none of it throws when there is no store, or when the store is nonsense
 */
import {
  backupStoredData,
  clearStoredData,
  DATA_SECTIONS,
  IDENTITY_KEYS,
  inspectStoredData,
  parseBackupText,
  restoreStoredData,
  type KeyValueStore,
} from "../src/lib/appData";

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log("  ok   -", msg);
  else {
    console.error("  FAIL -", msg);
    failures += 1;
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}

/** A stand-in for localStorage, so this can run outside a browser. */
class FakeStore implements KeyValueStore {
  private map = new Map<string, string>();
  constructor(entries: Record<string, string> = {}) {
    for (const k of Object.keys(entries)) this.map.set(k, entries[k]);
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

const EDITOR = JSON.stringify({
  sheets: [{ id: "a", rows: [] }, { id: "b", rows: [] }],
  activeId: "a",
});
const STOCK = JSON.stringify({ items: [{}, {}, {}], history: [{}] });
const REQUESTS = JSON.stringify({ requests: [{}], sources: [{}, {}] });
const BALANCE = JSON.stringify({ expenses: [{}, {}, {}, {}], turnover: [{}, {}] });
const MANIFESTS = JSON.stringify({ manifests: [{}] });
const BUYERS = JSON.stringify([{}, {}]);
const COUNT = JSON.stringify({
  containerId: "GAOU7441740",
  rows: [
    { name: "Anorak", expected: 21, counted: 21, touched: true },
    { name: "Blanket", expected: 12, counted: 9, touched: true },
    { name: "Cotton Scarf", expected: 6 },
  ],
});
const CALC = JSON.stringify({
  baseMarkup: 2000,
  rows: [
    { name: "Anorak", qty: 21, costPerBag: 24000, markup: 2000 },
    { name: "Blanket", qty: 12, costPerBag: 15000, markup: 3000 },
  ],
});

function populated(): FakeStore {
  return new FakeStore({
    "balebook.orderEditor.v3": EDITOR,
    "balebook.bagManifests.v1": MANIFESTS,
    "balebook.stockpile.v1": STOCK,
    "balebook.buyerRequests.v1": REQUESTS,
    "balebook.balanceSheet.v1": BALANCE,
    "balebook.buyers.v1": BUYERS,
    "balebook.calculation.v1": CALC,
    "balebook.bagCount.v1": COUNT,
    "balebook.deviceId.v1": "3F7K",
    "balebook.refCounter.v1": JSON.stringify({ date: "260814", n: 7 }),
    "balebook.usedRefs.v1": JSON.stringify(["BB-3F7K-260814-001", "BB-3F7K-260814-002"]),
    // Somebody else's data on the same domain.
    "theme": "dark",
    "otherapp.session": "abc",
  });
}

/* -------------------------------- inspecting ------------------------------- */

section("Listing what is stored");
{
  const store = populated();
  const report = inspectStoredData(store);

  check(report.sections.length === 8, `every section is listed (${report.sections.length})`);
  check(!report.empty, "and the store is not reported as empty");

  const by = (id: string) => report.sections.find((s) => s.id === id);
  check(by("orderEditor")?.detail === "2 open order sheets", `order sheets counted (${by("orderEditor")?.detail})`);
  check(by("stockpile")?.detail === "3 items, 1 movement", `stockpile counted (${by("stockpile")?.detail})`);
  check(
    by("requests")?.detail === "1 request list, 2 uploaded files",
    `requests counted (${by("requests")?.detail})`,
  );
  check(
    by("balanceSheet")?.detail === "4 expenses, 2 turnover entries",
    `the balance sheet is counted, with a readable plural (${by("balanceSheet")?.detail})`,
  );
  check(by("buyers")?.detail === "2 buyers", `saved buyers counted (${by("buyers")?.detail})`);
  check(
    by("calculation")?.detail === "2 items priced",
    `the calculation is counted (${by("calculation")?.detail})`,
  );
  check(
    by("bagCount")?.detail === "3 items counted",
    `the warehouse count is counted (${by("bagCount")?.detail})`,
  );
  check(by("bagManifests")?.detail === "1 manifest", `a single manifest reads as singular (${by("bagManifests")?.detail})`);
  check(
    report.sections.every((s) => s.present),
    "each one is marked as having something in it",
  );
  check(report.totalBytes > 0, `a size is reported (${report.totalBytes} bytes)`);

  check(report.identity.present, "reference numbering is reported");
  check(
    report.identity.detail.includes("2 references issued"),
    `including how many have been issued (${report.identity.detail})`,
  );
  check(
    report.identity.detail.includes("3F7K"),
    `and the device tag, read from the store being described (${report.identity.detail})`,
  );
  check(
    report.leftovers.length === 0,
    `nothing is mistaken for a leftover (${report.leftovers.join(", ")})`,
  );
}

section("Listing an empty and a part-filled store");
{
  const empty = inspectStoredData(new FakeStore());
  check(empty.empty, "an empty store is reported as empty");
  check(
    empty.sections.every((s) => !s.present && s.detail === "nothing saved"),
    "with every section marked as holding nothing",
  );
  check(!empty.identity.present, "and no reference numbering yet");

  const partial = inspectStoredData(
    new FakeStore({ "balebook.balanceSheet.v1": BALANCE }),
  );
  check(!partial.empty, "one saved section is enough to be non-empty");
  check(
    partial.sections.filter((s) => s.present).length === 1,
    "and only that section is marked as filled",
  );

  const broken = inspectStoredData(
    new FakeStore({ "balebook.stockpile.v1": "{not json" }),
  );
  const stock = broken.sections.find((s) => s.id === "stockpile");
  check(
    stock?.present === true && stock.detail === "saved, but unreadable",
    `unreadable data is reported honestly, not as empty (${stock?.detail})`,
  );
}

section("Legacy keys are reported, not overlooked");
{
  // Data saved under the pre-rename name. The app reads it, so it has to be
  // listed, or it would look as though there were nothing to clear.
  const store = new FakeStore({ "vbuild.stockpile.v1": STOCK });
  const report = inspectStoredData(store);
  const stock = report.sections.find((s) => s.id === "stockpile");
  check(stock?.present === true, "data under an old key still shows as present");
  check(stock?.detail === "3 items, 1 movement", `and is counted (${stock?.detail})`);
  check(!report.empty, "so the store is not reported as empty");
}

/* --------------------------------- clearing -------------------------------- */

section("Clearing everything");
{
  const store = populated();
  const result = clearStoredData({ store });

  check(store.getItem("balebook.orderEditor.v3") === null, "the order editor is emptied");
  check(store.getItem("balebook.stockpile.v1") === null, "the stockpile is emptied");
  check(store.getItem("balebook.buyerRequests.v1") === null, "the requests are emptied");
  check(store.getItem("balebook.balanceSheet.v1") === null, "the balance sheet is emptied");
  check(store.getItem("balebook.bagManifests.v1") === null, "the manifests are emptied");
  check(store.getItem("balebook.buyers.v1") === null, "the saved buyers are emptied");
  check(
    store.getItem("balebook.calculation.v1") === null,
    "and so is the private markup calculation",
  );
  check(
    store.getItem("balebook.bagCount.v1") === null,
    "and the warehouse count",
  );
  check(result.sections.length === 8, `all eight sections are reported cleared (${result.sections.length})`);

  // The whole point of clearing: what the pages load afterwards is nothing.
  const after = inspectStoredData(store);
  check(
    after.sections.every((s) => !s.present),
    "and nothing is left for any page to load",
  );

  check(
    store.getItem("theme") === "dark" && store.getItem("otherapp.session") === "abc",
    "data belonging to anything else on the domain is untouched",
  );
}

section("Reference numbering survives an ordinary clear");
{
  const store = populated();
  const result = clearStoredData({ store });

  check(store.getItem("balebook.deviceId.v1") === "3F7K", "the device tag is kept");
  check(store.getItem("balebook.refCounter.v1") !== null, "so is the daily counter");
  check(store.getItem("balebook.usedRefs.v1") !== null, "and the ledger of issued references");
  check(!result.identityCleared, "and the result says so");

  // This is the trap being avoided: resetting the counter while keeping the tag
  // would restart at 001 for today and could reprint an issued reference.
  const counter = JSON.parse(store.getItem("balebook.refCounter.v1") as string) as {
    n?: number;
  };
  check(counter.n === 7, `the counter keeps its place (${counter.n})`);
}

section("Resetting reference numbering, when asked");
{
  const store = populated();
  const result = clearStoredData({ store, includeIdentity: true });

  for (const key of IDENTITY_KEYS) {
    check(store.getItem(key) === null, `${key} is cleared`);
  }
  check(result.identityCleared, "and the result says so");

  // The tag and the counter must never part company: a new tag cannot reproduce
  // a reference issued under the old one, which is what makes this safe.
  const store2 = populated();
  clearStoredData({ store: store2, includeIdentity: true });
  const tagGone = store2.getItem("balebook.deviceId.v1") === null;
  const counterGone = store2.getItem("balebook.refCounter.v1") === null;
  check(
    tagGone === counterGone,
    "the device tag and the counter are always cleared together, never one alone",
  );
}

section("Clearing one section at a time");
{
  const store = populated();
  clearStoredData({ store, sectionIds: ["balanceSheet"] });

  check(store.getItem("balebook.balanceSheet.v1") === null, "the chosen section goes");
  check(store.getItem("balebook.stockpile.v1") !== null, "the others stay");
  check(store.getItem("balebook.orderEditor.v3") !== null, "all of them");
  check(store.getItem("balebook.deviceId.v1") !== null, "and so does reference numbering");

  const none = clearStoredData({ store, sectionIds: [] });
  check(none.removed.length === 0, "clearing nothing removes nothing");
}

section("Legacy copies go too, so nothing comes back");
{
  // The failure this guards against: delete only the current key, and the next
  // read copies the old key forward, so the data returns and the clear looks
  // broken.
  const store = new FakeStore({
    "balebook.orderEditor.v3": EDITOR,
    "balebook.orderEditor.v1": EDITOR,
    "vbuild.orderEditor.v1": EDITOR,
    "balebook.stockpile.v1": STOCK,
    "vbuild.stockpile.v1": STOCK,
    "balebook.bagManifests.v1": MANIFESTS,
    "balebook.bagLists.v1": MANIFESTS,
    "balebook.buyers.v1": BUYERS,
    "vbuild.buyers.v1": BUYERS,
  });
  clearStoredData({ store });

  check(store.length === 0, `every copy is gone (${store.keys().join(", ") || "store empty"})`);
  const after = inspectStoredData(store);
  check(
    after.sections.every((s) => !s.present),
    "so nothing is read back from an old key",
  );
  check(after.empty, "and the store reports itself as empty");
}

section("Leftovers from older versions");
{
  const store = populated();
  store.setItem("balebook.somethingRetired.v1", "old");
  store.setItem("vbuild.ancient", "older");

  const report = inspectStoredData(store);
  check(
    report.leftovers.length === 2,
    `unclaimed keys of ours are spotted (${report.leftovers.join(", ")})`,
  );

  const result = clearStoredData({ store });
  check(result.leftovers.length === 2, "and swept up on a full clear");
  check(store.getItem("balebook.somethingRetired.v1") === null, "the retired key goes");
  check(store.getItem("vbuild.ancient") === null, "and the ancient one");
  check(store.getItem("theme") === "dark", "while a stranger's key is still left alone");

  // On a partial clear there is no way to know which section a stray key
  // belonged to, so it is left where it is.
  const store2 = populated();
  store2.setItem("balebook.somethingRetired.v1", "old");
  const partial = clearStoredData({ store: store2, sectionIds: ["stockpile"] });
  check(partial.leftovers.length === 0, "a partial clear sweeps nothing");
  check(
    store2.getItem("balebook.somethingRetired.v1") === "old",
    "and leaves the stray key alone",
  );
}

/* --------------------------------- backup --------------------------------- */

section("Backing up before clearing");
{
  const store = populated();
  const backup = backupStoredData(store);

  check(backup.app === "balebook-backup", "the file says what it is");
  check(backup.version === 1, "and carries a version");
  check(!Number.isNaN(Date.parse(backup.savedAt)), `and when it was taken (${backup.savedAt})`);

  const keys = Object.keys(backup.data);
  check(keys.length === 11, `every key of ours is captured (${keys.length})`);
  check(
    backup.data["balebook.balanceSheet.v1"] === BALANCE,
    "with the data exactly as stored, byte for byte",
  );
  check(
    backup.data["balebook.deviceId.v1"] === "3F7K",
    "including reference numbering, which the clear leaves behind",
  );
  check(
    !("theme" in backup.data) && !("otherapp.session" in backup.data),
    "and nothing belonging to anything else",
  );

  // A retired key must be kept: this version cannot read it, a later one might.
  const store2 = populated();
  store2.setItem("balebook.somethingRetired.v1", "old");
  check(
    backupStoredData(store2).data["balebook.somethingRetired.v1"] === "old",
    "a key this version no longer uses is still backed up",
  );

  check(
    Object.keys(backupStoredData(new FakeStore()).data).length === 0,
    "an empty store backs up to an empty file rather than failing",
  );

  // The round trip that matters: the backup is enough to put things back.
  const restored = new FakeStore(backup.data);
  const report = inspectStoredData(restored);
  check(
    report.sections.every((s) => s.present),
    "restoring the backup brings every section back",
  );
  check(
    report.sections.find((s) => s.id === "balanceSheet")?.detail ===
      "4 expenses, 2 turnover entries",
    "with the same contents as before",
  );
}

/* -------------------------------- restoring ------------------------------- */

section("Restoring a backup");
{
  const source = populated();
  const backup = backupStoredData(source);

  const target = new FakeStore();
  const result = restoreStoredData(backup, target);

  check(result.problem === undefined, `a real backup restores (${result.problem ?? "no problem"})`);
  check(result.restored.length === 11, `every key comes back (${result.restored.length})`);
  check(
    target.getItem("balebook.balanceSheet.v1") === BALANCE,
    "with the data byte for byte",
  );

  const report = inspectStoredData(target);
  check(
    report.sections.every((s) => s.present),
    "so every section is there afterwards",
  );
  check(
    report.sections.find((s) => s.id === "stockpile")?.detail === "3 items, 1 movement",
    "with the same contents",
  );
  check(
    target.getItem("balebook.deviceId.v1") === "3F7K",
    "and the device tag is put back, so references carry on where they were",
  );
}

section("Restoring over existing data");
{
  const target = new FakeStore({
    "balebook.balanceSheet.v1": JSON.stringify({ expenses: [{}], turnover: [] }),
    "balebook.stockpile.v1": STOCK,
  });
  const backup = backupStoredData(populated());
  restoreStoredData(backup, target);

  check(
    target.getItem("balebook.balanceSheet.v1") === BALANCE,
    "a section in the file replaces what was there",
  );
  check(
    inspectStoredData(target).sections.find((s) => s.id === "balanceSheet")?.detail ===
      "4 expenses, 2 turnover entries",
    "rather than being merged into it",
  );
}

section("Refusing a file that is not a backup");
{
  const target = new FakeStore();
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["a number", 42],
    ["a string", "backup"],
    ["an empty object", {}],
    ["another app's JSON", { app: "something-else", data: { a: "b" } }],
    ["a backup with no data", { app: "balebook-backup" }],
    ["a backup with empty data", { app: "balebook-backup", data: {} }],
    // The order editor's own saved document, chosen by mistake.
    ["a document instead of a backup", { app: "balebook-order-editor", sheets: [] }],
  ];
  for (const entry of cases) {
    const result = restoreStoredData(entry[1], target);
    check(
      result.problem !== undefined && result.restored.length === 0,
      `${entry[0]} is refused, with a reason ("${result.problem ?? ""}")`,
    );
  }
  check(target.length === 0, "and nothing was written while refusing any of them");
}

section("A backup file cannot reach beyond this app");
{
  // A hand-edited file could otherwise name any key in localStorage. Only keys
  // under this app's own prefixes are ever written.
  const target = new FakeStore({ "theme": "dark", "otherapp.session": "abc" });
  // Written as text on purpose. In an object literal "__proto__" sets the
  // prototype and never becomes a key, so building this with an object would
  // quietly drop the very thing being tested. A real uploaded file is text.
  const hostileFile = parseBackupText(
    `{"app":"balebook-backup","version":1,"savedAt":"2026-08-14T00:00:00.000Z",` +
      `"data":{"balebook.stockpile.v1":${JSON.stringify(STOCK)},` +
      `"theme":"light","otherapp.session":"stolen","__proto__":"nonsense"}}`,
  );
  const result = restoreStoredData(hostileFile, target);

  check(result.restored.length === 1, `only our own key is written (${result.restored.join(", ")})`);
  check(target.getItem("balebook.stockpile.v1") === STOCK, "and it is written correctly");
  check(target.getItem("theme") === "dark", "a stranger's key is left as it was");
  check(
    target.getItem("otherapp.session") === "abc",
    "even when the file tries to overwrite it",
  );
  check(
    result.refused.length === 3,
    `and the refusals are reported (${result.refused.map((r) => r.key).join(", ")})`,
  );
  check(
    result.refused.some((r) => r.key === "__proto__"),
    "a __proto__ key in the file is refused like any other foreign key",
  );
  check(
    ({} as Record<string, unknown>).nonsense === undefined,
    "and nothing was pushed onto Object's prototype",
  );
  check(
    result.refused.every((r) => r.reason !== ""),
    "each with a reason",
  );

  const notText = restoreStoredData(
    {
      app: "balebook-backup",
      version: 1,
      savedAt: "",
      data: { "balebook.stockpile.v1": { sneaky: true } } as never,
    },
    new FakeStore(),
  );
  check(
    notText.refused.some((r) => r.reason === "not text"),
    "a value that is not text is refused rather than stringified into the store",
  );
}

section("Reading a backup file's text");
{
  check(parseBackupText("not json") === null, "unparseable text comes back as null");
  check(parseBackupText("") === null, "so does empty text");
  const parsed = parseBackupText(JSON.stringify({ app: "balebook-backup" })) as {
    app?: string;
  };
  check(parsed?.app === "balebook-backup", "and good JSON comes back parsed");
}

section("Backup then clear then restore");
{
  // The whole point of the backup button sitting next to the delete button.
  const store = populated();
  const backup = backupStoredData(store);

  clearStoredData({ store });
  check(
    inspectStoredData(store).sections.every((s) => !s.present),
    "after clearing, every section is empty",
  );

  const result = restoreStoredData(backup, store);
  check(result.problem === undefined, "the backup taken beforehand still restores");
  const after = inspectStoredData(store);
  check(
    after.sections.every((s) => s.present),
    "and brings every section back",
  );
  check(
    after.sections.find((s) => s.id === "balanceSheet")?.detail ===
      "4 expenses, 2 turnover entries",
    "with nothing lost along the way",
  );
}

/* -------------------------------- robustness ------------------------------- */

section("When there is no store");
{
  // Server rendering, or a browser with storage switched off.
  const report = inspectStoredData(null);
  check(report.empty, "listing reports an empty store rather than throwing");
  check(report.sections.length === 8, "and still names every section");

  const result = clearStoredData({ store: null });
  check(result.removed.length === 0, "clearing does nothing rather than throwing");
  check(!result.identityCleared, "and reports nothing cleared");

  check(
    Object.keys(backupStoredData(null).data).length === 0,
    "and a backup comes back empty rather than throwing",
  );
}

section("When the store misbehaves");
{
  // A store that throws on every call, as a full or locked-down one would.
  const hostile: KeyValueStore = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
    key() {
      throw new Error("denied");
    },
    get length(): number {
      throw new Error("denied");
    },
  };

  let threw = false;
  try {
    const report = inspectStoredData(hostile);
    check(report.sections.length === 8, "listing survives a store that throws");
  } catch {
    threw = true;
  }
  check(!threw, "listing does not propagate the failure");

  threw = false;
  try {
    clearStoredData({ store: hostile });
  } catch {
    threw = true;
  }
  check(!threw, "neither does clearing");

  threw = false;
  try {
    backupStoredData(hostile);
  } catch {
    threw = true;
  }
  check(!threw, "nor backing up");

  threw = false;
  let restoreResult: ReturnType<typeof restoreStoredData> | null = null;
  try {
    restoreResult = restoreStoredData(
      {
        app: "balebook-backup",
        version: 1,
        savedAt: "",
        data: { "balebook.stockpile.v1": STOCK },
      },
      hostile,
    );
  } catch {
    threw = true;
  }
  check(!threw, "nor restoring");
  check(
    restoreResult !== null && restoreResult.restored.length === 0,
    "and a store that refuses to save reports nothing restored rather than lying",
  );
  check(
    restoreResult !== null && restoreResult.problem !== undefined,
    `with a problem to show the user ("${restoreResult?.problem ?? ""}")`,
  );
}

section("The section list itself");
{
  const ids = DATA_SECTIONS.map((s) => s.id);
  check(new Set(ids).size === ids.length, "no section id is repeated");
  const keys = DATA_SECTIONS.flatMap((s) => [s.key, ...s.legacyKeys]);
  check(new Set(keys).size === keys.length, "and no key is claimed by two sections");
  check(
    keys.every((k) => k.startsWith("balebook.") || k.startsWith("vbuild.")),
    "every key sits under a prefix this app owns",
  );
  check(
    !keys.some((k) => IDENTITY_KEYS.includes(k)),
    "and no section quietly claims a reference-numbering key",
  );
  check(
    DATA_SECTIONS.every((s) => s.label !== "" && s.page !== ""),
    "every section can be named and placed in the dialog",
  );
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL STORED-DATA CHECKS PASSED");
