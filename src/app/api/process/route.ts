import { NextRequest, NextResponse } from "next/server";
import { parseOrderPdf } from "@/lib/parseOrder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file uploaded." },
        { status: 400 },
      );
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        { error: "Please upload a PDF file." },
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
    const parsed = await parseOrderPdf(buffer);

    if (parsed.items.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not read any items from this PDF. Make sure it's an order sheet with Item / Quantity / Per Bag / Total columns.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error("process error:", err);
    return NextResponse.json(
      { error: "Failed to read the PDF. It may be scanned or corrupted." },
      { status: 500 },
    );
  }
}
