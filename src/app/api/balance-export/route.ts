import { NextRequest, NextResponse } from "next/server";
import {
  balanceFilename,
  parseBalanceSheet,
  MAX_ENTRIES,
} from "@/lib/balanceSheet";
import { buildBalanceXlsx } from "@/lib/balanceXlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn a balance sheet into a workbook.
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
    const body = await req.json();
    const sheet = parseBalanceSheet(body);

    if (sheet.expenses.length === 0 && sheet.turnover.length === 0) {
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

    const xlsx = await buildBalanceXlsx(sheet);
    return new NextResponse(new Uint8Array(xlsx), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${balanceFilename("xlsx")}"`,
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
