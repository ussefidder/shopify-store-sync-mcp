import { catalogs } from "./catalogs.js";
import { collections } from "./collections.js";
import { discounts } from "./discounts.js";
import { locations } from "./locations.js";
import { markets } from "./markets.js";
import { menus } from "./menus.js";
import { metafields } from "./metafields.js";
import { metafieldDefinitions } from "./metafieldDefinitions.js";
import { metaobjectDefinitions } from "./metaobjectDefinitions.js";
import { metaobjects } from "./metaobjects.js";
import { pages } from "./pages.js";
import { products } from "./products.js";
import { redirects } from "./redirects.js";
import { salesChannels } from "./salesChannels.js";
import { shopPolicies } from "./shopPolicies.js";
import { translations } from "./translations.js";
import { RESOURCE_KINDS, type ResourceAdapter, type ResourceKind } from "./types.js";

/** Apply order matters: definitions before entries, entries before the menus that link to them. */
export const ADAPTERS: Record<ResourceKind, ResourceAdapter> = {
  metafield_definitions: metafieldDefinitions,
  metaobject_definitions: metaobjectDefinitions,
  locations,
  markets,
  products,
  collections,
  catalogs,
  pages,
  shop_policies: shopPolicies,
  metaobjects,
  menus,
  redirects,
  metafields,
  sales_channels: salesChannels,
  translations,
  discounts,
};

export function orderKinds(kinds: readonly ResourceKind[]): ResourceKind[] {
  return RESOURCE_KINDS.filter((k) => kinds.includes(k));
}

export * from "./types.js";
