/**
 * Keyboard helpers for typing a column of figures quickly.
 *
 * Costs, counts and salaries get typed one row after another. Reaching for the
 * mouse between rows is the slow part, so Enter (and the arrow keys) move to the
 * same column on the next row, the way a spreadsheet does. Each field in a column
 * carries a data-col attribute naming its column; nothing else is needed.
 *
 * No imports, so any page can use it.
 */

type FieldKey = { key: string; shiftKey: boolean; currentTarget: HTMLElement; preventDefault(): void };

/** Move to the next (or previous) field of the same column. */
export function moveInColumn(event: FieldKey): void {
  const forward =
    event.key === "ArrowDown" || (event.key === "Enter" && !event.shiftKey);
  const back = event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey);
  if (!forward && !back) return;

  const here = event.currentTarget;
  const column = here.dataset.col;
  if (!column) return;
  const all = Array.from(
    document.querySelectorAll<HTMLInputElement>(`[data-col="${CSS.escape(column)}"]`),
  );
  const index = all.indexOf(here as HTMLInputElement);
  if (index < 0) return;
  const next = all[index + (forward ? 1 : -1)];
  // A number input uses the arrows to step its value. Keep that unless the
  // field is at a row boundary we can move across.
  event.preventDefault();
  if (next) {
    next.focus();
    next.select?.();
  } else {
    (here as HTMLInputElement).blur();
  }
}
