import { NextRequest, NextResponse } from "next/server";
import {
  findMonth,
  MAX_ROWS,
  missingNames,
  monthLabel,
  overDeductedNames,
  parsePayrollDoc,
  payrollFilename,
  payrollYearFilename,
  payslipFilename,
  payslipsFilename,
} from "@/lib/payroll";
import { buildPayrollXlsx, buildPayrollYearXlsx } from "@/lib/payrollXlsx";
import { renderPayslipPdf, renderPayslipsPdf } from "@/lib/payrollPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The four things payroll produces, from one route so the validation below
 * cannot drift between them:
 *
 *   month    - the monthly wage sheet as a workbook
 *   year     - twelve of those plus a summary, for the annual returns
 *   payslip  - one person's payslip, which is what gets handed over
 *   payslips - every payslip for a month in one file, for the office folder
 *
 * The document is rebuilt through parsePayrollDoc before anything is generated,
 * so a hand-edited payload cannot produce a payslip full of NaN, and both the
 * workbook and the PDF are built from that same rebuilt object.
 *
 * ExcelJS and the PDF renderer are both far too heavy to ship to a browser,
 * which is why this happens on the server at all.
 */
type Scope = "month" | "year" | "payslip" | "payslips";

export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as unknown;
    // A body of null, a number or a string would throw on a property read, and
    // a malformed request deserves a 400 rather than a 500.
    const body =
      raw !== null && typeof raw === "object"
        ? (raw as {
            doc?: unknown;
            scope?: unknown;
            monthId?: unknown;
            rowId?: unknown;
            year?: unknown;
          })
        : {};

    const doc = parsePayrollDoc(body.doc ?? raw);
    const scope: Scope =
      body.scope === "year"
        ? "year"
        : body.scope === "payslip"
          ? "payslip"
          : body.scope === "payslips"
            ? "payslips"
            : "month";

    if (doc.months.length === 0) {
      return NextResponse.json(
        { error: "There is no payroll to export yet. Open a month first." },
        { status: 400 },
      );
    }

    /* ------------------------------ the year ------------------------------ */
    if (scope === "year") {
      const year = String(body.year ?? "").trim();
      if (!/^\d{4}$/.test(year)) {
        return NextResponse.json(
          { error: "That is not a year." },
          { status: 400 },
        );
      }
      if (!doc.months.some((m) => m.month.startsWith(`${year}-`))) {
        return NextResponse.json(
          { error: `There is no payroll for ${year}.` },
          { status: 400 },
        );
      }
      const xlsx = await buildPayrollYearXlsx(doc, year);
      return new NextResponse(new Uint8Array(xlsx), {
        status: 200,
        headers: {
          "Content-Type": XLSX_TYPE,
          "Content-Disposition": `attachment; filename="${payrollYearFilename(year, "xlsx", doc.employer)}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    /* ----------------------------- one month ------------------------------ */
    const monthId = String(body.monthId ?? "");
    const month = findMonth(doc, monthId);
    if (!month) {
      return NextResponse.json(
        { error: "That month is not on the payroll." },
        { status: 400 },
      );
    }
    if (month.rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many people on one month (limit ${MAX_ROWS}).` },
        { status: 400 },
      );
    }

    if (scope === "month") {
      const xlsx = await buildPayrollXlsx(doc, monthId);
      return new NextResponse(new Uint8Array(xlsx), {
        status: 200,
        headers: {
          "Content-Type": XLSX_TYPE,
          "Content-Disposition": `attachment; filename="${payrollFilename(month.month, "xlsx", doc.employer)}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    /* ------------------------------ payslips ------------------------------ */
    if (month.rows.length === 0) {
      return NextResponse.json(
        {
          error: `There is nobody on the ${monthLabel(month.month)} payroll yet.`,
        },
        { status: 400 },
      );
    }
    // A payslip is a promise to pay. One that cannot be honoured - because the
    // deductions come to more than the wage - is not a document to hand over, so
    // it is refused rather than printed with a minus sign on it.
    const impossible = overDeductedNames(month, doc.fields, doc.rates);
    if (impossible.length > 0) {
      return NextResponse.json(
        {
          error:
            impossible.length === 1
              ? `${impossible[0]} has more deducted than earned, so that payslip would show a negative wage. Fix the deductions first.`
              : `${impossible.length} people have more deducted than earned, so those payslips would show a negative wage. Fix the deductions first.`,
        },
        { status: 400 },
      );
    }
    if (missingNames(month) > 0) {
      return NextResponse.json(
        {
          error:
            "Somebody on this month's payroll has no name, and a payslip has to be addressed to someone.",
        },
        { status: 400 },
      );
    }

    if (scope === "payslips") {
      const pdf = await renderPayslipsPdf(doc, monthId);
      return new NextResponse(new Uint8Array(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${payslipsFilename(month.month)}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const rowId = String(body.rowId ?? "");
    const row = month.rows.find((r) => r.id === rowId);
    if (!row) {
      return NextResponse.json(
        { error: "That person is not on this month's payroll." },
        { status: 400 },
      );
    }
    const pdf = await renderPayslipPdf(doc, monthId, rowId);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${payslipFilename(row.name, month.month)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("payroll-export error:", err);
    return NextResponse.json(
      { error: "Failed to build the file." },
      { status: 500 },
    );
  }
}
