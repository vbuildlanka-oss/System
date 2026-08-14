import { NextRequest, NextResponse } from "next/server";
import { parseCsv, xlsxToGrids } from "@/lib/parseTabular";
import {
  parseExpenseGrid,
  pickExpenseSheet,
  type ExpenseImport,
} from "@/lib/expensesImport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

type Kind = "csv" | "xlsx";

function kindOf(filename: string): Kind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}

/**
 * Read an expenses spreadsheet and report what is in it.
 *
 * This only reads and reports. Nothing is added to the balance sheet here, so
 * the page can show what was found, what is already on the sheet and what was
 * skipped, and let the decision be made from that rather than from a file name.
 *
 * Duplicate flagging is left to the caller, which is the side that holds the
 * balance sheet.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const kind = kindOf(file.name);
    if (!kind) {
      return NextResponse.json(
        {
          error: file.name.toLowerCase().endsWith(".xls")
            ? "Old .xls files are not supported. Re-save the sheet as .xlsx and upload it again."
            : "Please upload an XLSX or CSV file of expenses.",
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

    let result: ExpenseImport;
    if (kind === "xlsx") {
      // Every sheet is offered, so a whole balance sheet workbook is read from
      // its Expenses tab rather than failing on whichever tab comes first.
      result = pickExpenseSheet(await xlsxToGrids(buffer));
    } else {
      result = parseExpenseGrid(parseCsv(buffer.toString("utf8")), "CSV");
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
          error: `No expenses could be read from that file.${because}`,
          skipped: result.skipped.slice(0, 50),
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      sheetName: result.sheetName,
      fileName: file.name,
      rows: result.rows,
      // Capped so a wildly wrong file cannot return a response of thousands of
      // complaints.
      skipped: result.skipped.slice(0, 50),
      skippedTotal: result.skipped.length,
      found: result.found,
    });
  } catch (err) {
    console.error("expenses-import error:", err);
    return NextResponse.json(
      {
        error:
          "Could not read that file. It may be corrupted, password protected, or not a spreadsheet.",
      },
      { status: 500 },
    );
  }
}
