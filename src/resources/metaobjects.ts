import { assertNoUserErrors, paginate } from "../shopify/client.js";
import { REF_PREFIX } from "../refs.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO, reservedPrefix } from "./util.js";

const TYPES_QUERY = /* GraphQL */ `
  query MetaobjectTypes($after: String) {
    metaobjectDefinitions(first: 250, after: $after) {
      nodes { type }
      ${PAGE_INFO}
    }
  }
`;

const QUERY = /* GraphQL */ `
  query Metaobjects($type: String!, $after: String) {
    metaobjects(type: $type, first: 100, after: $after) {
      nodes {
        id
        type
        handle
        fields { key value }
        capabilities { publishable { status } }
      }
      ${PAGE_INFO}
    }
  }
`;

interface Node {
  id: string;
  type: string;
  handle: string;
  fields: { key: string; value: string | null }[];
  capabilities: { publishable: { status: string } | null } | null;
}

export function normalizeMetaobject(n: Node): Item {
  const fields: Record<string, string> = {};
  for (const f of [...n.fields].sort((a, b) => a.key.localeCompare(b.key))) {
    if (f.value !== null && f.value !== undefined) fields[f.key] = f.value;
  }
  return {
    key: `${n.type}/${n.handle}`,
    id: n.id,
    data: compact({
      type: n.type,
      handle: n.handle,
      status: n.capabilities?.publishable?.status,
      fields,
    }),
  };
}

async function upsert(client: Parameters<ResourceAdapter["create"]>[0]["client"], d: Record<string, unknown>): Promise<string> {
  const fields = Object.entries((d.fields as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value }));
  const res = await client.request(
    `mutation($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id } userErrors { field message code } }
    }`,
    {
      handle: { type: d.type, handle: d.handle },
      metaobject: compact({
        fields,
        capabilities: d.status ? { publishable: { status: d.status } } : undefined,
      }),
    },
  );
  assertNoUserErrors(res.metaobjectUpsert, `metaobjectUpsert ${String(d.type)}/${String(d.handle)}`);
  return res.metaobjectUpsert.metaobject.id;
}

export const metaobjects: ResourceAdapter = {
  kind: "metaobjects",
  description:
    "Metaobject entries, keyed by type/handle. Values that reference products, collections, pages or other metaobjects are remapped by handle.",

  async fetch(client, opts) {
    const skipped: { key: string; reason: string }[] = [];
    let types = opts.metaobjectTypes;
    if (!types?.length) {
      const all = await paginate<{ type: string }>(client, TYPES_QUERY, {}, (d) => d.metaobjectDefinitions);
      types = [];
      for (const { type } of all) {
        const reason = reservedPrefix(type);
        if (reason) skipped.push({ key: `${type}/*`, reason });
        else types.push(type);
      }
    }
    const items: Item[] = [];
    for (const type of types) {
      const nodes = await paginate<Node>(client, QUERY, { type }, (d) => d.metaobjects);
      items.push(...nodes.map(normalizeMetaobject));
    }
    return { items, skipped };
  },

  refFor(key) {
    return `${REF_PREFIX}Metaobject/${key}`;
  },

  async create({ client }, _key, d) {
    return upsert(client, d);
  },

  async update({ client }, _target, d) {
    await upsert(client, d);
  },
};
