/*
 * Converting a metafield value from one type to another, for the type_mismatch option:
 * a single value into a list of one (X -> list.X), a list of one back into a single value
 * (list.X -> X), and between single-line and multi-line text. Anything else is refused with a
 * reason, so a value is never written in a shape its definition doesn't accept.
 */

export type Conversion = { value: string } | { error: string };

const TEXT = new Set(["single_line_text_field", "multi_line_text_field"]);
/** Types whose value is a JSON object (dimension, volume, weight, rating, money...). */
const OBJECT_TYPES = new Set(["dimension", "volume", "weight", "rating", "money"]);
/** Types that have no list form in Shopify. */
const NOT_LISTABLE = new Set(["boolean", "json", "rich_text_field", "money", "multi_line_text_field", "id", "link"]);

const base = (t: string) => (t.startsWith("list.") ? t.slice(5) : t);
const isList = (t: string) => t.startsWith("list.");

function element(value: string, type: string): unknown {
  if (type === "number_integer") return Number(value);
  if (OBJECT_TYPES.has(type)) return JSON.parse(value);
  return value;
}

function single(el: unknown): string {
  if (typeof el === "string") return el;
  if (typeof el === "number") return String(el);
  return JSON.stringify(el);
}

function textOk(value: string, to: string): Conversion {
  if (to === "single_line_text_field" && /[\r\n]/.test(value)) return { error: "the text has line breaks, which a single-line text field can't hold" };
  return { value };
}

export function convertValue(value: string, from: string, to: string): Conversion {
  if (from === to) return { value };
  const [fb, tb] = [base(from), base(to)];
  const textPair = TEXT.has(fb) && TEXT.has(tb);
  if (fb !== tb && !textPair) return { error: `${from} can't be converted to ${to}` };

  // Single -> single (text kinds only).
  if (!isList(from) && !isList(to)) return textOk(value, to);

  // Single -> list.
  if (!isList(from) && isList(to)) {
    if (NOT_LISTABLE.has(tb)) return { error: `${tb} has no list form` };
    const t = textOk(value, tb);
    if ("error" in t) return t;
    try {
      return { value: JSON.stringify([element(value, tb)]) };
    } catch {
      return { error: `the value isn't valid ${fb}` };
    }
  }

  // List -> single or list -> list.
  let items: unknown[];
  try {
    items = JSON.parse(value) as unknown[];
    if (!Array.isArray(items)) throw new Error();
  } catch {
    return { error: `the value isn't a valid ${from}` };
  }
  if (isList(to)) {
    for (const i of items) {
      const t = textOk(single(i), tb);
      if ("error" in t) return t;
    }
    return { value: JSON.stringify(items) };
  }
  if (items.length !== 1) return { error: `${items.length} values can't fit in one ${to}` };
  return textOk(single(items[0]), to);
}
