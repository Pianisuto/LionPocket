import { isValidDate } from "@lionpocket/core";
import { canonicalStringify } from "./canonical";
import { assertUuid, assertManualTransactionRevision } from "./validation";
import type { EntityType, RevisionPlaintext } from "./types";

export const financialScopes: EntityType[] = [
  "category",
  "paymentMethod",
  "card",
  "recurring",
  "installmentPurchase",
  "transaction",
  "goal",
  "recurringPriorityList",
  "monthlyPriorityList",
  "monthlyPlanning",
];
const fields: Record<EntityType, string[]> = {
  category: ["name", "kind", "color"],
  paymentMethod: ["name"],
  card: ["name", "dueDay", "closingDay"],
  transaction: [
    "kind",
    "description",
    "categoryId",
    "plannedAmountCents",
    "actualAmountCents",
    "purchaseDate",
    "dueDate",
    "settledDate",
    "status",
    "paymentMethodId",
    "cardId",
    "notes",
    "source",
    "installmentNumber",
    "installmentTotal",
    "occurrenceDate",
  ],
  recurring: [
    "kind",
    "active",
    "description",
    "startMonth",
    "startDate",
    "frequency",
    "intervalCount",
    "intervalUnit",
    "anchorToActual",
    "manualMonths",
    "scheduleEpoch",
    "categoryId",
    "paymentMethodId",
    "cardId",
    "plannedAmountCents",
    "dueDay",
    "chargeDay",
    "notes",
    "identityStatus",
    "aliases",
  ],
  installmentPurchase: [
    "description",
    "categoryId",
    "paymentMethodId",
    "cardId",
    "installmentAmountCents",
    "totalInstallments",
    "startingInstallment",
    "purchaseDate",
    "firstDueDate",
    "status",
    "notes",
    "identityStatus",
    "slots",
  ],
  goal: [
    "name",
    "itemModel",
    "link",
    "categoryId",
    "targetAmountCents",
    "savedAmountCents",
    "priority",
    "dueDate",
    "status",
    "notes",
  ],
  recurringPriorityList: ["entries"],
  monthlyPriorityList: ["month", "transactionIds"],
  monthlyPlanning: ["month", "safetyMarginCents"],
};
const exact = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid object.");
  const r = v as Record<string, unknown>;
  if (
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    throw new Error("Unexpected or missing field.");
  return r;
};
const oneOf = (v: unknown, choices: unknown[]) => {
  if (!choices.includes(v)) throw new Error("Invalid enum.");
};
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error("Invalid integer.");
};
const date = (v: unknown, nullable = false) => {
  if (nullable && v === null) return;
  if (typeof v !== "string" || !isValidDate(v))
    throw new Error("Invalid date.");
};
const month = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v))
    throw new Error("Invalid month.");
};
const array = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 10000) throw new Error("Invalid array.");
  return v;
};
/** Strict domain decoding; unknown schemas/fields remain in durable quarantine. */
export function assertFinancialRevision(
  value: unknown,
): asserts value is RevisionPlaintext {
  canonicalStringify(value);
  const r = value as RevisionPlaintext;
  if (!r || !financialScopes.includes(r.entityType))
    throw new Error("Unsupported domain scope.");
  // Reuse the independently tested audit/tombstone validation, with a harmless manual DTO.
  const audit = {
    ...r,
    entityType: "transaction",
    dependencies: [],
    ...(r.action === "put"
      ? {
          snapshot: {
            kind: "expense",
            description: "audit",
            plannedAmountCents: 0,
            actualAmountCents: null,
            purchaseDate: null,
            dueDate: "2026-01-01",
            settledDate: null,
            status: "planned",
            notes: "",
            categoryId: null,
            paymentMethodId: null,
            cardId: null,
            source: { type: "manual" },
            installmentNumber: null,
            installmentTotal: null,
            occurrenceDate: null,
          },
        }
      : { reason: "user", slotKey: null, importKey: null }),
  };
  assertManualTransactionRevision(audit);
  for (const d of array(r.dependencies)) {
    const dep = exact(d, ["objectId", "revisionId"]);
    assertUuid(dep.objectId);
    assertUuid(dep.revisionId, "4");
  }
  if (r.action === "delete") {
    oneOf(r.reason, ["user", "legacy_unknown"]);
    if (r.slotKey !== null && typeof r.slotKey !== "string")
      throw new Error("Invalid slot.");
    if (r.importKey !== null && typeof r.importKey !== "string")
      throw new Error("Invalid import key.");
    return;
  }
  const s = exact(r.snapshot, fields[r.entityType]);
  for (const k of [
    "name",
    "description",
    "notes",
    "color",
    "itemModel",
    "link",
  ])
    if (k in s && typeof s[k] !== "string") throw new Error("Invalid text.");
  for (const k of ["name", "description"])
    if (k in s && !(s[k] as string).trim()) throw new Error("Empty text.");
  if ("kind" in s) oneOf(s.kind, ["income", "expense"]);
  for (const k of ["categoryId", "paymentMethodId", "cardId"])
    if (k in s && s[k] !== null) assertUuid(s[k]);
  for (const k of Object.keys(s).filter((k) => k.endsWith("Cents")))
    if (s[k] !== null || k !== "actualAmountCents") integer(s[k]);
  for (const k of ["dueDay", "closingDay", "chargeDay"])
    if (k in s && s[k] !== null) integer(s[k], 1, 31);
  for (const k of [
    "purchaseDate",
    "dueDate",
    "settledDate",
    "occurrenceDate",
    "startDate",
    "firstDueDate",
  ])
    if (k in s)
      date(
        s[k],
        !["firstDueDate"].includes(k) &&
          (k !== "dueDate" || r.entityType === "goal"),
      );
  if (r.entityType === "transaction") {
    oneOf(s.status, ["planned", "paid", "received", "cancelled"]);
    if (
      (s.status === "paid" && s.kind !== "expense") ||
      (s.status === "received" && s.kind !== "income") ||
      ["paid", "received"].includes(String(s.status)) ===
        (s.settledDate === null)
    )
      throw new Error("Invalid settlement.");
    for (const k of ["installmentNumber", "installmentTotal"])
      if (s[k] !== null) integer(s[k], 1);
    const src = s.source as Record<string, unknown>;
    if (!src) throw new Error("Invalid source.");
    switch (src.type) {
      case "manual":
        exact(src, ["type"]);
        break;
      case "recurring":
        exact(src, ["type", "seriesId", "slotKey"]);
        assertUuid(src.seriesId);
        if (typeof src.slotKey !== "string" || !src.slotKey)
          throw new Error("Invalid slot.");
        break;
      case "installment":
        exact(src, ["type", "purchaseId", "slotId"]);
        assertUuid(src.purchaseId);
        assertUuid(src.slotId);
        break;
      case "imported":
        exact(src, ["type", "importKey", "importAlgorithmVersion"]);
        if (
          typeof src.importKey !== "string" ||
          !/^[a-f0-9]{64}$/.test(src.importKey) ||
          src.importAlgorithmVersion !== 1
        )
          throw new Error("Invalid import provenance.");
        break;
      default:
        throw new Error("Invalid source.");
    }
  }
  if (r.entityType === "recurring") {
    month(s.startMonth);
    oneOf(s.frequency, ["once", "weekly", "monthly", "custom", "manual"]);
    oneOf(s.intervalUnit, ["days", "weeks", "months", "years"]);
    integer(s.intervalCount, 1);
    for (const k of ["active", "anchorToActual"])
      if (typeof s[k] !== "boolean") throw new Error("Invalid boolean.");
    assertUuid(s.scheduleEpoch, "4");
    array(s.manualMonths).forEach((m) => {
      if (typeof m !== "string" || !/^(0[1-9]|1[0-2])$/.test(m))
        throw new Error("Invalid scheduled month.");
    });
    const keys = new Set<string>();
    for (const a of array(s.aliases)) {
      const v = exact(a, ["slotKey", "objectId", "originalDate"]);
      if (typeof v.slotKey !== "string" || keys.has(v.slotKey))
        throw new Error("Invalid aliases.");
      keys.add(v.slotKey);
      assertUuid(v.objectId);
      date(v.originalDate, true);
    }
  }
  if (r.entityType === "installmentPurchase") {
    integer(s.totalInstallments, 1);
    integer(s.startingInstallment, 1);
    if (Number(s.startingInstallment) > Number(s.totalInstallments))
      throw new Error("Invalid installments.");
    oneOf(s.status, ["active", "completed", "cancelled"]);
    const seen = new Set<string>();
    for (const a of array(s.slots)) {
      const v = exact(a, ["slotId", "originalIndex", "objectId"]);
      assertUuid(v.slotId);
      assertUuid(v.objectId);
      integer(v.originalIndex, 1);
      if (seen.has(String(v.slotId))) throw new Error("Duplicate slot.");
      seen.add(String(v.slotId));
    }
  }
  if ("identityStatus" in s)
    oneOf(s.identityStatus, ["resolved", "identity_unresolved"]);
  if (r.entityType === "goal") {
    oneOf(s.status, ["planned", "saving", "completed", "paused", "cancelled"]);
    oneOf(s.priority, ["low", "medium", "high"]);
  }
  if (r.entityType === "monthlyPlanning") month(s.month);
  if (r.entityType === "monthlyPriorityList") {
    month(s.month);
    const ids = array(s.transactionIds);
    ids.forEach((id) => assertUuid(id));
    if (new Set(ids).size !== ids.length)
      throw new Error("Duplicate priority.");
  }
  if (r.entityType === "recurringPriorityList") {
    const ids = new Set();
    for (const e of array(s.entries)) {
      const v = exact(e, ["seriesId", "pinnedFromMonth"]);
      assertUuid(v.seriesId);
      month(v.pinnedFromMonth);
      if (ids.has(v.seriesId)) throw new Error("Duplicate priority.");
      ids.add(v.seriesId);
    }
  }
}
export function assertSupportedRevision(
  value: unknown,
  financial: boolean,
): asserts value is RevisionPlaintext {
  if (financial) assertFinancialRevision(value);
  else assertManualTransactionRevision(value);
}
