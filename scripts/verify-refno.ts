/**
 * Verifies device IDs and reference numbers.
 *
 * These rely on window.localStorage, so a minimal in-memory shim stands in for
 * the browser. Clearing it simulates either a fresh device or a "clear site
 * data", which is exactly the case a device tag has to survive.
 */

// --- browser shim (must be installed before importing the modules) ---------
class MemStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}
const storage = new MemStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: storage };

import { getDeviceId } from "../src/lib/device";
import { nextRefNo, isRefUsed, recordRef, loadUsedRefs } from "../src/lib/buyer";

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

const REF_RE = /^BB-[0-9A-Z]{4}-\d{6}-\d{3,}$/;

section("Device ID");
const id1 = getDeviceId();
check(/^[0-9A-Z]{4}$/.test(id1), `is a four-character tag ("${id1}")`);
check(getDeviceId() === id1, "is stable - the same tag on every call");
storage.clear();
const id2 = getDeviceId();
check(getDeviceId() === id2, "a fresh device gets its own stable tag");
// The point of the tag: fresh installs almost never collide.
storage.clear();
const tags = new Set<string>();
for (let i = 0; i < 200; i += 1) {
  storage.clear();
  tags.add(getDeviceId());
}
check(tags.size >= 198, `200 fresh devices produced ${tags.size} distinct tags`);

section("Reference format");
storage.clear();
const ref = nextRefNo();
check(REF_RE.test(ref), `looks like BB-TAG-YYMMDD-NNN ("${ref}")`);
const device = getDeviceId();
check(ref.includes(`-${device}-`), "embeds this device's tag");

section("Counter within a day");
storage.clear();
const a = nextRefNo();
const b = nextRefNo();
const c = nextRefNo();
check(
  a.endsWith("-001") && b.endsWith("-002") && c.endsWith("-003"),
  `counts up 001, 002, 003 (${a.slice(-3)}, ${b.slice(-3)}, ${c.slice(-3)})`,
);
check(new Set([a, b, c]).size === 3, "three references, all different");

section("Counter resets each day");
// Force yesterday's counter, then confirm today starts fresh at 001.
storage.setItem(
  "balebook.refCounter.v1",
  JSON.stringify({ date: "200101", n: 47 }),
);
const afterRollover = nextRefNo();
check(
  afterRollover.endsWith("-001"),
  `a new day restarts the counter at 001 (got ${afterRollover.slice(-3)})`,
);

section("Two devices never collide");
storage.clear();
const deviceA: string[] = [];
const devA = getDeviceId();
for (let i = 0; i < 5; i += 1) deviceA.push(nextRefNo());
// Simulate a second device by wiping storage (new tag, counter back to 001).
storage.clear();
const deviceB: string[] = [];
const devB = getDeviceId();
for (let i = 0; i < 5; i += 1) deviceB.push(nextRefNo());

check(devA !== devB, `the two devices took different tags (${devA} vs ${devB})`);
check(
  deviceA[0].endsWith("-001") && deviceB[0].endsWith("-001"),
  "both devices start their counters at 001",
);
const overlap = deviceA.filter((r) => deviceB.includes(r));
check(
  overlap.length === 0,
  "despite both counting 001..005, no reference is shared between the devices",
);

section("Storage wipe cannot reissue an old reference");
storage.clear();
const beforeWipe = nextRefNo(); // e.g. BB-XXXX-YYMMDD-001
storage.clear(); // clear site data: new tag, counter reset
const afterWipe = nextRefNo(); // also -001, but a different tag
check(
  beforeWipe.endsWith("-001") && afterWipe.endsWith("-001"),
  "both are -001",
);
check(
  beforeWipe !== afterWipe,
  `yet the full references differ (${beforeWipe} vs ${afterWipe})`,
);

section("Used-reference ledger");
storage.clear();
check(!isRefUsed("BB-3F7K-260810-001"), "an unseen reference is not flagged");
recordRef("BB-3F7K-260810-001");
check(isRefUsed("BB-3F7K-260810-001"), "a recorded reference is flagged");
check(
  isRefUsed("bb-3f7k-260810-001"),
  "the check is case-insensitive",
);
check(!isRefUsed(""), "an empty reference is never flagged");
recordRef("BB-3F7K-260810-001");
check(
  loadUsedRefs().filter((r) => r === "BB-3F7K-260810-001").length === 1,
  "recording the same reference twice does not duplicate it",
);

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL REFERENCE CHECKS PASSED");
