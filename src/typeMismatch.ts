import { join } from "node:path";
import { stateDir, type Plan, type PlanOp } from "./plan.js";
import { GidToRefMapper } from "./refs.js";
import { metafieldDefinitions } from "./resources/metafieldDefinitions.js";
import type { AdminClient } from "./shopify/client.js";
import { convertValue } from "./typeConvert.js";

/*
 * What to do when a metafield has one type in the source and another in the target (a single
 * value on one side, a list on the other). By default nothing: the plan reports a conflict.
 *
 *   convert_values      keep the target's definition and turn the source's values into its type
 *                       (a value becomes a list of one, a list of one becomes a value).
 *   retype_definitions  give the target's definition the source's type. Shopify can't change a
 *                       type in place, so the definition is deleted and created again: its values
 *                       are saved to a backup file first and written back converted where they can be.
 */

export const TYPE_MISMATCH_MODES = ["convert_values", "retype_definitions"] as const;
export type TypeMismatch = (typeof TYPE_MISMATCH_MODES)[number];

const TYPE_DIFFERS = /^type differs/;

/** "PRODUCT.custom.size" for a metafield value op ("PRODUCT/<handle>/custom.size", "SHOP/custom.size"...). */
function definitionKeyOf(op: PlanOp): string {
  return `${op.key.split("/")[0]}.${String(op.data.namespace)}.${String(op.data.key)}`;
}

/** The "N conflict(s) need a manual fix" line, counted again after ops changed. */
function recount(plan: Plan): void {
  plan.ops.forEach((o, i) => (o.seq = i + 1));
  const i = plan.warnings.findIndex((w) => /conflict\(s\) need a manual fix/.test(w));
  const n = plan.ops.filter((o) => o.action === "conflict" && !/doesn't exist in the target/.test(o.reason ?? "")).length;
  const line = `${n} conflict(s) need a manual fix in the target; they will be skipped.`;
  if (i >= 0) {
    if (n) plan.warnings[i] = line;
    else plan.warnings.splice(i, 1);
  } else if (n) plan.warnings.unshift(line);
}

/** Target definition types, by "OWNER.namespace.key". */
async function targetTypes(client: AdminClient, ownerTypes: string[]): Promise<Map<string, string>> {
  const res = await metafieldDefinitions.fetch(client, { ownerTypes }, new GidToRefMapper(client));
  return new Map(res.items.map((i) => [i.key, String(i.data.type)]));
}

export async function applyTypeMismatch(plan: Plan, mode: TypeMismatch, target: AdminClient): Promise<void> {
  const values = plan.ops.filter((o) => o.kind === "metafields");
  if (mode === "convert_values") {
    const owners = [...new Set(values.map((o) => o.key.split("/")[0]!))];
    const types = owners.length ? await targetTypes(target, owners) : new Map<string, string>();
    let converted = 0;
    const drop = new Set<PlanOp>();
    for (const op of values) {
      const want = types.get(definitionKeyOf(op));
      const from = String(op.data.type);
      if (!want || want === from) continue;
      if (op.action === "conflict" && !TYPE_DIFFERS.test(op.reason ?? "")) continue;
      const c = convertValue(String(op.data.value), from, want);
      if ("error" in c) {
        op.action = "conflict";
        op.reason = `type differs (${want} in target, ${from} in source) and the value can't be converted: ${c.error}`;
        continue;
      }
      op.data = { ...op.data, type: want, value: c.value };
      if (op.targetData && op.targetData.type === want && op.targetData.value === c.value) {
        drop.add(op);
        continue;
      }
      if (op.action === "conflict") {
        op.action = "update";
        op.reason = undefined;
      }
      converted++;
    }
    // The definitions keep the target's type on purpose: their type difference is no longer something to fix.
    for (const op of plan.ops) if (op.kind === "metafield_definitions" && op.action === "conflict" && TYPE_DIFFERS.test(op.reason ?? "")) drop.add(op);
    plan.ops = plan.ops.filter((o) => !drop.has(o));
    if (converted) plan.warnings.push(`${converted} metafield value(s) will be converted to the target definition's type (a single value becomes a list of one, a list of one a single value).`);
    recount(plan);
    return;
  }

  const retyped = new Map<string, string>();
  for (const op of plan.ops) {
    if (op.kind !== "metafield_definitions" || op.action !== "conflict" || !TYPE_DIFFERS.test(op.reason ?? "")) continue;
    op.action = "update";
    op.reason = undefined;
    op.data = { ...op.data, retypeFrom: op.targetData?.type };
    retyped.set(op.key, String(op.data.type));
  }
  for (const op of values) {
    if (op.action === "conflict" && TYPE_DIFFERS.test(op.reason ?? "") && retyped.get(definitionKeyOf(op)) === op.data.type) {
      op.action = "update";
      op.reason = undefined;
    }
  }
  if (retyped.size) {
    plan.warnings.push(
      `Definition(s) ${[...retyped.keys()].join(", ")} will be deleted in the target and created again with the source's type, because Shopify can't change a type in place. Their values in the target are saved to ${join(stateDir(), "backups")} first, then written back converted where possible (a list of several values can't become one value; those stay in the backup file). Check collection conditions, filters and theme code that use them.`,
    );
  } else if (values.some((o) => o.action === "conflict" && TYPE_DIFFERS.test(o.reason ?? ""))) {
    plan.warnings.push("Some values differ in type from the target's definition: include metafield_definitions so the definitions can be retyped.");
  }
  recount(plan);
}

