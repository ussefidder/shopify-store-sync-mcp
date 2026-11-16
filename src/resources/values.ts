/** A decimal number written without trailing zeros ("0.40" → "0.4", "12.0" → "12"); anything else unchanged. */
export function canonicalDecimal<T>(v: T): T {
  if (typeof v !== "string" || !/^-?\d+\.\d+$/.test(v)) return v;
  return v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") as T;
}

