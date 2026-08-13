import ExcelJS from "exceljs";
import type { BagItem } from "./bagManifest";

/**
 * The spreadsheet version of a bag manifest.
 *
 * Layout is fixed so the Total formula is predictable:
 *
 *   row 1          the order number - the headline of the document
 *   row 2          Container Number: <number>
 *   row 3          Item Name | Quantity
 *   row 4 .. n+3   the items
 *   row n+4        Total     | =SUM(B4:B{n+3})
 *
 * The total is a live formula rather than a number. If someone adjusts a
 * quantity in the sheet, the total follows instead of silently disagreeing with
 * the rows above it.
 */

/**
 * First row holding data: the order number, container number and column header
 * occupy rows 1-3.
 */
export const DATA_START_ROW = 4;

export interface ManifestXlsxData {
  orderNumber: string;
  containerNumber: string;
  items: BagItem[];
}

/** The formula placed in the Total cell, e.g. "SUM(B4:B88)". */
export function totalFormula(itemCount: number): string {
  const first = DATA_START_ROW;
  const last = DATA_START_ROW + Math.max(itemCount, 1) - 1;
  return `SUM(B${first}:B${last})`;
}

export async function buildManifestXlsx(
  data: ManifestXlsxData,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Bag Manifest", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  sheet.columns = [
    { key: "name", width: 46 },
    { key: "qty", width: 14 },
  ];

  // Row 1 - the order number, as the headline
  sheet.mergeCells("A1:B1");
  const headingCell = sheet.getCell("A1");
  headingCell.value = data.orderNumber;
  headingCell.font = { bold: true, size: 16 };
  headingCell.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 26;

  // Row 2 - container number
  sheet.mergeCells("A2:B2");
  const containerCell = sheet.getCell("A2");
  containerCell.value = `Container Number: ${data.containerNumber}`;
  containerCell.font = { bold: true, size: 11 };
  containerCell.alignment = { vertical: "middle" };
  sheet.getRow(2).height = 18;

  // Row 3 - table header
  const header = sheet.getRow(3);
  header.values = ["Item Name", "Quantity"];
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle" };
  header.height = 18;
  for (const ref of ["A3", "B3"]) {
    sheet.getCell(ref).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F2937" },
    };
  }
  sheet.getCell("B3").alignment = { horizontal: "right", vertical: "middle" };

  // Rows 4.. - the items
  data.items.forEach((item, i) => {
    const row = sheet.getRow(DATA_START_ROW + i);
    row.getCell(1).value = item.name;
    const qty = row.getCell(2);
    qty.value = item.qty;
    qty.numFmt = "0";
    qty.alignment = { horizontal: "right" };
  });

  // Final row - Total, as a live SUM over the quantity column
  const totalRowNumber = DATA_START_ROW + data.items.length;
  const totalRow = sheet.getRow(totalRowNumber);
  totalRow.getCell(1).value = "Total";
  const totalCell = totalRow.getCell(2);
  totalCell.value = { formula: totalFormula(data.items.length) };
  totalCell.numFmt = "0";
  totalCell.alignment = { horizontal: "right" };
  totalRow.font = { bold: true };
  for (const col of [1, 2]) {
    totalRow.getCell(col).border = {
      top: { style: "thin", color: { argb: "FF4F46E5" } },
    };
    totalRow.getCell(col).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E7FF" },
    };
  }

  // Repeat the heading and header rows when printed across several pages.
  sheet.pageSetup.printTitlesRow = "1:3";

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
