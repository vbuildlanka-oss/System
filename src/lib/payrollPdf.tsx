import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import { formatLKR } from "./types";
import {
  monthLabel,
  rowFigures,
  type PayrollDoc,
  type PayrollField,
  type PayrollMonth,
  type PayrollRow,
} from "./payroll";

/**
 * A payslip.
 *
 * One person per page, and nothing on that page about anyone else. A payslip is
 * handed to the person it belongs to, so a second employee's wage appearing
 * anywhere on it - even in a total - would be a disclosure. The month's totals
 * live in the spreadsheet, which does not leave the office.
 *
 * The three contributions are printed on two sides of a line that the layout
 * makes plain. The employee's EPF sits under Deductions, because it comes off
 * the wage. The employer's EPF and the ETF sit in their own block below the net
 * pay, under a sentence saying they are the company's cost - the ETF in
 * particular may not lawfully be deducted from anybody's salary, and a payslip
 * that lists it beside a deduction invites exactly that mistake.
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
    borderBottomWidth: 2,
    borderBottomColor: "#4f46e5",
    paddingBottom: 8,
    marginBottom: 14,
  },
  brand: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#4f46e5",
    letterSpacing: 2,
  },
  title: { fontSize: 21, fontFamily: "Helvetica-Bold", marginTop: 4 },
  subtitle: { fontSize: 9, color: "#6b7280", marginTop: 3 },

  who: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: "#f5f6ff",
    borderWidth: 0.5,
    borderColor: "#c7d2fe",
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 16,
  },
  whoBlock: { flexDirection: "column" },
  whoLabel: { fontSize: 7.5, color: "#6b7280", letterSpacing: 1 },
  whoValue: { fontSize: 12, fontFamily: "Helvetica-Bold", marginTop: 2 },

  sectionTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: "#4f46e5",
    letterSpacing: 1.2,
    marginBottom: 5,
  },
  block: { marginBottom: 14 },

  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e5e7eb",
    paddingVertical: 4,
  },
  lineLabel: { width: "68%" },
  lineValue: { width: "32%", textAlign: "right" },

  subtotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#9ca3af",
    paddingTop: 4,
    marginTop: 2,
    fontFamily: "Helvetica-Bold",
  },

  net: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#e0e7ff",
    borderTopWidth: 1.5,
    borderTopColor: "#4f46e5",
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginTop: 4,
    marginBottom: 16,
  },
  netLabel: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  netValue: { fontSize: 16, fontFamily: "Helvetica-Bold" },

  employer: {
    borderWidth: 0.5,
    borderColor: "#e5e7eb",
    backgroundColor: "#fafafa",
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  employerNote: {
    fontSize: 7.5,
    color: "#6b7280",
    marginTop: 6,
    lineHeight: 1.4,
  },

  note: { fontSize: 8, color: "#6b7280", marginTop: 12, lineHeight: 1.4 },

  footer: {
    position: "absolute",
    bottom: 24,
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

function Line({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <View style={styles.line} wrap={false}>
      <Text style={[styles.lineLabel, muted ? { color: "#6b7280" } : {}]}>
        {label}
      </Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

function Subtotal({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.subtotal} wrap={false}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

/** The title of a payslip, which is also its window title. */
export function payslipTitle(row: PayrollRow, month: PayrollMonth): string {
  return `Payslip - ${row.name || "Employee"} - ${monthLabel(month.month)}`;
}

function PayslipPage({
  row,
  month,
  fields,
  doc,
}: {
  row: PayrollRow;
  month: PayrollMonth;
  fields: PayrollField[];
  doc: PayrollDoc;
}) {
  const figures = rowFigures(row, fields, doc.rates);
  const allowances = fields.filter((f) => f.kind === "allowance");
  const deductions = fields.filter((f) => f.kind === "deduction");

  // An added column is only worth a line if it has something in it. A payslip
  // listing "Transport 0.00" makes somebody wonder what they were owed.
  const used = (field: PayrollField) => (row.extras[field.id] ?? 0) > 0;

  return (
    <Page size="A4" style={styles.page} wrap>
      <View style={styles.header} fixed>
        <Text style={styles.brand}>BALEBOOK</Text>
        <Text style={styles.title}>{doc.employer || "Payslip"}</Text>
        <Text style={styles.subtitle}>
          {doc.employer ? "Payslip for " : "For "}
          {monthLabel(month.month)}
          {month.paidOn ? `  ·  Paid ${month.paidOn}` : ""}
        </Text>
      </View>

      <View style={styles.who}>
        <View style={styles.whoBlock}>
          <Text style={styles.whoLabel}>EMPLOYEE</Text>
          <Text style={styles.whoValue}>{row.name || "(unnamed)"}</Text>
        </View>
        <View style={[styles.whoBlock, { alignItems: "flex-end" }]}>
          <Text style={styles.whoLabel}>TIN</Text>
          <Text style={styles.whoValue}>{row.tin || "not recorded"}</Text>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.sectionTitle}>EARNINGS</Text>
        <Line label="Gross salary" value={formatLKR(row.gross)} />
        {allowances.filter(used).map((field) => (
          <Line
            key={field.id}
            label={field.label}
            value={formatLKR(row.extras[field.id] ?? 0)}
          />
        ))}
        <Subtotal label="Total earnings" value={formatLKR(figures.earnings)} />
      </View>

      <View style={styles.block}>
        <Text style={styles.sectionTitle}>DEDUCTIONS</Text>
        <Line
          label={`EPF employee contribution (${doc.rates.epfEmployee}%)`}
          value={formatLKR(figures.epfEmployee)}
        />
        {figures.otherDeductions > 0 && (
          <Line
            label="Other deductions"
            value={formatLKR(figures.otherDeductions)}
          />
        )}
        {deductions.filter(used).map((field) => (
          <Line
            key={field.id}
            label={field.label}
            value={formatLKR(row.extras[field.id] ?? 0)}
          />
        ))}
        <Subtotal
          label="Total deductions"
          value={formatLKR(figures.totalDeductions)}
        />
      </View>

      <View style={styles.net} wrap={false}>
        <Text style={styles.netLabel}>Net salary</Text>
        <Text style={styles.netValue}>{formatLKR(figures.net)}</Text>
      </View>

      <View style={styles.employer} wrap={false}>
        <Text style={styles.sectionTitle}>
          PAID BY THE COMPANY ON YOUR BEHALF
        </Text>
        <Line
          label={`EPF employer contribution (${doc.rates.epfEmployer}%)`}
          value={formatLKR(figures.epfEmployer)}
          muted
        />
        <Line
          label={`ETF employer contribution (${doc.rates.etf}%)`}
          value={formatLKR(figures.etf)}
          muted
        />
        <Text style={styles.employerNote}>
          These two are paid by the company in addition to your salary. They are
          not deducted from your pay and are not part of the net figure above.
          Your own EPF contribution of {formatLKR(figures.epfEmployee)} is the
          one shown under deductions. Together, {formatLKR(figures.epfEmployee)}{" "}
          and {formatLKR(figures.epfEmployer)} go to your EPF account.
        </Text>
      </View>

      {row.note !== "" && <Text style={styles.note}>Note: {row.note}</Text>}

      <View style={styles.footer} fixed>
        <Text>BaleBook</Text>
        <Text
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages}`
          }
        />
      </View>
    </Page>
  );
}

/** One person's payslip. */
export async function renderPayslipPdf(
  doc: PayrollDoc,
  monthId: string,
  rowId: string,
): Promise<Buffer> {
  const month = doc.months.find((m) => m.id === monthId);
  if (!month) throw new Error("That month is not on the payroll.");
  const row = month.rows.find((r) => r.id === rowId);
  if (!row) throw new Error("That person is not on this month's payroll.");

  return renderToBuffer(
    <Document
      author="BaleBook"
      creator="BaleBook"
      producer="BaleBook"
      title={payslipTitle(row, month)}
    >
      <PayslipPage row={row} month={month} fields={doc.fields} doc={doc} />
    </Document>,
  );
}

/**
 * Every payslip for a month, one per page - the office copy.
 *
 * Deliberately a separate function from the single payslip rather than a mode of
 * it, because the two have different rules about who may see them. This file has
 * everybody's pay in it and is for the folder, not for handing out; the single
 * payslip is the one that goes to a person.
 */
export async function renderPayslipsPdf(
  doc: PayrollDoc,
  monthId: string,
): Promise<Buffer> {
  const month = doc.months.find((m) => m.id === monthId);
  if (!month) throw new Error("That month is not on the payroll.");
  if (month.rows.length === 0) {
    throw new Error("There is nobody on this month's payroll.");
  }

  return renderToBuffer(
    <Document
      author="BaleBook"
      creator="BaleBook"
      producer="BaleBook"
      title={`Payslips - ${monthLabel(month.month)}`}
    >
      {month.rows.map((row) => (
        <PayslipPage
          key={row.id}
          row={row}
          month={month}
          fields={doc.fields}
          doc={doc}
        />
      ))}
    </Document>,
  );
}
