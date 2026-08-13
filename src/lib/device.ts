/**
 * A stable per-device tag.
 *
 * Reference numbers count up from 001 in each browser, so two devices would
 * otherwise both issue "001" and collide. A short random tag, created once and
 * kept forever, is folded into every reference so each device's numbers live in
 * their own space:
 *
 *   BB-3F7K-260810-001
 *      ^^^^ this device
 *
 * The tag is generated once and never changed by the app. The only thing that
 * removes it is the browser's own "clear site data" - and that is harmless
 * here: a fresh random tag is minted, and because it will not match the old
 * one, previously issued references still cannot be reproduced.
 */

import { readLocal, writeLocal } from "./storage";

const DEVICE_KEY = "balebook.deviceId.v1";

/**
 * Unambiguous alphabet - no 0/O, 1/I/L or U - so a tag read off a printed
 * document can be typed back without guesswork. 30 symbols, four characters,
 * gives 810,000 possible tags: ample separation for the handful of devices one
 * business uses.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const TAG_LENGTH = 4;
const TAG_RE = /^[0-9A-Z]{4}$/;

function randomTag(): string {
  const chars: string[] = [];
  const cryptoObj =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(TAG_LENGTH);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < TAG_LENGTH; i += 1) {
      chars.push(ALPHABET[bytes[i] % ALPHABET.length]);
    }
  } else {
    for (let i = 0; i < TAG_LENGTH; i += 1) {
      chars.push(ALPHABET[Math.floor(Math.random() * ALPHABET.length)]);
    }
  }
  return chars.join("");
}

/**
 * The tag for this browser, creating and storing it on first use. Returns a
 * fixed placeholder during server rendering (never persisted), since the real
 * tag only has meaning in the browser where documents are generated.
 */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "0000";

  const existing = readLocal(DEVICE_KEY);
  if (existing && TAG_RE.test(existing)) return existing.toUpperCase();

  const id = randomTag();
  writeLocal(DEVICE_KEY, id);
  return id;
}
