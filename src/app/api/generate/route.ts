import { NextRequest, NextResponse } from "next/server";
import { buildBuyerPriceList, type OrderItem } from "@/lib/types";
import { renderBuyerPdf } from "@/lib/buyerPdf";
import { REF_NO_MAX, sanitizeBuyer, sanitizeLine } from "@/lib/buyer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GenerateBody {
  title?: string;
  markup?: number;
  items?: OrderItem[];
  buyer?: unknown;
  refNo?: unknown;
}

function safeFilename(title: string): string {
  const base = title.replace(/[^\w\d\- ]+/g, "").trim() || "Order";
  return `${base} - Buyer Price List.pdf`;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateBody;
    const title = (body.title || "Order").toString();
    const markup = Number(body.markup);
    const items = Array.isArray(body.items) ? body.items : [];

    if (!Number.isFinite(markup) || markup < 0) {
      return NextResponse.json(
        { error: "Invalid markup value." },
        { status: 400 },
      );
    }
    if (items.length === 0) {
      return NextResponse.json(
        { error: "No items to generate." },
        { status: 400 },
      );
    }

    // Recompute everything server-side so the PDF can never be tampered with.
    const clean: OrderItem[] = items.map((it) => ({
      name: String(it.name),
      qty: Number(it.qty),
      perBag: Number(it.perBag),
    }));

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
        "Content-Disposition": `attachment; filename="${safeFilename(title)}"`,
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
