import { collections } from "./collections.js";
import { menus } from "./menus.js";
import { metafields } from "./metafields.js";
import { metafieldDefinitions } from "./metafieldDefinitions.js";
import { metaobjectDefinitions } from "./metaobjectDefinitions.js";
import { metaobjects } from "./metaobjects.js";
import { pages } from "./pages.js";
import { redirects } from "./redirects.js";
import { shopPolicies } from "./shopPolicies.js";
import { translations } from "./translations.js";
import { RESOURCE_KINDS, type ResourceAdapter, type ResourceKind } from "./types.js";

/** Apply order matters: definitions before entries, entries before the menus that link to them. */
export const ADAPTERS: Record<ResourceKind, ResourceAdapter> = {
  metafield_definitions: metafieldDefinitions,
  metaobject_definitions: metaobjectDefinitions,
  collections,
  pages,
  shop_policies: shopPolicies,
  metaobjects,
  menus,
  redirects,
  metafields,
  translations,
};

export function orderKinds(kinds: readonly ResourceKind[]): ResourceKind[] {
  return RESOURCE_KINDS.filter((k) => kinds.includes(k));
}

export * from "./types.js";
