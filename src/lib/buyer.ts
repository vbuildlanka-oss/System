/**
 * Buyer details: validation, formatting and lightweight local memory.
 *
 * Everything here is browser/file based - there is no database. Recent buyers
 * are remembered in localStorage so you never have to retype a regular
 * customer, and saved session files carry their own copy of the buyer.
 */

import { readLocal, writeLocal } from "./storage";
import { getDeviceId } from "./device";

export interface Buyer {
  name: string;
  phone: string;
}

export const EMPTY_BUYER: Buyer = { name: "", phone: "" };

export type PhoneKind =
  | "empty"
  | "lk-mobile"
  | "lk-landline"
  | "international"
  | "invalid";

export interface PhoneCheck {
  /** True when the number looks usable (dialable). */
  ok: boolean;
  kind: PhoneKind;
  /** Canonical form, e.g. "+94771234567". Null when we can't be confident. */
  e164: string | null;
  /** Human friendly form, e.g. "+94 77 123 4567". Falls back to raw input. */
  pretty: string;
  /** A short explanation shown under the field. */
  message?: string;
}

/** Known Sri Lankan mobile prefixes (after the leading 0 / +94). */
const LK_MOBILE_PREFIXES = ["70", "71", "72", "74", "75", "76", "77", "78"];

/**
 * Validate and normalise a phone number, with Sri Lanka as the default country
 * but full tolerance for international numbers (some buyers are overseas).
 *
 * The rule we follow everywhere: never silently rewrite what the user typed.
 * If we cannot confidently normalise it, `pretty` returns their original text
 * and the UI shows a gentle warning instead of blocking them.
 */
export function checkPhone(raw: string): PhoneCheck {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return { ok: false, kind: "empty", e164: null, pretty: "" };
  }

  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 0) {
    return {
      ok: false,
      kind: "invalid",
      e164: null,
      pretty: trimmed,
      message: "That doesn't contain any digits.",
    };
  }

  // --- Sri Lankan forms -------------------------------------------------
  // 0771234567 (10 digits, leading 0)
  // 94771234567 / +94771234567 (11 digits, leading 94)
  // 771234567 (9 digits, no trunk prefix)
  let lkNational: string | null = null;
  if (digits.length === 11 && digits.startsWith("94")) {
    lkNational = digits.slice(2);
  } else if (!hadPlus && digits.length === 10 && digits.startsWith("0")) {
    lkNational = digits.slice(1);
  } else if (!hadPlus && digits.length === 9 && digits.startsWith("7")) {
    lkNational = digits;
  }

  if (lkNational && lkNational.length === 9) {
    const prefix = lkNational.slice(0, 2);
    const isMobile = LK_MOBILE_PREFIXES.includes(prefix);
    return {
      ok: true,
      kind: isMobile ? "lk-mobile" : "lk-landline",
      e164: `+94${lkNational}`,
      pretty: `+94 ${lkNational.slice(0, 2)} ${lkNational.slice(2, 5)} ${lkNational.slice(5)}`,
      message: isMobile ? undefined : "Saved as a Sri Lankan landline.",
    };
  }

  // --- International ----------------------------------------------------
  // E.164 allows up to 15 digits; anything under 8 is almost certainly a typo.
  if (hadPlus && digits.length >= 8 && digits.length <= 15) {
    return {
      ok: true,
      kind: "international",
      e164: `+${digits}`,
      pretty: `+${digits}`,
      message: "Saved as an international number.",
    };
  }

  const tooShort = digits.length < 9;
  return {
    ok: false,
    kind: "invalid",
    e164: null,
    pretty: trimmed,
    message: tooShort
      ? "That looks too short. A Sri Lankan number has 10 digits, e.g. 077 123 4567."
      : "That doesn't look like a valid number. Add + for international numbers.",
  };
}

/** What we print on a PDF: the tidy form when valid, otherwise their text. */
export function displayPhone(raw: string): string {
  const check = checkPhone(raw);
  return check.ok ? check.pretty : (raw ?? "").trim();
}

/** A wa.me link for one-tap WhatsApp, or null if the number isn't usable. */
export function whatsappLink(raw: string): string | null {
  const check = checkPhone(raw);
  if (!check.ok || !check.e164) return null;
  return `https://wa.me/${check.e164.replace(/\D/g, "")}`;
}

/** A tel: link for one-tap calling, or null if the number isn't usable. */
export function telLink(raw: string): string | null {
  const check = checkPhone(raw);
  if (!check.ok || !check.e164) return null;
  return `tel:${check.e164}`;
}

/** True when at least one buyer field has content. */
export function hasBuyerInfo(buyer: Buyer | null | undefined): boolean {
  if (!buyer) return false;
  return buyer.name.trim() !== "" || buyer.phone.trim() !== "";
}

/**
 * Key used to decide whether two buyer entries are the same person.
 * Phone wins when present, since names get typed inconsistently.
 */
export function buyerIdentityKey(buyer: Buyer): string {
  const check = checkPhone(buyer.phone);
  if (check.e164) return `p:${check.e164}`;
  return `n:${buyer.name.trim().toLowerCase()}`;
}

/** Internal alias kept for readability below. */
const buyerKey = buyerIdentityKey;

/* --------------------------- recent buyer store --------------------------- */

const BUYERS_KEY = "balebook.buyers.v1";
const BUYERS_KEY_LEGACY = "vbuild.buyers.v1";
const MAX_BUYERS = 25;

export function loadBuyers(): Buyer[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocal(BUYERS_KEY, BUYERS_KEY_LEGACY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((b) => b && typeof b.name === "string")
      .map((b) => ({ name: String(b.name), phone: String(b.phone ?? "") }))
      .slice(0, MAX_BUYERS);
  } catch {
    return [];
  }
}

/** Save a buyer to the front of the recent list, de-duplicated. */
export function rememberBuyer(buyer: Buyer): Buyer[] {
  if (typeof window === "undefined") return [];
  const clean: Buyer = {
    name: buyer.name.trim(),
    phone: buyer.phone.trim(),
  };
  if (!hasBuyerInfo(clean)) return loadBuyers();

  const key = buyerKey(clean);
  const existing = loadBuyers().filter((b) => buyerKey(b) !== key);
  const next = [clean, ...existing].slice(0, MAX_BUYERS);
  writeLocal(BUYERS_KEY, JSON.stringify(next));
  return next;
}

export function forgetBuyer(buyer: Buyer): Buyer[] {
  if (typeof window === "undefined") return [];
  const key = buyerKey(buyer);
  const next = loadBuyers().filter((b) => buyerKey(b) !== key);
  writeLocal(BUYERS_KEY, JSON.stringify(next));
  return next;
}

/* ---------------------------- reference numbers ---------------------------- */

const REF_KEY = "balebook.refCounter.v1";
const REF_KEY_LEGACY = "vbuild.refCounter.v1";

function todayStamp(d = new Date()): string {
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Next document reference, e.g. "BB-3F7K-260809-003".
 *
 * Made of a fixed per-device tag, the date, and a counter that climbs through
 * the day and resets each morning. The device tag is what keeps two browsers
 * from both issuing "001" for the same day. It stays editable in the UI so you
 * always have the final say on what appears on the document.
 */
export function nextRefNo(): string {
  const stamp = todayStamp();
  const device = getDeviceId();
  if (typeof window === "undefined") return `BB-${device}-${stamp}-001`;
  let n = 1;
  try {
    const raw = readLocal(REF_KEY, REF_KEY_LEGACY);
    if (raw) {
      const saved = JSON.parse(raw) as { date?: string; n?: number };
      if (saved.date === stamp && typeof saved.n === "number") {
        n = saved.n + 1;
      }
    }
    writeLocal(REF_KEY, JSON.stringify({ date: stamp, n }));
  } catch {
    /* ignore */
  }
  return `BB-${device}-${stamp}-${String(n).padStart(3, "0")}`;
}

/* --------------------------- used-reference ledger ------------------------- */
/**
 * Auto-generated references cannot collide, but the field stays editable, so a
 * number could be typed by hand that clashes with one already issued. Every
 * reference that reaches a downloaded document is recorded here so the UI can
 * warn if that ever happens. Comparison is case-insensitive.
 */

const USED_REFS_KEY = "balebook.usedRefs.v1";
const MAX_USED_REFS = 1000;

export function loadUsedRefs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocal(USED_REFS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((r) => String(r)) : [];
  } catch {
    return [];
  }
}

export function isRefUsed(ref: string): boolean {
  const value = ref.trim().toUpperCase();
  if (value === "") return false;
  return loadUsedRefs().some((r) => r.toUpperCase() === value);
}

/** Record a reference as issued. Called when a document is downloaded. */
export function recordRef(ref: string): void {
  const value = ref.trim();
  if (value === "") return;
  const existing = loadUsedRefs().filter(
    (r) => r.toUpperCase() !== value.toUpperCase(),
  );
  const next = [value, ...existing].slice(0, MAX_USED_REFS);
  writeLocal(USED_REFS_KEY, JSON.stringify(next));
}


/* ------------------------------ sanitisation ------------------------------ */

/**
 * Make an untrusted value safe to place in a PDF: strip control characters,
 * collapse whitespace, trim, and cap the length so a very long paste can never
 * break the document layout.
 */
export function sanitizeLine(value: unknown, maxLength: number): string {
  // Only text-like values are usable. Objects and arrays would otherwise be
  // stringified into "[object Object]" and printed on the document.
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export const BUYER_NAME_MAX = 80;
export const BUYER_PHONE_MAX = 30;
export const REF_NO_MAX = 40;

/** Coerce an untrusted payload into a safe Buyer. */
export function sanitizeBuyer(input: unknown): Buyer {
  const obj = (input ?? {}) as Record<string, unknown>;
  return {
    name: sanitizeLine(obj.name, BUYER_NAME_MAX),
    phone: sanitizeLine(obj.phone, BUYER_PHONE_MAX),
  };
}
