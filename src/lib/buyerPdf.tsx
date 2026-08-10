import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { BuyerPriceList } from "./types";
import { formatLKR } from "./types";
import { displayPhone, type Buyer } from "./buyer";

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 48,
    paddingHorizontal: 42,
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
  title: {
    fontSize: 17,
    fontFamily: "Helvetica-Bold",
    marginTop: 6,
    color: "#111827",
  },
  subtitle: {
    fontSize: 9,
    marginTop: 4,
    color: "#6b7280",
  },
  meta: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14,
    borderWidth: 0.5,
    borderColor: "#d1d5db",
    borderRadius: 3,
    backgroundColor: "#f9fafb",
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  metaBlock: { maxWidth: "62%" },
  metaBlockRight: { maxWidth: "36%", alignItems: "flex-end" },
  metaLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    color: "#6b7280",
    marginBottom: 3,
  },
  metaValue: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: "#111827",
  },
  metaSub: {
    fontSize: 9,
    color: "#374151",
    marginTop: 2,
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
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e5e7eb",
  },
  rowAlt: { backgroundColor: "#f5f6ff" },
  cell: { paddingVertical: 4.5, paddingHorizontal: 6 },
  cName: { width: "46%" },
  cQty: { width: "14%", textAlign: "center" },
  cPer: { width: "20%", textAlign: "right" },
  cTotal: { width: "20%", textAlign: "right" },
  totalRow: {
    flexDirection: "row",
    backgroundColor: "#e0e7ff",
    borderTopWidth: 1.5,
    borderTopColor: "#4f46e5",
  },
  totalCell: {
    fontFamily: "Helvetica-Bold",
    paddingVertical: 7,
    paddingHorizontal: 6,
    fontSize: 10,
  },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 42,
    right: 42,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: "#d1d5db",
    paddingTop: 6,
    fontSize: 8,
    color: "#6b7280",
  },
});

export interface SheetPdfOptions {
  /**
   * Text shown in parentheses after the sheet title, e.g. "Buyer Price List".
   * Pass an empty string to print the title on its own.
   */
  label?: string;
  /** Optional small line under the title, e.g. a date or note. */
  subtitle?: string;
  /** Optional buyer the document is addressed to. */
  buyer?: Buyer;
  /** Optional document reference, e.g. "BB-260809-001". */
  refNo?: string;
}

function BuyerDocument({
  data,
  options,
}: {
  data: BuyerPriceList;
  options?: SheetPdfOptions;
}) {
  const label = options?.label ?? "Buyer Price List";
  const heading = label ? `${data.title} (${label})` : data.title;

  const buyerName = (options?.buyer?.name ?? "").trim();
  const buyerPhone = displayPhone(options?.buyer?.phone ?? "");
  const refNo = (options?.refNo ?? "").trim();
  const showMeta = buyerName !== "" || buyerPhone !== "" || refNo !== "";

  return (
    <Document
      author="Lathurshan"
      creator="BaleBook"
      producer="BaleBook"
      title={heading}
    >
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.brand}>BALEBOOK</Text>
          <Text style={styles.title}>{heading}</Text>
          {options?.subtitle ? (
            <Text style={styles.subtitle}>{options.subtitle}</Text>
          ) : null}
        </View>

        {showMeta ? (
          <View style={styles.meta}>
            <View style={styles.metaBlock}>
              {buyerName !== "" || buyerPhone !== "" ? (
                <>
                  <Text style={styles.metaLabel}>PREPARED FOR</Text>
                  {buyerName !== "" ? (
                    <Text style={styles.metaValue}>{buyerName}</Text>
                  ) : null}
                  {buyerPhone !== "" ? (
                    <Text style={styles.metaSub}>{buyerPhone}</Text>
                  ) : null}
                </>
              ) : null}
            </View>
            {refNo !== "" ? (
              <View style={styles.metaBlockRight}>
                <Text style={styles.metaLabel}>REFERENCE</Text>
                <Text style={styles.metaValue}>{refNo}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.table}>
          <View style={styles.headRow} fixed>
            <Text style={[styles.headCell, styles.cName]}>Item Name</Text>
            <Text style={[styles.headCell, styles.cQty]}>Quantity</Text>
            <Text style={[styles.headCell, styles.cPer]}>Per Bag</Text>
            <Text style={[styles.headCell, styles.cTotal]}>Total</Text>
          </View>

          {data.rows.map((r, i) => (
            <View
              key={`${r.name}-${i}`}
              style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row}
              wrap={false}
            >
              <Text style={[styles.cell, styles.cName]}>{r.name}</Text>
              <Text style={[styles.cell, styles.cQty]}>{r.qty}</Text>
              <Text style={[styles.cell, styles.cPer]}>
                {formatLKR(r.perBag)}
              </Text>
              <Text style={[styles.cell, styles.cTotal]}>
                {formatLKR(r.total)}
              </Text>
            </View>
          ))}

          <View style={styles.totalRow} wrap={false}>
            <Text style={[styles.totalCell, styles.cName]}>Total</Text>
            <Text style={[styles.totalCell, styles.cQty]}>{data.totalQty}</Text>
            <Text style={[styles.totalCell, styles.cPer]}> </Text>
            <Text style={[styles.totalCell, styles.cTotal]}>
              {formatLKR(data.grandTotal)}
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

/** Render any sheet (price list, updated stock sheet, sales receipt). */
export async function renderSheetPdf(
  data: BuyerPriceList,
  options?: SheetPdfOptions,
): Promise<Buffer> {
  return renderToBuffer(<BuyerDocument data={data} options={options} />);
}

/** Helper used by the buyer price list route. */
export async function renderBuyerPdf(
  data: BuyerPriceList,
  options?: Omit<SheetPdfOptions, "label">,
): Promise<Buffer> {
  return renderSheetPdf(data, { ...options, label: "Buyer Price List" });
}
