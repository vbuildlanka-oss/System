/**
 * Verifies the two keys the system organises itself around - order number and
 * container ID:
 *  - both are read out of an uploaded file name, and a container in the name
 *    never leaks into the order number, whose digits it would otherwise become
 *  - the buyer's price list carries the order number and NO container, in the
 *    document and in the file name
 *  - every document is named the same way, and a missing key is dropped rather
 *    than leaving a stray dash
 *  - values already used anywhere in the system can be offered as suggestions
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  cleanShipment,
  collectShipmentValues,
  containerFromFilename,
  containerLine,
  shipmentFilename,
  shipmentFromFilename,
  shipmentLabel,
} from "../src/lib/shipment";
import { buyerPriceFilename, documentFilename } from "../src/lib/types";
import { orderNumberFromFilename } from "../src/lib/bagManifest";
import { POST as generatePost } from "../src/app/api/generate/route";
import type { NextRequest } from "next/server";

const pdfParse = require("pdf-parse/lib/pdf-parse.js");

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log("  ok   -", msg);
  else {
    console.error("  FAIL -", msg);
    failures += 1;
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}

const CONTAINER = "GAOU7441740";

/* ---------------------------- reading file names --------------------------- */

section("The order number in a file name");
{
  const cases: Array<[string, string]> = [
    ["Sri Lanka Order 3 2026.pdf", "Sri Lanka Order 03"],
    ["Sri Lanka Order 3 2026 - Sheet1 (1).pdf", "Sri Lanka Order 03"],
    ["Sri Lanka 01.xlsx", "Sri Lanka 01"],
    ["sri_lanka_order_12_2026.csv", "sri lanka order 12"],
    ["Order 7 - final.pdf", "Order 07"],
    ["Sri Lanka Order 3 rev 2.pdf", "Sri Lanka Order 03"],
    ["Sri Lanka.pdf", "Sri Lanka"],
    ["2026.pdf", ""],
  ];
  for (const entry of cases) {
    const got = orderNumberFromFilename(entry[0]);
    check(got === entry[1], `"${entry[0]}" -> "${got}"`);
  }
  check(orderNumberFromFilename("") === "", "an empty name gives an empty order number");
}

section("The container ID in a file name");
{
  check(
    containerFromFilename(`Sri Lanka Order 3 ${CONTAINER}.pdf`) === CONTAINER,
    "a container code in the name is found",
  );
  check(
    containerFromFilename("Sri Lanka Order 3 gaou 744174-0.pdf") === CONTAINER,
    "even written in lower case and split up",
  );
  check(
    containerFromFilename("Sri Lanka Order 3 2026.pdf") === "",
    "a name with no container gives nothing",
  );
  // Eleven characters of the right shape are not enough: the check digit has to
  // add up, or a random code would be turned into a container.
  check(
    containerFromFilename("Sri Lanka ABCD1234567.pdf") === "",
    "a code whose check digit does not add up is refused",
  );
  check(
    containerFromFilename("Invoice 0771234567.pdf") === "",
    "and a phone number is not mistaken for one",
  );
  check(
    containerFromFilename(`Sri Lanka gaou_744174_0.pdf`) === CONTAINER,
    "underscores between the parts are handled too",
  );
  check(
    containerFromFilename("Sri Lanka GAOU74417401.pdf") === "",
    "a longer run of digits does not have its first seven taken",
  );
}

section("A container in the file name must not become the order number");
{
  // The trap: "GAOU7441740" contains 7441740, and that is the first number in
  // the name, so a naive read makes it the order number.
  const leading = shipmentFromFilename(`${CONTAINER} - Sri Lanka Order 3.pdf`);
  check(
    leading.orderNumber === "Sri Lanka Order 03",
    `the container is removed before the order number is read (${leading.orderNumber})`,
  );
  check(leading.containerId === CONTAINER, "and is kept as the container");
  check(
    !leading.orderNumber.includes("7441740"),
    "so no part of the container ends up in the order number",
  );

  const trailing = shipmentFromFilename(`Sri Lanka Order 3 2026 ${CONTAINER}.pdf`);
  check(
    trailing.orderNumber === "Sri Lanka Order 03" && trailing.containerId === CONTAINER,
    `both are read whichever way round they appear (${trailing.orderNumber} / ${trailing.containerId})`,
  );
  check(
    !trailing.orderNumber.includes("GAOU"),
    "and the letters do not survive into the order number either",
  );

  const neither = shipmentFromFilename("notes.pdf");
  check(
    neither.orderNumber === "notes" && neither.containerId === "",
    `a plain name gives just an order number (${JSON.stringify(neither)})`,
  );
}

/* -------------------------- the buyer sees no container -------------------- */

section("The buyer's price list carries the order number and no container");
{
  // The rule: a container ID is ours, not the buyer's. It must not reach the
  // document or the file name, even when the uploaded file was named after it.
  const fromFile = shipmentFromFilename(`Sri Lanka Order 3 2026 ${CONTAINER}.pdf`);
  const name = buyerPriceFilename(fromFile.orderNumber);

  check(
    name === "Sri Lanka Order 03 - Buyer Price List.pdf",
    `the file is named after the order (${name})`,
  );
  check(!name.includes(CONTAINER), "and the container is not in the file name");
  check(!name.includes("GAOU"), "not even part of it");
}

async function pdfChecks() {
  section("...and not inside the PDF either");

  const jsonReq = (body: unknown): NextRequest =>
    new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest;

  // A container smuggled into the payload must simply be ignored, the same way
  // a price sent to the bag manifest route is.
  const res = await generatePost(
    jsonReq({
      title: "Sri Lanka Order 03",
      markup: 2000,
      items: [
        { name: "Anorak", qty: 10, perBag: 24_000, total: 240_000 },
        { name: "Blanket", qty: 5, perBag: 12_000, total: 60_000 },
      ],
      containerNumber: CONTAINER,
      containerId: CONTAINER,
      buyer: { name: "Ahmad Trading", phone: "0771234567" },
      refNo: "BB-3F7K-260814-001",
    }),
  );
  check(res.status === 200, `the price list is generated (${res.status})`);

  const disposition = res.headers.get("Content-Disposition") ?? "";
  check(
    disposition.includes("Sri Lanka Order 03 - Buyer Price List.pdf"),
    `named after the order number (${disposition})`,
  );
  check(
    !disposition.includes(CONTAINER),
    "with no container in the name the browser is told to use",
  );

  const buf = Buffer.from(await res.arrayBuffer());
  const text = String((await pdfParse(buf, { version: "v2.0.550" })).text);

  check(text.includes("Sri Lanka Order 03"), "the order number is printed on it");
  check(
    !text.includes(CONTAINER),
    "the container ID is nowhere in the document",
  );
  check(!text.includes("GAOU"), "not even the owner code");
  check(
    !text.toLowerCase().includes("container"),
    "and the word container does not appear at all",
  );
  // Sanity: the buyer's own figures are there, so the search above was looking
  // at real extracted text rather than at nothing.
  check(text.includes("Anorak"), "while the buyer's items are printed");
  check(text.includes("Ahmad Trading"), "and the buyer is named");

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/buyer-price.pdf", buf);

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL SHIPMENT CHECKS PASSED");
}

/* ------------------------------ naming things ----------------------------- */

section("One naming convention for every document");
{
  const both = { orderNumber: "Sri Lanka Order 03", containerId: CONTAINER };
  check(
    shipmentFilename(both, "Bags", "xlsx") ===
      "Sri Lanka Order 03 - GAOU7441740 - Bags.xlsx",
    `order, container, document (${shipmentFilename(both, "Bags", "xlsx")})`,
  );
  check(
    shipmentFilename({ orderNumber: "Sri Lanka Order 03", containerId: "" }, "Bags") ===
      "Sri Lanka Order 03 - Bags.pdf",
    "a missing container is dropped rather than leaving a gap",
  );
  check(
    shipmentFilename({ orderNumber: "", containerId: CONTAINER }, "Bags") ===
      "GAOU7441740 - Bags.pdf",
    "and so is a missing order number",
  );
  check(
    shipmentFilename({ orderNumber: "", containerId: "" }, "Bags") === "Order - Bags.pdf",
    `with neither, it still gets a usable name (${shipmentFilename({ orderNumber: "", containerId: "" }, "Bags")})`,
  );

  // A name the operating system will accept, whatever was typed.
  const nasty = documentFilename("Sri Lanka / Order: 3 *?", "Buyer Price List");
  check(
    !/[/:*?"<>|]/.test(nasty),
    `characters an operating system refuses are stripped (${nasty})`,
  );
  check(nasty.endsWith(".pdf"), "and the extension survives");
  check(
    documentFilename("", "Buyer Price List") === "Order - Buyer Price List.pdf",
    "an empty title falls back to Order rather than producing a nameless file",
  );
}

section("How a shipment reads");
{
  check(
    shipmentLabel({ orderNumber: "Sri Lanka Order 03", containerId: CONTAINER }) ===
      `Sri Lanka Order 03 - ${CONTAINER}`,
    "both keys are shown when both are known",
  );
  check(
    shipmentLabel({ orderNumber: "Sri Lanka Order 03", containerId: "" }) ===
      "Sri Lanka Order 03",
    "one key on its own is shown without a trailing dash",
  );
  check(shipmentLabel({ orderNumber: "", containerId: "" }) === "", "and neither gives nothing");

  check(
    containerLine(CONTAINER) === `Container Number: ${CONTAINER}`,
    "the container line matches the wording the manifests use",
  );
  check(containerLine("  ") === "", "and is empty when there is no container");
}

section("Tidying what was typed");
{
  const clean = cleanShipment({
    orderNumber: "  Sri   Lanka  Order 3  ",
    containerId: " gaou 744174-0 ",
  });
  check(clean.orderNumber === "Sri Lanka Order 3", `spacing is tidied (${clean.orderNumber})`);
  check(clean.containerId === CONTAINER, `the container is normalised (${clean.containerId})`);

  const empty = cleanShipment({});
  check(
    empty.orderNumber === "" && empty.containerId === "",
    "and nothing at all is handled without complaint",
  );
  const hostile = cleanShipment({ orderNumber: { a: 1 }, containerId: [] });
  check(
    typeof hostile.orderNumber === "string" && typeof hostile.containerId === "string",
    "an object cannot become an order number",
  );
}

/* ------------------------------- suggestions ------------------------------ */

section("Values the system already knows");
{
  const values = collectShipmentValues({
    manifests: {
      manifests: [
        { orderNumber: "Sri Lanka Order 03", containerNumber: CONTAINER },
        { orderNumber: "Sri Lanka Order 04", containerNumber: "MSCU1234565" },
      ],
    },
    balance: {
      expenses: [
        { containerId: CONTAINER },
        { containerId: "" },
        { containerId: "TCLU1234567" },
      ],
      turnover: [{ containerId: "MSCU1234565" }],
    },
    editor: { sheets: [{ title: "Sri Lanka Order 05" }] },
    stockpile: { items: [{ lots: [{ source: "Sri Lanka Order 03" }] }] },
    requests: { sources: [{ containerId: CONTAINER }] },
  });

  check(
    values.containerIds.join(", ") === "GAOU7441740, MSCU1234565, TCLU1234567",
    `every container the system has seen, once each, sorted (${values.containerIds.join(", ")})`,
  );
  check(
    !values.containerIds.includes(""),
    "general overhead does not appear as a blank suggestion",
  );
  check(
    values.orderNumbers.join(", ") ===
      "Sri Lanka Order 03, Sri Lanka Order 04, Sri Lanka Order 05",
    `and every order number, deduplicated across sections (${values.orderNumbers.join(", ")})`,
  );

  const nothing = collectShipmentValues({});
  check(
    nothing.orderNumbers.length === 0 && nothing.containerIds.length === 0,
    "nothing in gives nothing out",
  );

  // Documents from an older version, or half-written ones, must contribute what
  // they can instead of stopping the rest from being read.
  const ragged = collectShipmentValues({
    manifests: { manifests: [null, {}, { orderNumber: "Sri Lanka Order 09" }] },
    balance: { expenses: "not an array" },
    stockpile: { items: [{ lots: null }, { lots: [{ source: "Order 10" }] }] },
    requests: null,
    editor: 42,
  });
  check(
    ragged.orderNumbers.join(", ") === "Order 10, Sri Lanka Order 09",
    `ragged documents still give up what they have (${ragged.orderNumbers.join(", ")})`,
  );
  check(ragged.containerIds.length === 0, "and contribute no rubbish");

  const dupes = collectShipmentValues({
    manifests: {
      manifests: [
        { orderNumber: "Sri Lanka Order 03", containerNumber: "gaou 744174-0" },
        { orderNumber: "sri lanka order 03", containerNumber: CONTAINER },
      ],
    },
  });
  check(
    dupes.containerIds.length === 1,
    `the same container written two ways is one suggestion (${dupes.containerIds.join(", ")})`,
  );
  check(
    dupes.orderNumbers.length === 1,
    `and so is an order number in a different case (${dupes.orderNumbers.join(", ")})`,
  );
}

pdfChecks();
