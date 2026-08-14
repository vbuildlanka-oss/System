import { NextRequest, NextResponse } from "next/server";
import {
  balanceFilename,
  expensesFilename,
  parseBalanceSheet,
  MAX_ENTRIES,
} from "@/lib/balanceSheet";
import { buildBalanceXlsx } from "@/lib/balanceXlsx";
import { buildExpensesXlsx } from "@/lib/expensesXlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExportBody {
  /** "full" for the whole sheet, "expenses" for the expenses on their own. */
  scope?: unknown;
  sheet?: unknown;
}

/**
 * Turn a balance sheet into a workbook.
 *
 * Two scopes are served from here rather than from two routes, so the payload
 * validation below cannot drift between them:
 *
 *   full      five tabs - turnover, expenses, profit per container, partners
 *   expenses  one tab of expense name, partner and amount, and nothing else
 *
 * The build happens on the server for the same reason the manifest and PDF
 * exports do: ExcelJS is far too heavy to ship to the browser, and the /balance
 * page should stay a small download.
 *
 * Whatever arrives is put through parseBalanceSheet before anything is written,
 * so the workbook is built from the same validated rows the page works with. A
 * hand-edited or corrupted payload cannot produce a spreadsheet full of NaN.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as unknown;
    // A body of null, a number or a string would throw on a property read, and a
    // malformed request deserves a 400 rather than a 500.
    const body: ExportBody =
      raw !== null && typeof raw === "object" ? (raw as ExportBody) : {};
    const expensesOnly = body.scope === "expenses";
    // The sheet used to be posted as the whole body, so both shapes are read.
    const sheet = parseBalanceSheet(body.sheet ?? raw);

    if (expensesOnly) {
      if (sheet.expenses.length === 0) {
        return NextResponse.json(
          { error: "There are no expenses to export yet." },
          { status: 400 },
        );
      }
    } else if (sheet.expenses.length === 0 && sheet.turnover.length === 0) {
      return NextResponse.json(
        { error: "There is nothing to export yet." },
        { status: 400 },
      );
    }
    if (
      sheet.expenses.length > MAX_ENTRIES ||
      sheet.turnover.length > MAX_ENTRIES
    ) {
      return NextResponse.json(
        { error: `Too many entries (limit ${MAX_ENTRIES} of each).` },
        { status: 400 },
      );
    }

    const xlsx = expensesOnly
      ? await buildExpensesXlsx(sheet)
      : await buildBalanceXlsx(sheet);
    const filename = expensesOnly
      ? expensesFilename("xlsx")
      : balanceFilename("xlsx");

    return new NextResponse(new Uint8Array(xlsx), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("balance-export error:", err);
    return NextResponse.json(
      { error: "Failed to build the spreadsheet." },
      { status: 500 },
    );
  }
}
