import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import { countTotals, type CountDoc } from "./counter";

/**
 * The printable warehouse count: the item, and how many were counted.
 *
 * This document is not only for reading. It gets uploaded back into the price
 * list, so its layout is a contract with `parseOrder.ts` rather than a design
 * choice. Four rules follow from how that parser reads a list with no prices,
 * and breaking any of them silently corrupts a count:
 *
 *   Every line that ends in digits is treated as an item, with those digits as
 *   the quantity. So no heading, stamp or note may end in a digit. The title ends
 *   in "Bag count" and the note ends in a full stop for exactly this reason.
 *
 *   A line containing a colon is ignored, which is why the container is printed
 *   as "Container Number: ..." and the time as "Counted ... 21:33". That also
 *   holds when the container is a warehouse bay rather than a code.
 *
 *   The total must read "Total <bags>" on its own. The parser uses it to settle
 *   ambiguous rows: "Anorak 29" is either "Anorak 2" with 9 bags or "Anorak" with
 *   29, and it picks the reading that makes the list add up. Without the total,
 *   every item whose name ends in a digit is a coin toss - and "Anorak 2",
 *   "Anorak #2" and "Blanket 3" are all real items on these lists.
 *
 *   Items nobody counted are left off. A row with no number would be read as an
 *   item with no quantity and dropped anyway, and printing "0" would claim a
 *   count that was never taken. How many were missed is stated in the note
 *   instead, where it cannot be mistaken for data.
 *
 * There are no prices on it. A count row has no price field to print.
 */

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 48,
    paddingHorizontal: 56,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#111827",
  },
  header: {
    marginBottom: 18,
    borderBottomWidth: 2,
    borderBottomColor: "#4f46e5",
    paddingBottom: 10,
  },
  brand: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#4f46e5",
    letterSpacing: 2,
  },
  title: { fontSize: 21, fontFamily: "Helvetica-Bold", marginTop: 6 },
  container: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    marginTop: 5,
    color: "#374151",
  },
  subtitle: { fontSize: 9, marginTop: 4, color: "#6b7280" },
  table: { width: "100%" },
  headRow: {
    flexDirection: "row",
    backgroundColor: "#1f2937",
    color: "#ffffff",
  },
  headCell: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    paddingVertical: 7,
    paddingHorizontal: 8,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e5e7eb",
  },
  rowAlt: { backgroundColor: "#f5f6ff" },
  cell: { paddingVertical: 5, paddingHorizontal: 8 },
  cName: { width: "75%" },
  cQty: { width: "25%", textAlign: "right" },
  totalRow: {
    flexDirection: "row",
    backgroundColor: "#e0e7ff",
    borderTopWidth: 1.5,
    borderTopColor: "#4f46e5",
  },
  totalCell: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  note: { marginTop: 14, fontSize: 8, color: "#6b7280", lineHeight: 1.4 },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 56,
    right: 56,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: "#d1d5db",
    paddingTop: 6,
    fontSize: 8,
    color: "#6b7280",
  },
});

/** The heading, which must not end in a digit. */
export function countPdfTitle(doc: CountDoc): string {
  const stem = [doc.orderNumber, doc.containerId]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" - ");
  return stem === "" ? "Bag count" : `${stem} - Bag count`;
}

function CountDocument({ doc }: { doc: CountDoc }) {
  const totals = countTotals(doc);
  // Only what was actually counted. See the note at the top of this file.
  const rows = doc.rows.filter((row) => row.touched);
  const missed = doc.rows.length - rows.length;

  // Ends with a colon-bearing time, so the parser treats it as furniture.
  const stamp = `Counted ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  return (
    <Document
      author="BaleBook"
      creator="BaleBook"
      producer="BaleBook"
      title={countPdfTitle(doc)}
    >
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.brand}>BALEBOOK</Text>
          <Text style={styles.title}>{countPdfTitle(doc)}</Text>
          {doc.containerId.trim() !== "" ? (
            <Text style={styles.container}>
              Container Number: {doc.containerId.trim()}
            </Text>
          ) : null}
          <Text style={styles.subtitle}>{stamp}</Text>
        </View>

        <View style={styles.table}>
          <View style={styles.headRow} fixed>
            <Text style={[styles.headCell, styles.cName]}>Item</Text>
            <Text style={[styles.headCell, styles.cQty]}>Count</Text>
          </View>

          {rows.map((row, i) => (
            <View
              key={row.id}
              style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row}
              wrap={false}
            >
              <Text style={[styles.cell, styles.cName]}>{row.name}</Text>
              <Text style={[styles.cell, styles.cQty]}>{row.counted}</Text>
            </View>
          ))}

          <View style={styles.totalRow} wrap={false}>
            <Text style={[styles.totalCell, styles.cName]}>Total</Text>
            <Text style={[styles.totalCell, styles.cQty]}>{totals.counted}</Text>
          </View>
        </View>

        <Text style={styles.note}>
          {missed > 0
            ? `Counted in the warehouse. ${missed} of the ${doc.rows.length} items on the list were never counted and are left off this sheet.`
            : "Counted in the warehouse. Every item on the list was counted."}
        </Text>

        <View style={styles.footer} fixed>
          <Text>BaleBook</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

export async function renderCountPdf(doc: CountDoc): Promise<Buffer> {
  return renderToBuffer(<CountDocument doc={doc} />);
}
