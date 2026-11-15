import type { ResourceKind } from "./resources/types.js";

/*
 * "As drafts": the published state is left out of what is compared and copied, so syncing
 * content never makes something visible (or hides it) on the target's storefront.
 *
 *   pages        `isPublished` is dropped. A new page is created hidden.
 *   metaobjects  `status` is replaced by `publishable: true`. A new entry is created as a draft.
 *
 * Existing pages and entries keep whatever state they have in the target. Products are always
 * created as drafts and collections are never published to a sales channel, with or without this.
 */
export function draftView(kind: ResourceKind, data: Record<string, unknown>): Record<string, unknown> {
  if (kind === "pages" && "isPublished" in data) {
    const { isPublished: _state, ...rest } = data;
    return rest;
  }
  if (kind === "metaobjects" && data.status !== undefined) {
    const { status: _state, ...rest } = data;
    return { ...rest, publishable: true };
  }
  return data;
}
