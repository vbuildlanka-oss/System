import { NextRequest, NextResponse } from "next/server";
import { LIMITS } from "@/lib/types";
import { sanitizeLine } from "@/lib/buyer";
import { toBagItems, sumQty, type BagItem } from "@/lib/bagList";
import { renderBagListPdf } from "@/lib/bagListPdf";
import { buildBagListXlsx } from "@/lib/bagListXlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BagListBody {
  title?: unknown;
  items?: unknown;
  format?: unknown;
  subtitle?: unknown;
}

function safeFilename(title: string, ext: string): string {
  const base = title.replace(/[^\w\d\- ]+/g, "").trim() || "Order";
  return `${base} - Bag List.${ext}`;
}

/**
 * Turn a bag list into a file.
 *
 * Both formats are produced from the same normalised rows in this one place, so
 * the .xlsx and the .pdf for a given request cannot disagree. Quantities are
 * whole numbers of at least 1, and no price is accepted in the payload at all.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BagListBody;

    const format = body.format === "xlsx" ? "xlsx" : "pdf";
    const title = sanitizeLine(body.title, LIMITS.title) || "Order";
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

    const items: BagItem[] = toBagItems(
      body.items as Array<{ name?: unknown; qty?: unknown }>,
    );
    if (items.length === 0) {
      return NextResponse.json(
        { error: "None of the items had a usable name." },
        { status: 400 },
      );
    }

    if (format === "xlsx") {
      const xlsx = await buildBagListXlsx({ title, items });
      return new NextResponse(new Uint8Array(xlsx), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${safeFilename(title, "xlsx")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const pdf = await renderBagListPdf({
      title,
      items,
      total: sumQty(items),
      subtitle,
    });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeFilename(title, "pdf")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("bag-list error:", err);
    return NextResponse.json(
      { error: "Failed to generate the bag list." },
      { status: 500 },
    );
  }
}
