import { assertNoUserErrors, paginate } from "../shopify/client.js";
import { REF_PREFIX } from "../refs.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, oneOf, PAGE_INFO, reservedPrefix, sortValidations } from "./util.js";

const STOREFRONT = ["NONE", "PUBLIC_READ"] as const;
const CUSTOMER_ACCOUNT = ["NONE", "READ"] as const;

const QUERY = /* GraphQL */ `
  query MetaobjectDefinitions($after: String) {
    metaobjectDefinitions(first: 100, after: $after) {
      nodes {
        id
        type
        name
        description
        displayNameKey
        access { storefront customerAccount }
        capabilities {
          publishable { enabled }
          translatable { enabled }
          renderable { enabled }
          onlineStore { enabled data { urlHandle } }
        }
        fieldDefinitions {
          key
          name
          description
          required
          type { name }
          validations { name value }
          capabilities { adminFilterable { enabled } }
        }
      }
      ${PAGE_INFO}
    }
  }
`;

interface FieldNode {
  key: string;
  name: string;
  description: string | null;
  required: boolean;
  type: { name: string };
  validations: { name: string; value: string | null }[];
  capabilities: { adminFilterable: { enabled: boolean } };
}

export interface MetaobjectDefinitionNode {
  id: string;
  type: string;
  name: string;
  description: string | null;
  displayNameKey: string | null;
  access: { storefront: string | null; customerAccount: string | null };
  capabilities: {
    publishable: { enabled: boolean };
    translatable: { enabled: boolean };
    renderable: { enabled: boolean } | null;
    onlineStore: { enabled: boolean; data: { urlHandle: string } | null } | null;
  };
  fieldDefinitions: FieldNode[];
}

export interface FieldData {
  key: string;
  name: string;
  description?: string;
  required: boolean;
  type: string;
  validations: { name: string; value: string }[];
  adminFilterable: boolean;
}

export function normalizeMetaobjectDefinition(n: MetaobjectDefinitionNode): Item {
  const onlineStore = n.capabilities.onlineStore;
  return {
    key: n.type,
    id: n.id,
    data: compact({
      type: n.type,
      name: n.name,
      description: n.description || undefined,
      displayNameKey: n.displayNameKey || undefined,
      access: compact({
        storefront: oneOf(n.access?.storefront, STOREFRONT),
        customerAccount: oneOf(n.access?.customerAccount, CUSTOMER_ACCOUNT),
      }),
      capabilities: compact({
        publishable: n.capabilities.publishable.enabled,
        translatable: n.capabilities.translatable.enabled,
        renderable: n.capabilities.renderable?.enabled ?? false,
        onlineStore: onlineStore?.enabled ? { urlHandle: onlineStore.data?.urlHandle ?? n.type } : undefined,
      }),
      // Field order matters in the admin UI, so keep it as-is.
      fields: n.fieldDefinitions.map(
        (f): FieldData =>
          compact({
            key: f.key,
            name: f.name,
            description: f.description || undefined,
            required: f.required,
            type: f.type.name,
            validations: sortValidations(f.validations),
            adminFilterable: f.capabilities?.adminFilterable?.enabled ?? false,
          }) as FieldData,
      ),
    }),
  };
}

function capabilitiesInput(c: Record<string, unknown> | undefined) {
  if (!c) return undefined;
  const os = c.onlineStore as { urlHandle: string } | undefined;
  return {
    publishable: { enabled: Boolean(c.publishable) },
    translatable: { enabled: Boolean(c.translatable) },
    renderable: { enabled: Boolean(c.renderable) },
    onlineStore: os ? { enabled: true, data: { urlHandle: os.urlHandle } } : { enabled: false },
  };
}

function fieldInput(f: FieldData, withType: boolean) {
  return compact({
    key: f.key,
    name: f.name,
    description: f.description,
    required: f.required,
    type: withType ? f.type : undefined,
    validations: f.validations,
    capabilities: { adminFilterable: { enabled: f.adminFilterable } },
  });
}

export const metaobjectDefinitions: ResourceAdapter = {
  kind: "metaobject_definitions",
  description: "Metaobject definitions (schema), keyed by type. Fields are added or updated, never removed.",

  async fetch(client) {
    const nodes = await paginate<MetaobjectDefinitionNode>(client, QUERY, {}, (d) => d.metaobjectDefinitions);
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    for (const n of nodes) {
      const reason = reservedPrefix(n.type);
      if (reason) skipped.push({ key: n.type, reason });
      else items.push(normalizeMetaobjectDefinition(n));
    }
    return { items, skipped };
  },

  refFor(key) {
    return `${REF_PREFIX}MetaobjectDefinition/${key}`;
  },

  conflict(source, target) {
    const targetTypes = new Map((target.data.fields as FieldData[]).map((f) => [f.key, f.type]));
    const clashes = (source.data.fields as FieldData[])
      .filter((f) => targetTypes.has(f.key) && targetTypes.get(f.key) !== f.type)
      .map((f) => `${f.key} (${targetTypes.get(f.key)} in target, ${f.type} in source)`);
    return clashes.length ? `field type differs: ${clashes.join(", ")}` : undefined;
  },

  async create({ client }, _key, d) {
    const res = await client.request(
      `mutation($definition: MetaobjectDefinitionCreateInput!) {
        metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id } userErrors { field message code } }
      }`,
      {
        definition: compact({
          type: d.type,
          name: d.name,
          description: d.description,
          displayNameKey: d.displayNameKey,
          access: d.access && Object.keys(d.access).length ? d.access : undefined,
          capabilities: capabilitiesInput(d.capabilities as Record<string, unknown>),
          fieldDefinitions: (d.fields as FieldData[]).map((f) => fieldInput(f, true)),
        }),
      },
    );
    assertNoUserErrors(res.metaobjectDefinitionCreate, "metaobjectDefinitionCreate");
    return res.metaobjectDefinitionCreate.metaobjectDefinition.id;
  },

  async update({ client }, target, d) {
    const existing = new Set((target.data.fields as FieldData[]).map((f) => f.key));
    const fieldDefinitions = (d.fields as FieldData[]).map((f) =>
      existing.has(f.key) ? { update: fieldInput(f, false) } : { create: fieldInput(f, true) },
    );
    const res = await client.request(
      `mutation($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
        metaobjectDefinitionUpdate(id: $id, definition: $definition) { metaobjectDefinition { id } userErrors { field message code } }
      }`,
      {
        id: target.id,
        definition: compact({
          name: d.name,
          description: d.description,
          displayNameKey: d.displayNameKey,
          access: d.access && Object.keys(d.access).length ? d.access : undefined,
          capabilities: capabilitiesInput(d.capabilities as Record<string, unknown>),
          fieldDefinitions,
        }),
      },
    );
    assertNoUserErrors(res.metaobjectDefinitionUpdate, "metaobjectDefinitionUpdate");
  },
};
