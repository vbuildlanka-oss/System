import { NextRequest, NextResponse } from "next/server";
import { parseCalcDoc, MAX_ROWS } from "@/lib/calculation";
import { buildCalculationXlsx } from "@/lib/calculationXlsx";
import { documentFilename } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn a markup calculation into a spreadsheet.
 *
 * This is the only route that will ever produce a file containing what a bag
 * costs and what is made on it. Nothing else in the app builds one, and nothing
 * else imports the calculation, so the figures cannot reach a buyer's price list,
 * a manifest, a request or the balance sheet by accident.
 *
 * The file is named so that a wrong attachment is caught by eye: the word
 * INTERNAL is in the file name itself, not only inside the sheet.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as unknown;
    const body =
      raw !== null && typeof raw === "object"
        ? (raw as { doc?: unknown })
        : {};
    const doc = parseCalcDoc(body.doc ?? raw);

    if (doc.rows.length === 0) {
      return NextResponse.json(
        { error: "There is nothing to calculate yet. Upload a file first." },
        { status: 400 },
      );
    }
    if (doc.rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many items (limit ${MAX_ROWS}).` },
        { status: 400 },
      );
    }

    const xlsx = await buildCalculationXlsx(doc);
    const filename = documentFilename(
      doc.orderNumber,
      "Markup Calculation INTERNAL",
      "xlsx",
    );

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
    console.error("calculation-export error:", err);
    return NextResponse.json(
      { error: "Failed to build the spreadsheet." },
      { status: 500 },
    );
  }
}
