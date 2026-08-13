import { NextRequest, NextResponse } from "next/server";
import { LIMITS } from "@/lib/types";
import { sanitizeLine } from "@/lib/buyer";
import {
  manifestFilename,
  sumQty,
  toBagItems,
  type BagItem,
} from "@/lib/bagManifest";
import { checkContainerNumber } from "@/lib/container";
import { renderManifestPdf } from "@/lib/bagManifestPdf";
import { buildManifestXlsx } from "@/lib/bagManifestXlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ManifestBody {
  title?: unknown;
  containerNumber?: unknown;
  items?: unknown;
  format?: unknown;
  subtitle?: unknown;
}

/**
 * Turn a bag manifest into a file.
 *
 * Both formats are produced from the same normalised rows in this one place, so
 * the .xlsx and the .pdf for a given request cannot disagree. Quantities are
 * whole numbers of at least 1, and no price is accepted in the payload at all.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ManifestBody;

    const format = body.format === "xlsx" ? "xlsx" : "pdf";
    const title = sanitizeLine(body.title, LIMITS.title) || "Order";
    const subtitle = sanitizeLine(body.subtitle, LIMITS.subtitle) || undefined;

    // A manifest without its container number is not much use to a shipper, so
    // the format is enforced here as well as in the page.
    const container = checkContainerNumber(String(body.containerNumber ?? ""));
    if (!container.ok) {
      return NextResponse.json(
        { error: container.message ?? "A valid container number is required." },
        { status: 400 },
      );
    }

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

    const filename = manifestFilename(title, container.value, format);

    if (format === "xlsx") {
      const xlsx = await buildManifestXlsx({
        title,
        containerNumber: container.value,
        items,
      });
      return new NextResponse(new Uint8Array(xlsx), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const pdf = await renderManifestPdf({
      title,
      containerNumber: container.value,
      items,
      total: sumQty(items),
      subtitle,
    });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("bag-manifest error:", err);
    return NextResponse.json(
      { error: "Failed to generate the manifest." },
      { status: 500 },
    );
  }
}
