import { NextRequest, NextResponse } from "next/server";
import { parseOrderText, PdfReadError, readPdfText } from "@/lib/parseOrder";
import {
  parseCsv,
  parseCsvOrder,
  parseXlsxOrder,
  xlsxToGrids,
} from "@/lib/parseTabular";
import {
  recogniseCsv,
  recogniseGrids,
  recognisePdf,
  type Recognised,
} from "@/lib/restore";
import { wrongPageMessage } from "@/lib/restoreTypes";
import type { OrderItem, ParsedOrder } from "@/lib/types";

/** The same order with its lines replaced, and its totals worked out again. */
function withItems(parsed: ParsedOrder, items: OrderItem[]): ParsedOrder {
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const computedTotal = items.reduce((s, i) => s + i.qty * i.perBag, 0);
  return {
    ...parsed,
    items,
    totalQty,
    computedTotal,
    printedTotal: null,
    totalsMatch: true,
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

type Kind = "pdf" | "csv" | "xlsx";

/** Decide how to read the upload from its extension. */
function kindOf(filename: string): Kind | null {
  const name = filename.toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".xlsx")) return "xlsx";
  return null;
}

/** Drop the extension so the file name can stand in as a sheet title. */
function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").trim();
}

export async function POST(req: NextRequest) {
  let kind: Kind | null = null;
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    kind = kindOf(file.name);
    if (!kind) {
      // .xls is called out separately because the old binary format needs a
      // different reader; re-saving as .xlsx is the simplest fix.
      const isOldExcel = file.name.toLowerCase().endsWith(".xls");
      return NextResponse.json(
        {
          error: isOldExcel
            ? "Old .xls files are not supported. Re-save the sheet as .xlsx or upload a PDF."
            : "Please upload a PDF, CSV or XLSX file.",
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
    const fallbackTitle = titleFromFilename(file.name);

    // Which page sent it, so a file of ours that belongs elsewhere can be named
    // rather than rejected as unreadable.
    const page = typeof form.get("for") === "string" ? String(form.get("for")) : "";

    let parsed: ParsedOrder;
    let recognised: Recognised | null = null;
    if (kind === "pdf") {
      const pdf = await readPdfText(buffer);
      parsed = parseOrderText(pdf);
      recognised = recognisePdf(pdf, parsed);
    } else if (kind === "csv") {
      const text = buffer.toString("utf8");
      parsed = parseCsvOrder(text, fallbackTitle);
      recognised = recogniseCsv(parseCsv(text));
    } else {
      parsed = await parseXlsxOrder(buffer, fallbackTitle);
      recognised = recogniseGrids(await xlsxToGrids(buffer));
    }

    // A file this app generated. Supplier files never get here, so the order
    // reading above is exactly what it always was for them.
    if (recognised) {
      if (recognised.items) parsed = withItems(parsed, recognised.items);
      if (parsed.items.length === 0) {
        const elsewhere = page ? wrongPageMessage(recognised.restore, page) : "";
        if (elsewhere) {
          return NextResponse.json({ error: elsewhere }, { status: 422 });
        }
      }
      return NextResponse.json({ ...parsed, restore: recognised.restore });
    }

    if (parsed.items.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not read any items from this file. Make sure it is an order sheet with Item Name and Quantity columns.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json(parsed);
  } catch (err) {
    // Log the real thing. "It may be corrupted" told the user nothing and told
    // us nothing either, so a recurring failure left no trace to work from.
    console.error("process error:", { kind, err });

    // A PDF we could not read knows why, and what it says is worth showing:
    // a half-downloaded file and a scan need different things done about them.
    if (err instanceof PdfReadError) {
      return NextResponse.json(
        { error: err.userMessage },
        { status: err.failure === "unreadable" ? 422 : 400 },
      );
    }

    if (kind === null) {
      // We never got as far as looking at the file, so this is not about its
      // contents - claiming it was corrupt sent people off re-saving a file
      // that was fine.
      return NextResponse.json(
        { error: "The upload did not arrive in one piece. Please try again." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error:
          kind === "pdf"
            ? "Failed to read that PDF."
            : "Failed to read that file. It may be corrupted or password protected.",
      },
      { status: 500 },
    );
  }
}
