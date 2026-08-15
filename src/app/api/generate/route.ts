import { NextRequest, NextResponse } from "next/server";
import {
  buildBuyerPriceList,
  buyerPriceFilename,
  clampNumber,
  LIMITS,
  type OrderItem,
} from "@/lib/types";
import { renderBuyerPdf } from "@/lib/buyerPdf";
import { REF_NO_MAX, sanitizeBuyer, sanitizeLine } from "@/lib/buyer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GenerateBody {
  title?: unknown;
  markup?: unknown;
  items?: unknown;
  buyer?: unknown;
  refNo?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateBody;
    const title = sanitizeLine(body.title, LIMITS.title) || "Order";
    const items = Array.isArray(body.items) ? body.items : [];

    // Only a real number or a numeric string counts as a markup.
    //
    // This is deliberately strict. Number(null) is 0, so a missing or null
    // markup would otherwise sail through validation and silently produce a
    // price list at cost price - handing the buyer your buying price. Note
    // that JSON has no Infinity, so an infinite markup also arrives as null.
    const rawMarkup =
      typeof body.markup === "number"
        ? body.markup
        : typeof body.markup === "string" && body.markup.trim() !== ""
          ? Number(body.markup)
          : Number.NaN;

    if (!Number.isFinite(rawMarkup) || rawMarkup < 0) {
      return NextResponse.json(
        { error: "Invalid markup value." },
        { status: 400 },
      );
    }
    if (rawMarkup > LIMITS.markup) {
      return NextResponse.json(
        { error: "That markup is unrealistically large." },
        { status: 400 },
      );
    }
    if (items.length === 0) {
      return NextResponse.json(
        { error: "No items to generate." },
        { status: 400 },
      );
    }
    if (items.length > LIMITS.rows) {
      return NextResponse.json(
        { error: `Too many items (limit ${LIMITS.rows}).` },
        { status: 400 },
      );
    }

    // Recompute everything server-side so the PDF can never be tampered with,
    // clamping each figure so a corrupt row cannot poison the totals.
    const clean: OrderItem[] = items.map((raw) => {
      const it = (raw ?? {}) as Record<string, unknown>;
      return {
        name: sanitizeLine(it.name, LIMITS.itemName) || "Unnamed item",
        qty: clampNumber(it.qty, LIMITS.qty),
        perBag: clampNumber(it.perBag, LIMITS.money),
      };
    });

    const markup = rawMarkup;

    const priceList = buildBuyerPriceList({ title, items: clean }, markup);
    const pdf = await renderBuyerPdf(priceList, {
      buyer: sanitizeBuyer(body.buyer),
      refNo: sanitizeLine(body.refNo, REF_NO_MAX),
    });
    // Buffer -> Uint8Array so it satisfies BodyInit for the Web Response.
    const pdfBody = new Uint8Array(pdf);

    return new NextResponse(pdfBody, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${buyerPriceFilename(title)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("generate error:", err);
    return NextResponse.json(
      { error: "Failed to generate the PDF." },
      { status: 500 },
    );
  }
}
