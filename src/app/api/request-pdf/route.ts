import { NextRequest, NextResponse } from "next/server";
import { LIMITS } from "@/lib/types";
import { sanitizeLine, BUYER_PHONE_MAX } from "@/lib/buyer";

import { requestPdfFilename, toRequestItems } from "@/lib/buyerRequest";
import { renderRequestPdf } from "@/lib/requestPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  buyerName?: unknown;
  buyerPhone?: unknown;
  items?: unknown;
  notes?: unknown;
  subtitle?: unknown;
}

/**
 * Turn a buyer's request list into a printable PDF.
 *
 * Rebuilt from the payload here rather than trusted: quantities are whole and
 * at least one, supplied can never exceed what was asked for, and no price is
 * accepted at all.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;

    const buyerName = sanitizeLine(body.buyerName, LIMITS.title);
    const buyerPhone = sanitizeLine(body.buyerPhone, BUYER_PHONE_MAX);
    const notes = sanitizeLine(body.notes, LIMITS.subtitle);
    const subtitle = sanitizeLine(body.subtitle, LIMITS.subtitle) || undefined;

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: "There are no items to export." },
        { status: 400 },
      );
    }
    if (body.items.length > LIMITS.rows) {
      return NextResponse.json(
        { error: `Too many items (limit ${LIMITS.rows}).` },
        { status: 400 },
      );
    }

    const items = toRequestItems(
      body.items as Array<{
        name?: unknown;
        qty?: unknown;
        supplied?: unknown;
        note?: unknown;
      }>,
    );
    if (items.length === 0) {
      return NextResponse.json(
        { error: "None of the items had a usable name." },
        { status: 400 },
      );
    }

    const pdf = await renderRequestPdf({
      buyerName,
      buyerPhone,
      items,
      notes,
      subtitle,
    });

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${requestPdfFilename(buyerName)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("request-pdf error:", err);
    return NextResponse.json(
      { error: "Failed to generate the PDF." },
      { status: 500 },
    );
  }
}
