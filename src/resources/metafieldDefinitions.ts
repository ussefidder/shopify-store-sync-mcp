import { accessDenied, assertNoUserErrors, paginate } from "../shopify/client.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, oneOf, PAGE_INFO, reservedPrefix, sortValidations } from "./util.js";

export const DEFAULT_OWNER_TYPES = [
  "PRODUCT",
  "PRODUCTVARIANT",
  "COLLECTION",
  "CUSTOMER",
  "ORDER",
  "DRAFTORDER",
  "COMPANY",
  "COMPANY_LOCATION",
  "LOCATION",
  "MARKET",
  "PAGE",
  "BLOG",
  "ARTICLE",
  "SHOP",
];

const STOREFRONT = ["NONE", "PUBLIC_READ"] as const;
const CUSTOMER_ACCOUNT = ["NONE", "READ", "READ_WRITE"] as const;

const QUERY = /* GraphQL */ `
  query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 250, after: $after) {
      nodes {
        id
        name
        namespace
        key
        description
        ownerType
        pinnedPosition
        type { name }
        access { storefront customerAccount }
        capabilities {
          adminFilterable { enabled }
          smartCollectionCondition { enabled }
          uniqueValues { enabled }
        }
        validations { name value }
      }
      ${PAGE_INFO}
    }
  }
`;

interface Node {
  id: string;
  name: string;
  namespace: string;
  key: string;
  description: string | null;
  ownerType: string;
  pinnedPosition: number | null;
  type: { name: string };
  access: { storefront: string | null; customerAccount: string | null };
  capabilities: {
    adminFilterable: { enabled: boolean };
    smartCollectionCondition: { enabled: boolean };
    uniqueValues: { enabled: boolean };
  };
  validations: { name: string; value: string | null }[];
}

export function normalizeMetafieldDefinition(n: Node): Item {
  return {
    key: `${n.ownerType}.${n.namespace}.${n.key}`,
    id: n.id,
    data: compact({
      ownerType: n.ownerType,
      namespace: n.namespace,
      key: n.key,
      name: n.name,
      description: n.description || undefined,
      type: n.type.name,
      pinned: n.pinnedPosition !== null && n.pinnedPosition !== undefined,
      access: compact({
        storefront: oneOf(n.access?.storefront, STOREFRONT),
        customerAccount: oneOf(n.access?.customerAccount, CUSTOMER_ACCOUNT),
      }),
      capabilities: {
        adminFilterable: n.capabilities.adminFilterable.enabled,
        smartCollectionCondition: n.capabilities.smartCollectionCondition.enabled,
        uniqueValues: n.capabilities.uniqueValues.enabled,
      },
      validations: sortValidations(n.validations),
    }),
  };
}

function capabilitiesInput(c: Record<string, boolean> | undefined, includeUnique: boolean) {
  if (!c) return undefined;
  return compact({
    adminFilterable: { enabled: Boolean(c.adminFilterable) },
    smartCollectionCondition: { enabled: Boolean(c.smartCollectionCondition) },
    uniqueValues: includeUnique ? { enabled: Boolean(c.uniqueValues) } : undefined,
  });
}

export const metafieldDefinitions: ResourceAdapter = {
  kind: "metafield_definitions",
  description: "Metafield definitions, keyed by OWNER_TYPE.namespace.key",

  async fetch(client, opts) {
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    // One list per owner type; they're independent, so read them in parallel. Some owner types
    // (customers, orders, locations...) need extra permissions; one the sign-in can't read is
    // reported and left out of the comparison instead of failing the whole read.
    const lists = await Promise.all(
      (opts.ownerTypes ?? DEFAULT_OWNER_TYPES).map(async (ownerType) => {
        try {
          return await paginate<Node>(client, QUERY, { ownerType }, (d) => d.metafieldDefinitions);
        } catch (e) {
          const required = accessDenied(e);
          if (required === undefined) throw e;
          skipped.push({ key: `${ownerType}.*`, reason: `not readable with this store's permissions${required ? ` (Shopify needs ${required.replace(/`/g, "")})` : ""}, so ${ownerType} definitions are not compared` });
          return [];
        }
      }),
    );
    for (const nodes of lists) {
      for (const n of nodes) {
        const reason = reservedPrefix(n.namespace);
        if (reason) skipped.push({ key: `${n.ownerType}.${n.namespace}.${n.key}`, reason });
        else items.push(normalizeMetafieldDefinition(n));
      }
    }
    return { items, skipped };
  },

  conflict(source, target) {
    if (source.data.type !== target.data.type) {
      return `type differs (${String(target.data.type)} in target, ${String(source.data.type)} in source); Shopify can't change a definition's type in place`;
    }
    return undefined;
  },

  async create({ client }, _key, d) {
    const res = await client.request(
      `mutation($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } }
      }`,
      {
        definition: compact({
          ownerType: d.ownerType,
          namespace: d.namespace,
          key: d.key,
          name: d.name,
          description: d.description,
          type: d.type,
          pin: d.pinned,
          access: d.access && Object.keys(d.access).length ? d.access : undefined,
          capabilities: capabilitiesInput(d.capabilities as Record<string, boolean>, true),
          validations: d.validations,
        }),
      },
    );
    assertNoUserErrors(res.metafieldDefinitionCreate, "metafieldDefinitionCreate");
    return res.metafieldDefinitionCreate.createdDefinition.id;
  },

  async update({ client }, _target, d) {
    const res = await client.request(
      `mutation($definition: MetafieldDefinitionUpdateInput!) {
        metafieldDefinitionUpdate(definition: $definition) { updatedDefinition { id } userErrors { field message code } }
      }`,
      {
        definition: compact({
          ownerType: d.ownerType,
          namespace: d.namespace,
          key: d.key,
          name: d.name,
          description: d.description,
          pin: d.pinned,
          access: d.access && Object.keys(d.access).length ? d.access : undefined,
          capabilities: capabilitiesInput(d.capabilities as Record<string, boolean>, true),
          validations: d.validations,
        }),
      },
    );
    assertNoUserErrors(res.metafieldDefinitionUpdate, "metafieldDefinitionUpdate");
  },
};
