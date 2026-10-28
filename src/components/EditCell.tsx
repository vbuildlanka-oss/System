"use client";

/**
 * Table cells you can type straight into.
 *
 * Each keeps its own draft while it has focus. That matters wherever the figure
 * shown is worked out from what was typed - a selling price that is cost plus
 * markup, say. Without a draft, typing "2" towards "27,000" would be saved,
 * re-derived and written back as "2,000" before the next key arrived. While the
 * field is focused the draft is left alone; on blur it settles to the real value.
 *
 * Enter and the arrow keys move down the column (see lib/keyboard.ts) when a
 * `col` is given.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { moveInColumn } from "@/lib/keyboard";

const BASE =
  "w-full rounded-md border border-transparent bg-transparent px-2 py-1 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100";

function useDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return { draft, setDraft, focused };
}

export function NumberCell({
  value,
  onCommit,
  col,
  label,
  placeholder,
  integer,
  min = 0,
  blankWhenZero,
  check,
  onReject,
  format,
  className,
}: {
  value: number;
  /** Called with every valid figure as it is typed. */
  onCommit: (n: number) => void;
  col?: string;
  label: string;
  placeholder?: string;
  /** Bags and counts are whole numbers. */
  integer?: boolean;
  min?: number;
  /** Show an empty box rather than "0", e.g. for a price nobody has set. */
  blankWhenZero?: boolean;
  /**
   * A reason the figure cannot be used, or null. A refused figure is not
   * committed: the box turns red with the reason as its tooltip, and on leaving
   * it goes back to the real value and `onReject` hears why.
   */
  check?: (n: number) => string | null;
  onReject?: (reason: string) => void;
  /** How the figure reads when not being typed in, e.g. "Rs45,000.00". */
  format?: (n: number) => string;
  className?: string;
}) {
  const raw = blankWhenZero && value === 0 ? "" : String(value);
  const shown = format && raw !== "" ? format(value) : raw;
  const { draft, setDraft, focused } = useDraft(shown);
  const [refused, setRefused] = useState<string | null>(null);

  const read = (raw: string): number | null => {
    const cleaned = raw.replace(/[,\s]/g, "").replace(/^rs\.?/i, "");
    if (cleaned === "") return blankWhenZero ? 0 : null;
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n < min) return null;
    return integer ? Math.floor(n) : n;
  };

  return (
    <input
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      aria-label={label}
      data-col={col}
      value={draft}
      placeholder={placeholder}
      onFocus={(e) => {
        focused.current = true;
        // Type over the plain figure, not the formatted one.
        setDraft(raw);
        const input = e.currentTarget;
        requestAnimationFrame(() => input.select());
      }}
      title={refused ?? undefined}
      aria-invalid={refused !== null}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = read(e.target.value);
        if (n === null) return;
        const reason = check ? check(n) : null;
        setRefused(reason);
        if (reason === null) onCommit(n);
      }}
      onBlur={() => {
        focused.current = false;
        if (refused !== null) onReject?.(refused);
        setRefused(null);
        setDraft(shown);
      }}
      onKeyDown={(e) => {
        if (col) moveInColumn(e);
        if (e.key === "Escape") e.currentTarget.blur();
      }}
      className={cn(
        BASE,
        "text-right tabular-nums",
        className,
        refused !== null && "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-100",
      )}
    />
  );
}

export function TextCell({
  value,
  onCommit,
  col,
  label,
  placeholder,
  maxLength = 120,
  allowEmpty,
  className,
}: {
  value: string;
  onCommit: (s: string) => void;
  col?: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  /** Most names must not be blank: a blank keeps the old one. */
  allowEmpty?: boolean;
  className?: string;
}) {
  const { draft, setDraft, focused } = useDraft(value);
  return (
    <input
      type="text"
      aria-label={label}
      data-col={col}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        if (allowEmpty || e.target.value.trim() !== "") onCommit(e.target.value);
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(value);
      }}
      onKeyDown={(e) => {
        if (col) moveInColumn(e);
        if (e.key === "Escape") e.currentTarget.blur();
      }}
      className={cn(BASE, className)}
    />
  );
}
