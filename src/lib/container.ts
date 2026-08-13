/**
 * Shipping container numbers (ISO 6346).
 *
 * The format is four letters followed by seven digits, e.g. GAOU7441740:
 * a three letter owner code, one category letter, a six digit serial and a
 * final check digit.
 *
 * The format is enforced. The check digit is only *reported*, never enforced -
 * it is a useful catch for a mistyped number, but a container really does exist
 * with whatever number is stamped on it, and blocking an export over a digit
 * would be worse than shipping a warning.
 */

const FORMAT_RE = /^[A-Z]{4}\d{7}$/;

/**
 * ISO 6346 letter values. Letters run 10..38 skipping every multiple of 11.
 */
const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let value = 10;
  for (let i = 0; i < 26; i += 1) {
    if (value % 11 === 0) value += 1;
    map[String.fromCharCode(65 + i)] = value;
    value += 1;
  }
  return map;
})();

/** The expected final digit for the first ten characters, or null if unusable. */
export function containerCheckDigit(code: string): number | null {
  const value = code.toUpperCase();
  if (value.length < 10) return null;

  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = value[i];
    const digit = /\d/.test(ch) ? Number(ch) : LETTER_VALUES[ch];
    if (digit === undefined) return null;
    sum += digit * 2 ** i;
  }
  return (sum % 11) % 10;
}

export interface ContainerCheck {
  /** True when the format is valid, so it is safe to export. */
  ok: boolean;
  /** Normalised, uppercase, no spaces or dashes. */
  value: string;
  /** True when the ISO 6346 check digit agrees. */
  checkDigitValid: boolean;
  /** Set when something is wrong or worth a second look. */
  message?: string;
  /** True when the problem should block an export. */
  blocking: boolean;
}

/**
 * Normalise and validate a container number.
 *
 * Spaces and dashes are stripped and letters upper-cased, so "gaou 744174-0"
 * is accepted and stored as "GAOU7441740".
 */
export function checkContainerNumber(raw: string): ContainerCheck {
  const value = (raw ?? "").replace(/[\s-]+/g, "").toUpperCase();

  if (value === "") {
    return {
      ok: false,
      value,
      checkDigitValid: false,
      blocking: true,
      message: "A container number is required before exporting.",
    };
  }

  if (!FORMAT_RE.test(value)) {
    return {
      ok: false,
      value,
      checkDigitValid: false,
      blocking: true,
      message:
        "Use four letters followed by seven digits, for example GAOU7441740.",
    };
  }

  const expected = containerCheckDigit(value);
  const actual = Number(value[10]);
  const checkDigitValid = expected !== null && expected === actual;

  return {
    ok: true,
    value,
    checkDigitValid,
    blocking: false,
    message: checkDigitValid
      ? undefined
      : `The ISO 6346 check digit looks wrong - expected ${expected} at the end. Worth double checking, but you can still export.`,
  };
}

/** Uppercase and strip separators without judging the result. */
export function normalizeContainerNumber(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .slice(0, 11);
}
