/**
 * Words that appear in exported sheets and are read back out of them.
 *
 * Deliberately a module of its own, with no imports at all.
 *
 * These labels are needed by two very different sides: the spreadsheet builders,
 * which import ExcelJS, and the importers and pages, which must not. Keeping them
 * next to the builders meant importing one string from a module that instantiates
 * a workbook, which dragged ExcelJS into the browser bundle and took /balance from
 * 11 kB to 372 kB. A file with no dependencies cannot do that to anyone.
 */

/** Written in a Container column where something belongs to no container. */
export const GENERAL_LABEL = "(general)";

/** The label on the general overhead row of the Profit by Container tab. */
export const GENERAL_ROW_LABEL = "(general, not per container)";

/** Partner shown for an expense that arrived without one, matching byPartner. */
export const UNASSIGNED_PARTNER = "Unassigned";

/**
 * How a balance's direction reads in a spreadsheet.
 *
 * Words rather than "payable"/"receivable" because people read these sheets, and
 * they double as dependable SUMIF keys. The balances importer maps them back, so
 * these two strings and its reading of them have to change together.
 */
export const OWE_LABEL = "We owe";
export const OWED_LABEL = "Owed to us";

/**
 * How fast an item moves, in the markup calculation.
 *
 * Real values rather than a tick, so the fast/steady split in that sheet can be a
 * SUMIF that follows an item being reclassified.
 *
 * These two belong to the internal calculation only. Nothing a buyer or an
 * investor sees carries them, because they sit beside a markup.
 */
export const FAST_LABEL = "Fast";
export const STEADY_LABEL = "Steady";
