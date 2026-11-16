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

const BY_HANDLE = /* GraphQL */ `
  query MetaobjectByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      type
      handle
      fields { key value }
      capabilities { publishable { status } }
    }
  }
`;

/** Up to this many entries of one type are looked up one by one; more and the whole type is read (100 per request). */
const LOOKUP_LIMIT = 3;

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

async function upsert(client: Parameters<ResourceAdapter["create"]>[0]["client"], d: Record<string, unknown>, create = false): Promise<string> {
  // With as_drafts the data carries no status: a new entry starts as a draft, an existing one keeps its own.
  const status = d.status ?? (create && d.publishable ? "DRAFT" : undefined);
  const fields = Object.entries((d.fields as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value }));
  const res = await client.request(
    `mutation($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id } userErrors { field message code } }
    }`,
    {
      handle: { type: d.type, handle: d.handle },
      metaobject: compact({
        fields,
        capabilities: status ? { publishable: { status } } : undefined,
      }),
    },
  );
  assertNoUserErrors(res.metaobjectUpsert, `metaobjectUpsert ${String(d.type)}/${String(d.handle)}`);
  return res.metaobjectUpsert.metaobject.id;
}

export const metaobjects: ResourceAdapter = {
  kind: "metaobjects",
  description:
    "Metaobject entries, keyed by type/handle. Values that reference products, collections, pages or other metaobjects are remapped by handle. Fields that only the target entry has a value for are kept.",

  async fetch(client, opts) {
    const skipped: { key: string; reason: string }[] = [];
    // What the include patterns (or a plan's keys) ask for: entries by handle, whole types, or type prefixes.
    const handles = new Map<string, string[]>();
    const wholeTypes = new Set<string>();
    const typePrefixes: string[] = [];
    let narrow = Boolean(opts.keys);
    for (const k of opts.keys?.exact ?? []) {
      const i = k.indexOf("/");
      if (i > 0) handles.set(k.slice(0, i), [...(handles.get(k.slice(0, i)) ?? []), k.slice(i + 1)]);
    }
    for (const p of opts.keys?.prefixes ?? []) {
      const i = p.indexOf("/");
      if (i > 0) wholeTypes.add(p.slice(0, i));
      else typePrefixes.push(p);
    }
    if (opts.keys && !handles.size && !wholeTypes.size && !typePrefixes.length) narrow = false;

    let types = opts.metaobjectTypes;
    if (!types?.length && (!narrow || typePrefixes.length)) {
      const all = await paginate<{ type: string }>(client, TYPES_QUERY, {}, (d) => d.metaobjectDefinitions);
      types = [];
      for (const { type } of all) {
        const reason = reservedPrefix(type);
        if (reason) skipped.push({ key: `${type}/*`, reason });
        else types.push(type);
      }
    }
    // Types to read in full, and entries to look up one by one.
    let full: string[];
    const lookups: { type: string; handle: string }[] = [];
    if (!narrow) full = types ?? [];
    else {
      const wanted = new Set([...wholeTypes, ...(types ?? []).filter((t) => typePrefixes.some((p) => t.startsWith(p)))]);
      for (const [type, list] of handles) {
        if (wanted.has(type) || reservedPrefix(type)) continue;
        if (list.length > LOOKUP_LIMIT) wanted.add(type);
        else for (const handle of list) lookups.push({ type, handle });
      }
      full = [...wanted].filter((t) => !reservedPrefix(t) && (!opts.metaobjectTypes?.length || opts.metaobjectTypes.includes(t)));
    }
    const allowed = (t: string) => !opts.metaobjectTypes?.length || opts.metaobjectTypes.includes(t);

    // Types are independent, so they are read in parallel (the client limits how many run at once).
    const [lists, found] = await Promise.all([
      Promise.all(full.map((type) => paginate<Node>(client, QUERY, { type }, (d) => d.metaobjects))),
      Promise.all(
        lookups
          .filter((l) => allowed(l.type))
          .map(async (handle) => (await client.request<{ metaobjectByHandle: Node | null }>(BY_HANDLE, { handle })).metaobjectByHandle),
      ),
    ]);
    const items = [...lists.flat(), ...found.filter((n): n is Node => Boolean(n))].map(normalizeMetaobject);
    return { items, skipped };
  },

  // Entries are written a few at a time. One that points at another new entry not created yet is
  // finished in the second pass, like any other reference that isn't there yet.
  parallel: true,

  refFor(key) {
    return `${REF_PREFIX}Metaobject/${key}`;
  },

  /** A field the source has no value for is never cleared in the target, so it isn't a difference. */
  alignTarget(source, target) {
    const wanted = (source.fields as Record<string, string>) ?? {};
    const fields = Object.fromEntries(Object.entries((target.fields as Record<string, string>) ?? {}).filter(([k]) => k in wanted));
    return { ...target, fields };
  },

  async create({ client }, _key, d) {
    return upsert(client, d, true);
  },

  async update({ client }, _target, d) {
    await upsert(client, d);
  },
};
