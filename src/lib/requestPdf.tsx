import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { RequestItem } from "./buyerRequest";
import { lineValue, suppliedValue } from "./buyerRequest";
import { displayPhone } from "./buyer";
import { formatLKR } from "./types";

/**
 * A buyer's request list as a printable document.
 *
 * Doubles as a picking list, which is why Outstanding is a column of its own:
 * it is the number someone actually works from when pulling bags. No prices
 * appear anywhere, in keeping with the rest of the bag paperwork.
 */

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 48,
    paddingHorizontal: 48,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: "#111827",
  },
  header: {
    marginBottom: 16,
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
  title: { fontSize: 19, fontFamily: "Helvetica-Bold", marginTop: 6 },
  meta: { fontSize: 10, color: "#374151", marginTop: 4 },
  notes: {
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: "#d1d5db",
    borderRadius: 3,
    backgroundColor: "#f9fafb",
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 9,
    color: "#374151",
  },
  table: { width: "100%" },
  headRow: {
    flexDirection: "row",
    backgroundColor: "#1f2937",
    color: "#ffffff",
  },
  headCell: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    paddingVertical: 7,
    paddingHorizontal: 6,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e5e7eb",
  },
  rowAlt: { backgroundColor: "#f5f6ff" },
  cell: { paddingVertical: 5, paddingHorizontal: 6 },
  note: { fontSize: 8, color: "#6b7280" },
  cName: { width: "32%" },
  cNum: { width: "11%", textAlign: "right" },
  cWide: { width: "13%", textAlign: "right" },
  cMoney: { width: "16%", textAlign: "right" },
  totalRow: {
    flexDirection: "row",
    backgroundColor: "#e0e7ff",
    borderTopWidth: 1.5,
    borderTopColor: "#4f46e5",
  },
  totalCell: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 48,
    right: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: "#d1d5db",
    paddingTop: 6,
    fontSize: 8,
    color: "#6b7280",
  },
});

export interface RequestPdfData {
  buyerName: string;
  buyerPhone: string;
  items: RequestItem[];
  notes?: string;
  /** Printed under the heading, usually the date. */
  subtitle?: string;
}

function totals(items: RequestItem[]) {
  let wanted = 0;
  let supplied = 0;
  let value = 0;
  let suppliedVal = 0;
  for (const item of items) {
    wanted += item.qty;
    supplied += Math.min(item.supplied, item.qty);
    value += lineValue(item);
    suppliedVal += suppliedValue(item);
  }
  return {
    wanted,
    supplied,
    outstanding: Math.max(0, wanted - supplied),
    value,
    suppliedValue: suppliedVal,
  };
}

function RequestDocument({ data }: { data: RequestPdfData }) {
  const heading = data.buyerName.trim() || "Buyer request";
  const phone = displayPhone(data.buyerPhone);
  const sum = totals(data.items);

  return (
    <Document
      author="BaleBook"
      creator="BaleBook"
      producer="BaleBook"
      title={`${heading} - Request`}
    >
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.brand}>BALEBOOK</Text>
          <Text style={styles.title}>{heading}</Text>
          <Text style={styles.meta}>
            Requested items
            {phone !== "" ? ` · ${phone}` : ""}
            {data.subtitle ? ` · ${data.subtitle}` : ""}
          </Text>
        </View>

        {data.notes && data.notes.trim() !== "" ? (
          <Text style={styles.notes}>{data.notes}</Text>
        ) : null}

        <View style={styles.table}>
          <View style={styles.headRow} fixed>
            <Text style={[styles.headCell, styles.cName]}>Item</Text>
            <Text style={[styles.headCell, styles.cNum]}>Wanted</Text>
            <Text style={[styles.headCell, styles.cNum]}>Supplied</Text>
            <Text style={[styles.headCell, styles.cWide]}>To go</Text>
            <Text style={[styles.headCell, styles.cMoney]}>Per Bag</Text>
            <Text style={[styles.headCell, styles.cMoney]}>Total</Text>
          </View>

          {data.items.map((item, i) => {
            const supplied = Math.min(item.supplied, item.qty);
            return (
              <View
                key={`${item.name}-${i}`}
                style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row}
                wrap={false}
              >
                <View style={[styles.cell, styles.cName]}>
                  <Text>{item.name}</Text>
                  {item.note ? (
                    <Text style={styles.note}>{item.note}</Text>
                  ) : null}
                </View>
                <Text style={[styles.cell, styles.cNum]}>{item.qty}</Text>
                <Text style={[styles.cell, styles.cNum]}>{supplied}</Text>
                <Text style={[styles.cell, styles.cWide]}>
                  {Math.max(0, item.qty - supplied)}
                </Text>
                <Text style={[styles.cell, styles.cMoney]}>
                  {item.perBag > 0 ? formatLKR(item.perBag) : "-"}
                </Text>
                <Text style={[styles.cell, styles.cMoney]}>
                  {item.perBag > 0 ? formatLKR(lineValue(item)) : "-"}
                </Text>
              </View>
            );
          })}

          <View style={styles.totalRow} wrap={false}>
            <Text style={[styles.totalCell, styles.cName]}>Total</Text>
            <Text style={[styles.totalCell, styles.cNum]}>{sum.wanted}</Text>
            <Text style={[styles.totalCell, styles.cNum]}>{sum.supplied}</Text>
            <Text style={[styles.totalCell, styles.cWide]}>
              {sum.outstanding}
            </Text>
            <Text style={[styles.totalCell, styles.cMoney]}> </Text>
            <Text style={[styles.totalCell, styles.cMoney]}>
              {formatLKR(sum.value)}
            </Text>
          </View>
        </View>

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

export async function renderRequestPdf(
  data: RequestPdfData,
): Promise<Buffer> {
  return renderToBuffer(<RequestDocument data={data} />);
}


