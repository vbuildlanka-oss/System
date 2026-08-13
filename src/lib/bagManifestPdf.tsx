import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { BagItem } from "./bagManifest";

/**
 * The printable bag manifest: item names and bag counts only.
 *
 * Deliberately a separate document from the price list renderer. This one has
 * no money columns at all, so there is no code path that could put a price on a
 * manifest meant to be handed to a shipper or to customs.
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
  title: {
    fontSize: 21,
    fontFamily: "Helvetica-Bold",
    marginTop: 6,
  },
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

export interface ManifestPdfData {
  /** The headline of the document. */
  orderNumber: string;
  containerNumber: string;
  items: BagItem[];
  total: number;
  subtitle?: string;
}

function ManifestDocument({ data }: { data: ManifestPdfData }) {
  return (
    <Document
      author="BaleBook"
      creator="BaleBook"
      producer="BaleBook"
      title={data.orderNumber}
    >
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.brand}>BALEBOOK</Text>
          <Text style={styles.title}>{data.orderNumber}</Text>
          <Text style={styles.container}>
            Container Number: {data.containerNumber}
          </Text>
          {data.subtitle ? (
            <Text style={styles.subtitle}>{data.subtitle}</Text>
          ) : null}
        </View>

        <View style={styles.table}>
          <View style={styles.headRow} fixed>
            <Text style={[styles.headCell, styles.cName]}>Item Name</Text>
            <Text style={[styles.headCell, styles.cQty]}>Quantity</Text>
          </View>

          {data.items.map((item, i) => (
            <View
              key={`${item.name}-${i}`}
              style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row}
              wrap={false}
            >
              <Text style={[styles.cell, styles.cName]}>{item.name}</Text>
              <Text style={[styles.cell, styles.cQty]}>{item.qty}</Text>
            </View>
          ))}

          <View style={styles.totalRow} wrap={false}>
            <Text style={[styles.totalCell, styles.cName]}>Total</Text>
            <Text style={[styles.totalCell, styles.cQty]}>{data.total}</Text>
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

export async function renderManifestPdf(
  data: ManifestPdfData,
): Promise<Buffer> {
  return renderToBuffer(<ManifestDocument data={data} />);
}
