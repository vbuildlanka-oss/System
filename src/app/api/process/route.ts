import { NextRequest, NextResponse } from "next/server";
import { parseOrderPdf } from "@/lib/parseOrder";
import { parseCsvOrder, parseXlsxOrder } from "@/lib/parseTabular";
import type { ParsedOrder } from "@/lib/types";

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

    let parsed: ParsedOrder;
    if (kind === "pdf") {
      parsed = await parseOrderPdf(buffer);
    } else if (kind === "csv") {
      parsed = parseCsvOrder(buffer.toString("utf8"), fallbackTitle);
    } else {
      parsed = await parseXlsxOrder(buffer, fallbackTitle);
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
    console.error("process error:", err);
    return NextResponse.json(
      {
        error:
          kind === "pdf" || kind === null
            ? "Failed to read the PDF. It may be scanned or corrupted."
            : "Failed to read that file. It may be corrupted or password protected.",
      },
      { status: 500 },
    );
  }
}
