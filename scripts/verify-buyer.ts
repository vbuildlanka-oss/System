/**
 * Verifies buyer handling:
 *  - phone validation / normalisation across many real-world formats
 *  - input sanitisation (control characters, over-long pastes)
 *  - the PREPARED FOR / REFERENCE block on generated PDFs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import {
  checkPhone,
  displayPhone,
  whatsappLink,
  buyerIdentityKey,
  sanitizeBuyer,
  sanitizeLine,
  hasBuyerInfo,
  BUYER_NAME_MAX,
} from "../src/lib/buyer";
import { buildSheetFromRows } from "../src/lib/types";
import { renderSheetPdf } from "../src/lib/buyerPdf";

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log("  ok   -", msg);
  } else {
    console.error("  FAIL -", msg);
    failures += 1;
  }
}

console.log("\n== Phone validation ==");
const phoneCases: Array<[string, boolean, string | null, string]> = [
  // input, expected ok, expected e164, note
  ["0771234567", true, "+94771234567", "LK mobile with leading 0"],
  ["077 123 4567", true, "+94771234567", "LK mobile with spaces"],
  ["077-123-4567", true, "+94771234567", "LK mobile with dashes"],
  ["+94771234567", true, "+94771234567", "LK mobile in E.164"],
  ["+94 77 123 4567", true, "+94771234567", "LK mobile E.164 spaced"],
  ["94771234567", true, "+94771234567", "LK mobile with country code, no plus"],
  ["771234567", true, "+94771234567", "LK mobile without trunk 0"],
  ["0112345678", true, "+94112345678", "LK landline (Colombo)"],
  ["+971501234567", true, "+971501234567", "international (UAE)"],
  ["+1 415 555 2671", true, "+14155552671", "international (US)"],
  ["12345", false, null, "too short"],
  ["abc", false, null, "no digits"],
  ["", false, null, "empty"],
];
for (const [input, expectOk, expectE164, note] of phoneCases) {
  const r = checkPhone(input);
  check(
    r.ok === expectOk && r.e164 === expectE164,
    `${note}: "${input}" -> ok=${r.ok} e164=${r.e164}`,
  );
}

check(
  checkPhone("0771234567").pretty === "+94 77 123 4567",
  'pretty format is "+94 77 123 4567"',
);
check(
  checkPhone("0771234567").kind === "lk-mobile",
  "077 is detected as a mobile",
);
check(
  checkPhone("0112345678").kind === "lk-landline",
  "011 is detected as a landline",
);
check(
  whatsappLink("0771234567") === "https://wa.me/94771234567",
  "WhatsApp link is built from the normalised number",
);
check(whatsappLink("12345") === null, "no WhatsApp link for an invalid number");

console.log("\n== Never rewrite what the user typed ==");
check(
  displayPhone("call the office 123") === "call the office 123",
  "unrecognised text is printed exactly as entered",
);
check(
  displayPhone("0771234567") === "+94 77 123 4567",
  "valid numbers are printed tidily",
);

console.log("\n== Sanitisation ==");
const dirty = sanitizeBuyer({
  name: "  Ahmad\u0000\u0007 Trading\n\nCo.  ",
  phone: "077\t123\n4567",
});
check(
  dirty.name === "Ahmad Trading Co.",
  `control characters and newlines stripped from name -> "${dirty.name}"`,
);
check(
  dirty.phone === "077 123 4567",
  `control characters stripped from phone -> "${dirty.phone}"`,
);
check(
  sanitizeLine("x".repeat(500), BUYER_NAME_MAX).length === BUYER_NAME_MAX,
  `over-long input is capped at ${BUYER_NAME_MAX} characters`,
);
check(
  sanitizeBuyer(undefined).name === "" && sanitizeBuyer(null).phone === "",
  "missing buyer payload degrades to empty strings",
);
check(
  !hasBuyerInfo({ name: "", phone: "" }) &&
    hasBuyerInfo({ name: "A", phone: "" }),
  "hasBuyerInfo detects whether anything was entered",
);

console.log("\n== Buyer identity (used to group sales) ==");
check(
  buyerIdentityKey({ name: "Ahmad Trading", phone: "0771234567" }) ===
    buyerIdentityKey({ name: "ahmad trading co", phone: "+94 77 123 4567" }),
  "same phone in different formats groups as one buyer",
);
check(
  buyerIdentityKey({ name: "Ahmad", phone: "" }) !==
    buyerIdentityKey({ name: "Fatima", phone: "" }),
  "different names without phones stay separate",
);
check(
  buyerIdentityKey({ name: "Ahmad", phone: "" }) ===
    buyerIdentityKey({ name: "  ahmad ", phone: "" }),
  "name matching ignores case and padding",
);

console.log("\n== PDF buyer block ==");
(async () => {
  mkdirSync(".verify", { recursive: true });
  const sheet = buildSheetFromRows("Sri Lanka Order 3 2026", [
    { id: "1", name: "Blanket", qty: 10, perBag: 22000, totalOverride: null },
    { id: "2", name: "Bed Sheet", qty: 4, perBag: 36000, totalOverride: null },
  ]);

  const withBuyer = await renderSheetPdf(sheet, {
    label: "Sales",
    subtitle: "Sales recorded 09 Aug 2026",
    buyer: { name: "Ahmad Trading Co.", phone: "0771234567" },
    refNo: "VB-260809-001",
  });
  writeFileSync(".verify/buyer.pdf", withBuyer);
  check(withBuyer.length > 2000, `PDF with buyer rendered (${withBuyer.length} bytes)`);

  const withoutBuyer = await renderSheetPdf(sheet, { label: "Updated" });
  writeFileSync(".verify/no-buyer.pdf", withoutBuyer);
  check(
    withoutBuyer.length > 2000,
    `PDF without buyer still renders (${withoutBuyer.length} bytes)`,
  );

  check(
    Math.abs(sheet.grandTotal - (10 * 22000 + 4 * 36000)) < 0.01,
    `totals unaffected by buyer details (${sheet.grandTotal})`,
  );

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL BUYER CHECKS PASSED");
})();
