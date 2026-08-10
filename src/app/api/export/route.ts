import { NextRequest, NextResponse } from "next/server";
import {
  buildSheetFromRows,
  clampNumber,
  LIMITS,
  type EditableRow,
} from "@/lib/types";
import { renderSheetPdf } from "@/lib/buyerPdf";
import { REF_NO_MAX, sanitizeBuyer, sanitizeLine } from "@/lib/buyer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingRow {
  id?: unknown;
  name?: unknown;
  qty?: unknown;
  perBag?: unknown;
  totalOverride?: unknown;
}

interface ExportBody {
  title?: unknown;
  label?: unknown;
  subtitle?: unknown;
  rows?: unknown;
  buyer?: unknown;
  refNo?: unknown;
}

function safeFilename(title: string, label: string): string {
  const base = title.replace(/[^\w\d\- ]+/g, "").trim() || "Order";
  const suffix = label.replace(/[^\w\d\- ]+/g, "").trim();
  return suffix ? `${base} - ${suffix}.pdf` : `${base}.pdf`;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ExportBody;

    const title = sanitizeLine(body.title, LIMITS.title) || "Order";
    const label =
      body.label === undefined
        ? "Updated"
        : sanitizeLine(body.label, LIMITS.label);
    const subtitle =
      body.subtitle === undefined
        ? undefined
        : sanitizeLine(body.subtitle, LIMITS.subtitle);

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return NextResponse.json(
        { error: "There are no rows to export." },
        { status: 400 },
      );
    }
    if (body.rows.length > LIMITS.rows) {
      return NextResponse.json(
        { error: `Too many rows (limit ${LIMITS.rows}).` },
        { status: 400 },
      );
    }

    // Rebuild every row server-side. Totals are recomputed from qty * perBag
    // unless the client explicitly supplied an override, which we keep as-is.
    const rows: EditableRow[] = (body.rows as unknown[]).map((raw, i) => {
      // A null or non-object entry must not take the whole request down.
      const r = (raw ?? {}) as IncomingRow;
      const rawOverride = r.totalOverride;
      const hasOverride =
        rawOverride !== null &&
        rawOverride !== undefined &&
        rawOverride !== "" &&
        Number.isFinite(Number(rawOverride));
      return {
        id: String(r.id ?? i),
        name: sanitizeLine(r.name, LIMITS.itemName) || "Unnamed item",
        qty: clampNumber(r.qty, LIMITS.qty),
        perBag: clampNumber(r.perBag, LIMITS.money),
        totalOverride: hasOverride
          ? clampNumber(rawOverride, LIMITS.money)
          : null,
      };
    });

    const sheet = buildSheetFromRows(title, rows);
    const pdf = await renderSheetPdf(sheet, {
      label,
      subtitle,
      buyer: sanitizeBuyer(body.buyer),
      refNo: sanitizeLine(body.refNo, REF_NO_MAX),
    });
    // Buffer -> Uint8Array so it satisfies BodyInit for the Web Response.
    const pdfBody = new Uint8Array(pdf);

    return new NextResponse(pdfBody, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeFilename(title, label)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("export error:", err);
    return NextResponse.json(
      { error: "Failed to generate the PDF." },
      { status: 500 },
    );
  }
}
