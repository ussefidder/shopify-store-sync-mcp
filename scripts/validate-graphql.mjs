#!/usr/bin/env node
// Validate every GraphQL operation in src/ against Shopify's published Admin API schema.
// The schema comes from the @shopify/dev-mcp package, which bundles introspection results per version.
//
//   node scripts/validate-graphql.mjs [api-version]     (default 2026-10)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";

const version = process.argv[2] ?? "2026-10";
const cache = join(tmpdir(), "shopify-store-sync-schema");

function schemaFile() {
  const pkg = join(cache, "package", "dist", "data");
  if (!existsSync(pkg)) {
    mkdirSync(cache, { recursive: true });
    const tgz = execFileSync("npm", ["pack", "@shopify/dev-mcp", "--silent"], { cwd: cache }).toString().trim().split("\n").pop();
    execFileSync("tar", ["-xzf", tgz, "package/dist/data"], { cwd: cache });
  }
  const gz = join(pkg, `admin_${version}.json.gz`);
  if (!existsSync(gz)) {
    const available = readdirSync(pkg).filter((f) => /^admin_\d{4}-\d{2}\.json\.gz$/.test(f)).map((f) => f.slice(6, 13));
    throw new Error(`no bundled schema for ${version}; available: ${available.join(", ")}`);
  }
  return gz;
}

const introspection = JSON.parse(gunzipSync(readFileSync(schemaFile())).toString());
const schema = buildClientSchema(introspection.data);

// Values for template interpolations used inside operations.
const subs = { PAGE_INFO: "pageInfo { hasNextPage endCursor }", ITEM_FIELDS: "title type url resourceId tags", size: "5" };
// Operations built with a dynamic field name are validated once per possible value.
const variants = { field: ["pages", "blogs"], owner: ["products", "collections"] };

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

let count = 0;
let failed = 0;
for (const file of walk(new URL("../src", import.meta.url).pathname)) {
  const src = readFileSync(file, "utf8");
  // Constants defined in the same file (a shared selection set, a page size) are substituted too.
  const local = { ...subs };
  for (const c of src.matchAll(/const (\w+) = (?:\/\* GraphQL \*\/ )?`([^`]*)`;/g)) local[c[1]] = c[2];
  for (const c of src.matchAll(/const (\w+) = (\d+);/g)) local[c[1]] = c[2];
  const expand = (t, depth = 0) =>
    t.replace(/\$\{(\w+)\}/g, (_, k) => {
      if (!(k in local)) throw new Error(`${file}: unknown interpolation \${${k}}; add it to scripts/validate-graphql.mjs`);
      return depth < 3 ? expand(local[k], depth + 1) : local[k];
    });
  for (const m of src.matchAll(/`(\s*(?:query|mutation)\b[\s\S]*?)`/g)) {
    let docs = [m[1]];
    for (const [name, values] of Object.entries(variants)) {
      docs = docs.flatMap((d) => (d.includes(`\${${name}}`) ? values.map((v) => d.replaceAll(`\${${name}}`, v)) : [d]));
    }
    for (const raw of docs) {
      const doc = expand(raw);
      count++;
      const errors = validate(schema, parse(doc));
      if (errors.length) {
        failed++;
        console.error(`\n✗ ${file}\n${doc.trim().split("\n")[0]}\n  ${errors.map((e) => e.message).join("\n  ")}`);
      }
    }
  }
}

console.log(`Admin API ${version}: ${count} operations checked, ${failed} invalid`);
process.exit(failed ? 1 : 0);
