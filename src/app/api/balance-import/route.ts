import { NextRequest, NextResponse } from "next/server";
import { parseCsv, xlsxToGrids } from "@/lib/parseTabular";
import {
  parseExpenseGrid,
  pickExpenseSheet,
  type ExpenseImport,
} from "@/lib/expensesImport";
import {
  parseBalanceGrid,
  pickBalanceSheet,
  type BalanceImport,
} from "@/lib/balancesImport";
import type { SkippedRow } from "@/lib/sheetImport";
import {
  parseTurnoverGrid,
  pickTurnoverSheet,
  type TurnoverImport,
} from "@/lib/turnoverImport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

type FileKind = "csv" | "xlsx";
type Scope = "expenses" | "balances" | "turnover" | "all";

function fileKindOf(filename: string): FileKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}

interface Reading {
  sheetName: string;
  rows: unknown[];
  skipped: SkippedRow[];
  found: Record<string, boolean>;
  problem?: string;
}

/**
 * Read a spreadsheet for the balance sheet and report what is in it.
 *
 * Both kinds are served from here rather than from a route each, so the size
 * limit, the extension check and the shape of every reply cannot drift apart:
 *
 *   expenses  expense name, partner, container, amount
 *   balances  outstanding amounts - party, total, paid, due
 *
 * This only reads and reports. Nothing is added to the sheet here, so the page
 * can show what was found, what is already on the sheet and what was skipped, and
 * let the decision be made from that rather than from a file name.
 *
 * Duplicate flagging is left to the caller, which is the side holding the sheet.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const asked = form.get("scope");
    const scope: Scope =
      asked === "balances" || asked === "turnover" || asked === "all"
        ? asked
        : "expenses";
    const noun =
      scope === "all" ? "entries" : scope === "turnover" ? "turnover" : scope;

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const fileKind = fileKindOf(file.name);
    if (!fileKind) {
      return NextResponse.json(
        {
          error: file.name.toLowerCase().endsWith(".xls")
            ? "Old .xls files are not supported. Re-save the sheet as .xlsx and upload it again."
            : `Please upload an XLSX or CSV file of ${noun}.`,
        },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "File is too large (max 15 MB)." },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // The whole balance sheet workbook in one go: expenses, turnover and
    // balances from their own tabs. A part the file does not have is simply
    // empty, so an expenses-only export restores through here as well.
    if (scope === "all") {
      if (fileKind !== "xlsx") {
        return NextResponse.json(
          { error: "Restoring a whole balance sheet needs the XLSX workbook." },
          { status: 400 },
        );
      }
      const grids = await xlsxToGrids(buffer);
      const has = (name: string) => grids.some((g) => g.name.toLowerCase() === name);
      const expenses = has("expenses") ? pickExpenseSheet(grids) : null;
      const turnover = has("turnover") ? pickTurnoverSheet(grids) : null;
      const balances = has("balances") ? pickBalanceSheet(grids) : null;
      const rowsOf = (r: { rows: unknown[]; problem?: string } | null) =>
        r && !r.problem ? r.rows : [];
      const total =
        rowsOf(expenses).length + rowsOf(turnover).length + rowsOf(balances).length;
      if (total === 0) {
        return NextResponse.json(
          {
            error:
              "That workbook has no Expenses, Turnover or Balances tab to restore from. Use the balance sheet workbook downloaded from this page.",
          },
          { status: 422 },
        );
      }
      return NextResponse.json({
        scope,
        fileName: file.name,
        sheetName: "",
        expenses: rowsOf(expenses),
        turnover: rowsOf(turnover),
        balances: rowsOf(balances),
        skipped: [],
        skippedTotal: 0,
      });
    }

    let result: Reading;
    if (scope === "turnover") {
      const read: TurnoverImport =
        fileKind === "xlsx"
          ? pickTurnoverSheet(await xlsxToGrids(buffer))
          : parseTurnoverGrid(parseCsv(buffer.toString("utf8")), "CSV");
      result = { ...read, rows: read.rows, found: {} };
    } else if (scope === "balances") {
      const read: BalanceImport =
        fileKind === "xlsx"
          ? // Every sheet is offered, so a whole workbook is read from its
            // Balances tab rather than failing on whichever tab comes first.
            pickBalanceSheet(await xlsxToGrids(buffer))
          : parseBalanceGrid(parseCsv(buffer.toString("utf8")), "CSV");
      result = { ...read, rows: read.rows, found: { ...read.found } };
    } else {
      const read: ExpenseImport =
        fileKind === "xlsx"
          ? pickExpenseSheet(await xlsxToGrids(buffer))
          : parseExpenseGrid(parseCsv(buffer.toString("utf8")), "CSV");
      result = { ...read, rows: read.rows, found: { ...read.found } };
    }

    if (result.problem) {
      return NextResponse.json({ error: result.problem }, { status: 422 });
    }

    if (result.rows.length === 0) {
      // Say why nothing was found. "Nothing was imported" with no reason is the
      // single most useless thing this route could reply.
      const reasons = Array.from(
        new Set(result.skipped.map((s) => s.reason)),
      ).slice(0, 3);
      const because =
        reasons.length > 0
          ? ` ${result.skipped.length} row(s) were skipped: ${reasons.join("; ")}.`
          : "";
      return NextResponse.json(
        {
          error: `No ${noun} could be read from that file.${because}`,
          skipped: result.skipped.slice(0, 50),
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      scope,
      sheetName: result.sheetName,
      fileName: file.name,
      rows: result.rows,
      // Capped so a wildly wrong file cannot return a reply of thousands of
      // complaints.
      skipped: result.skipped.slice(0, 50),
      skippedTotal: result.skipped.length,
      found: result.found,
    });
  } catch (err) {
    console.error("balance-import error:", err);
    return NextResponse.json(
      {
        error:
          "Could not read that file. It may be corrupted, password protected, or not a spreadsheet.",
      },
      { status: 500 },
    );
  }
}
