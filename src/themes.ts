import { diffValues, matchesFilter, type FieldChange } from "./diff.js";
import type { AdminClient } from "./shopify/client.js";

/*
 * Read-only comparison of theme configuration between two stores: JSON templates, section
 * groups and config/settings_data.json. Nothing is ever written to a theme.
 * Needs the read_themes scope.
 */

export const DEFAULT_THEME_FILES = ["templates/*.json", "sections/*.json", "config/settings_data.json"];

export interface ThemeRef {
  id: string;
  name: string;
  role: string;
}

export interface ThemeFileDiff {
  file: string;
  changes: FieldChange[];
}

export interface ThemeDiff {
  source: ThemeRef;
  target: ThemeRef;
  onlyInSource: string[];
  onlyInTarget: string[];
  changed: ThemeFileDiff[];
  identical: number;
  unreadable: string[];
}

/** Resolve "main" (the live theme) or a theme id / numeric id. */
export async function findTheme(client: AdminClient, spec = "main"): Promise<ThemeRef> {
  if (spec === "main") {
    const d = await client.request<{ themes: { nodes: ThemeRef[] } }>(`query { themes(roles: [MAIN], first: 1) { nodes { id name role } } }`);
    const theme = d.themes.nodes[0];
    if (!theme) throw new Error(`${client.store.alias}: no published theme found`);
    return theme;
  }
  const id = spec.startsWith("gid://") ? spec : `gid://shopify/OnlineStoreTheme/${spec}`;
  const d = await client.request<{ theme: ThemeRef | null }>(`query($id: ID!) { theme(id: $id) { id name role } }`, { id });
  if (!d.theme) throw new Error(`${client.store.alias}: theme ${spec} not found`);
  return d.theme;
}

/** Theme JSON files may start with a comment block that JSON.parse rejects. */
export function parseThemeJson(text: string): unknown {
  return JSON.parse(text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
}

const FILES_QUERY = /* GraphQL */ `
  query ThemeFiles($id: ID!, $filenames: [String!], $after: String) {
    theme(id: $id) {
      files(first: 50, filenames: $filenames, after: $after) {
        nodes {
          filename
          body { ... on OnlineStoreThemeFileBodyText { content } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export async function readThemeFiles(client: AdminClient, themeId: string, patterns: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let after: string | null = null;
  do {
    const d: any = await client.request(FILES_QUERY, { id: themeId, filenames: patterns, after });
    const conn = d.theme?.files;
    if (!conn) break;
    for (const n of conn.nodes as { filename: string; body: { content?: string } }[]) {
      if (typeof n.body?.content === "string") files.set(n.filename, n.body.content);
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return files;
}

export async function diffThemes(
  source: AdminClient,
  target: AdminClient,
  opts: { sourceTheme?: string; targetTheme?: string; files?: string[]; exclude?: string[] } = {},
): Promise<ThemeDiff> {
  const patterns = opts.files?.length ? opts.files : DEFAULT_THEME_FILES;
  const [st, tt] = await Promise.all([findTheme(source, opts.sourceTheme), findTheme(target, opts.targetTheme)]);
  const [sf, tf] = await Promise.all([readThemeFiles(source, st.id, patterns), readThemeFiles(target, tt.id, patterns)]);
  const keep = (f: string) => matchesFilter(f, { include: patterns, exclude: opts.exclude });

  const result: ThemeDiff = { source: st, target: tt, onlyInSource: [], onlyInTarget: [], changed: [], identical: 0, unreadable: [] };
  for (const [file, text] of [...sf].sort(([a], [b]) => a.localeCompare(b))) {
    if (!keep(file)) continue;
    const other = tf.get(file);
    if (other === undefined) {
      result.onlyInSource.push(file);
      continue;
    }
    let changes: FieldChange[];
    try {
      changes = diffValues(parseThemeJson(text), parseThemeJson(other));
    } catch {
      result.unreadable.push(file);
      continue;
    }
    if (changes.length) result.changed.push({ file, changes });
    else result.identical++;
  }
  for (const file of [...tf.keys()].sort()) if (keep(file) && !sf.has(file)) result.onlyInTarget.push(file);
  return result;
}
