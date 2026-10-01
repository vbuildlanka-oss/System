"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";

/**
 * Undo for hands that move faster than eyes.
 *
 * A warehouse is no place for "Are you sure?" on every tap - it gets clicked
 * through without being read, and slows down the ninety-nine taps that were
 * right. So destructive actions just happen, a snapshot of what was there is kept,
 * and a bar at the bottom of the screen offers to put it back. Ctrl+Z (Cmd+Z)
 * does the same from the keyboard, except while typing in a field, where it
 * belongs to the field.
 *
 * Several steps are kept, so a run of wrong taps can be walked back one by one.
 */

const MAX_STEPS = 30;
/** How long the bar stays up after the last change. Undo still works after. */
const VISIBLE_MS = 8000;

interface Step<T> {
  label: string;
  snapshot: T;
}

export interface Undo<T> {
  /** Keep what is there now, before changing it. */
  remember: (snapshot: T, label: string) => void;
  /** Put the last remembered state back. */
  undo: () => void;
  /** Forget everything, e.g. after a fresh document is loaded deliberately. */
  clear: () => void;
  /** The step Undo would reverse, or null. */
  last: string | null;
  visible: boolean;
  hide: () => void;
  depth: number;
}

export function useUndo<T>(restore: (snapshot: T) => void): Undo<T> {
  const [steps, setSteps] = useState<Step<T>[]>([]);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  const show = useCallback(() => {
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), VISIBLE_MS);
  }, []);

  const remember = useCallback(
    (snapshot: T, label: string) => {
      setSteps((was) => [...was, { label, snapshot }].slice(-MAX_STEPS));
      show();
    },
    [show],
  );

  const undo = useCallback(() => {
    setSteps((was) => {
      const step = was[was.length - 1];
      if (!step) return was;
      restoreRef.current(step.snapshot);
      return was.slice(0, -1);
    });
    show();
  }, [show]);

  const clear = useCallback(() => {
    setSteps([]);
    setVisible(false);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey) return;
      if (event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      // Inside a field, Ctrl+Z undoes the typing - leave that to the browser.
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return {
    remember,
    undo,
    clear,
    last: steps.length > 0 ? steps[steps.length - 1].label : null,
    visible,
    hide: () => setVisible(false),
    depth: steps.length,
  };
}

export default function UndoToast<T>({ undo }: { undo: Undo<T> }) {
  if (!undo.visible || undo.last === null) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
    >
      <div className="flex max-w-md animate-fade-in items-center gap-3 rounded-xl bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">
        <span className="min-w-0 flex-1 truncate">{undo.last}</span>
        <button
          onClick={undo.undo}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 font-semibold transition hover:bg-white/20"
        >
          <RotateCcw className="h-4 w-4" />
          Undo
          {undo.depth > 1 && (
            <span className="text-xs font-normal text-white/60">
              ({undo.depth})
            </span>
          )}
        </button>
        <span className="hidden text-xs text-white/50 sm:inline">Ctrl+Z</span>
        <button
          onClick={undo.hide}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-white/60 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
