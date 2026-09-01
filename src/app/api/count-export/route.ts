import { NextRequest, NextResponse } from "next/server";
import { countFilename, parseCountDoc, MAX_ROWS } from "@/lib/counter";
import { buildCountXlsx } from "@/lib/counterXlsx";
import { renderCountPdf } from "@/lib/counterPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn a warehouse count into a file.
 *
 * Both formats come from the same validated rows, so the spreadsheet and the PDF
 * for one count cannot disagree. Whatever arrives is put through parseCountDoc
 * first, so a corrupted payload cannot produce a count full of NaN.
 *
 * The PDF is the one that gets uploaded back into the price list, which is why its
 * layout is pinned down in counterPdf.tsx rather than left to taste.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as unknown;
    const body =
      raw !== null && typeof raw === "object"
        ? (raw as { doc?: unknown; format?: unknown })
        : {};
    const doc = parseCountDoc(body.doc ?? raw);
    const format = body.format === "pdf" ? "pdf" : "xlsx";

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

    if (format === "pdf") {
      // Nothing to print is not the same as nothing to record: a count where
      // every row was left untouched would produce a sheet of headings.
      if (!doc.rows.some((row) => row.touched)) {
        return NextResponse.json(
          { error: "Nothing has been counted yet, so the PDF would be empty." },
          { status: 400 },
        );
      }
      const pdf = await renderCountPdf(doc);
      return new NextResponse(new Uint8Array(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${countFilename(doc, "pdf")}"`,
          "Cache-Control": "no-store",
        },
      });
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
