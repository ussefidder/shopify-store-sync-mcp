import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./plan.js";
import { assertNoUserErrors, paginate, type AdminClient } from "./shopify/client.js";
import { convertValue } from "./typeConvert.js";

const DEFINITION = /* GraphQL */ `
  query RetypeDefinition($identifier: MetafieldDefinitionIdentifierInput!, $after: String) {
    metafieldDefinition(identifier: $identifier) {
      id
      type { name }
      metafields(first: 250, after: $after) {
        nodes { type value owner { ... on Node { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const SET = /* GraphQL */ `
  mutation RetypeValues($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message code } } }
`;

/**
 * Delete a target definition and create it again with the source's type (`d`), keeping its values:
 * saved to a backup file first, then written back converted. Returns what couldn't be converted.
 */
export async function retypeDefinition(
  client: AdminClient,
  d: Record<string, unknown>,
  create: () => Promise<string>,
): Promise<{ backup: string; left: number }> {
  const identifier = { ownerType: d.ownerType, namespace: d.namespace, key: d.key };
  const values: { type: string; value: string; owner: { id: string } }[] = [];
  let id: string | undefined;
  let from = "";
  await paginate<{ type: string; value: string; owner: { id: string } }>(client, DEFINITION, { identifier }, (data) => {
    id = data.metafieldDefinition?.id;
    from = data.metafieldDefinition?.type.name ?? "";
    return data.metafieldDefinition?.metafields ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }).then((nodes) => values.push(...nodes));
  if (!id) throw new Error(`the target has no definition ${String(d.ownerType)}.${String(d.namespace)}.${String(d.key)} any more; plan again`);

  const dir = join(stateDir(), "backups");
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `${client.store.domain}-${String(d.ownerType)}.${String(d.namespace)}.${String(d.key)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, JSON.stringify({ store: client.store.domain, definition: { ...identifier, type: from }, values }, null, 1));

  const del = await client.request(
    `mutation RetypeDelete($id: ID!) { metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) { deletedDefinitionId userErrors { field message code } } }`,
    { id },
  );
  assertNoUserErrors(del.metafieldDefinitionDelete, `metafieldDefinitionDelete (values saved to ${backup})`);
  await create();

  const to = String(d.type);
  const writes: Record<string, unknown>[] = [];
  let left = 0;
  for (const v of values) {
    const c = convertValue(v.value, v.type, to);
    if ("error" in c) left++;
    else writes.push({ ownerId: v.owner.id, namespace: d.namespace, key: d.key, type: to, value: c.value });
  }
  for (let i = 0; i < writes.length; i += 25) {
    const res = await client.request(SET, { m: writes.slice(i, i + 25) });
    assertNoUserErrors(res.metafieldsSet, `metafieldsSet (retyped values; originals in ${backup})`);
  }
  return { backup, left };
}
