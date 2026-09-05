"""
Generate a buyer-facing price list PDF from a supplier order PDF.

For every line item, a fixed markup (default Rs 2,000) is ADDED to the
"Per Bag" price, and the line Total and grand Total are recalculated.

This mirrors the layout of the original Sri Lanka Order sheets so the
output can be handed directly to a buyer.

Usage:
    python generate_buyer_pricelist.py "<source>.pdf" [markup]
"""
import sys
import re
import pdfplumber
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
)


def parse_money(text):
    """'Rs35,000.00' -> 35000.0"""
    return float(re.sub(r"[^\d.]", "", text))


def fmt_money(value):
    """35000.0 -> 'Rs35,000.00'"""
    return "Rs{:,.2f}".format(value)


def extract_items(pdf_path):
    """Return (title, [ {name, qty, per_bag} ])."""
    title = None
    items = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not row or len(row) < 4:
                        continue
                    name = (row[0] or "").strip()
                    qty_raw = (row[1] or "").strip()
                    per_raw = (row[2] or "").strip()

                    # Capture the sheet title (first non-empty single cell)
                    if name and not qty_raw and not per_raw and title is None:
                        title = name
                        continue

                    # Skip header row and total row
                    if name.lower() == "item name":
                        continue
                    if name.lower() == "total":
                        continue

                    # Valid data row: integer qty + a "Rs..." per-bag price
                    if qty_raw.isdigit() and per_raw.startswith("Rs"):
                        items.append({
                            "name": name,
                            "qty": int(qty_raw),
                            "per_bag": parse_money(per_raw),
                        })
    return title, items


def build_pdf(source_pdf, markup=2000.0):
    title, items = extract_items(source_pdf)
    buyer_title = (title or "Order") + " (Buyer Price List)"

    # Recalculate with markup
    rows = [["Item Name", "Quantity", "Per Bag", "Total"]]
    total_qty = 0
    grand_total = 0.0
    for it in items:
        new_per_bag = it["per_bag"] + markup
        line_total = it["qty"] * new_per_bag
        total_qty += it["qty"]
        grand_total += line_total
        rows.append([
            it["name"],
            str(it["qty"]),
            fmt_money(new_per_bag),
            fmt_money(line_total),
        ])
    rows.append(["Total", str(total_qty), "", fmt_money(grand_total)])

    out_path = source_pdf.rsplit(".pdf", 1)[0] + " - Buyer Price List.pdf"
    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        topMargin=18 * mm, bottomMargin=18 * mm,
        leftMargin=18 * mm, rightMargin=18 * mm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleX", parent=styles["Title"], fontSize=16, spaceAfter=4,
    )
    note_style = ParagraphStyle(
        "Note", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#666666"), spaceAfter=10,
    )

    elements = [
        Paragraph(buyer_title, title_style),
        Spacer(1, 4),
    ]

    table = Table(rows, colWidths=[85 * mm, 25 * mm, 32 * mm, 32 * mm],
                  repeatRows=1)
    style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (1, -1), "CENTER"),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2),
         [colors.white, colors.HexColor("#f3f4f6")]),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, colors.HexColor("#1f2937")),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#e5e7eb")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.75, colors.HexColor("#1f2937")),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ])
    table.setStyle(style)
    elements.append(table)

    doc.build(elements)
    return out_path, len(items), total_qty, grand_total


if __name__ == "__main__":
    args = sys.argv[1:]
    markup = 2000.0
    # allow last arg to be a number = markup
    if args and re.fullmatch(r"\d+(\.\d+)?", args[-1]):
        markup = float(args[-1])
        args = args[:-1]
    sources = args or [
        "Sri Lanka Order 3 2026 - Sheet1 (1).pdf",
        "Sri Lanka Order 4 2026 - Sheet1 (1).pdf",
    ]
    for src in sources:
        out, n, tq, gt = build_pdf(src, markup)
        print("Generated: {}".format(out))
        print("  items={}  total_bags={}  grand_total={}".format(
            n, tq, fmt_money(gt)))
