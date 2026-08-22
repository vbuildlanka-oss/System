import { NextRequest, NextResponse } from "next/server";
import { countFilename, parseCountDoc, MAX_ROWS } from "@/lib/counter";
import { buildCountXlsx } from "@/lib/counterXlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn a warehouse count into a spreadsheet.
 *
 * Whatever arrives is put through parseCountDoc first, so the sheet is built from
 * the same validated rows the page works with, and a corrupted payload cannot
 * produce a count full of NaN.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as unknown;
    const body =
      raw !== null && typeof raw === "object" ? (raw as { doc?: unknown }) : {};
    const doc = parseCountDoc(body.doc ?? raw);

    if (doc.rows.length === 0) {
      return NextResponse.json(
        { error: "There is nothing to export. Upload a list or add an item." },
        { status: 400 },
      );
    }
    if (doc.rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many items (limit ${MAX_ROWS}).` },
        { status: 400 },
      );
    }

    const xlsx = await buildCountXlsx(doc);
    return new NextResponse(new Uint8Array(xlsx), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${countFilename(doc)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("count-export error:", err);
    return NextResponse.json(
      { error: "Failed to build the spreadsheet." },
      { status: 500 },
    );
  }
}
