import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { GraphQLError, parse } from "graphql";
import { sources } from "./sources.js";
import { listen } from "./service.js";

const dir = process.env.DATA_DIR || "data";
await mkdir(dir, { recursive: true });
const sourceState = new Map();
const cache = new Map();
const orders = {
  TITLE_ASC: (a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
  NEWEST: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  RATING: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
};
const sourceMap = new Map(sources.map(source => [source.id, source]));
const location = source => join(dir, source.id + ".json");
for (const source of sources) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(location(source), "utf8"));
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length < source.minimum || !snapshot.updatedAt) {
      throw new Error("Invalid snapshot");
    }
  } catch (error) {
    snapshot = undefined;
    if (error.code !== "ENOENT") console.error(JSON.stringify({ event: "snapshot_error", source: source.id, message: error.message }));
  }
  sourceState.set(source.id, { rows: snapshot?.rows || [], updatedAt: snapshot?.updatedAt, error: null });
}

const normalize = value => value.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase();
let byId, listings, genres;
function rebuild() {
  const rows = [...sourceState.values()].flatMap(snapshot => snapshot.rows);
  byId = new Map(rows.map(row => [row.id, row]));
  listings = Object.fromEntries(Object.entries(orders).map(([key, cmp]) => [
    key, [...rows].sort((a, b) => cmp(a, b) || a.id.localeCompare(b.id)),
  ]));
  genres = [...new Set(rows.flatMap(row => row.genres))].sort();
  for (const row of rows) {
    row.search = normalize([row.title, row.details?.location, row.details?.director,
      ...(row.details?.cast || [])].filter(Boolean).join(" "));
  }
  cache.clear();
}
rebuild();

let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    await Promise.all(sources.map(async source => {
      const existing = sourceState.get(source.id);
      const refreshMs = Number(process.env.REFRESH_MS || 6 * 60 * 60 * 1000);
      if (!existing.error && Date.now() - Date.parse(existing.updatedAt) < refreshMs) return;
      try {
        const imported = await source.load();
        const rows = [...new Map(imported.filter(row => row.id && row.title).map(row => [row.id, row])).values()];
        if (rows.length < source.minimum) throw new Error("Only " + rows.length + " valid rows");
        const snapshot = { rows, updatedAt: new Date().toISOString(), error: null };
        await writeFile(location(source) + ".tmp", JSON.stringify(snapshot));
        await rename(location(source) + ".tmp", location(source));
        sourceState.set(source.id, snapshot);
        rebuild();
        console.log(JSON.stringify({ event: "import", source: source.id, rows: rows.length, at: snapshot.updatedAt }));
      } catch (error) {
        existing.error = "Источник временно недоступен";
        console.error(JSON.stringify({ event: "import_error", source: source.id, message: error.message }));
      }
    }));
  } finally {
    syncing = false;
  }
}

const schema = buildSubgraphSchema([{
  typeDefs: parse(`
    extend schema @link(url: "https://specs.apollo.dev/federation/v2.7", import: ["@key"])
    enum Kind { MOVIE SERIES LOCATION }
    enum SourceId { MOVIELENS TVMAZE DATASF }
    enum EntryOrder { TITLE_ASC NEWEST RATING }
    input EntryFilter { text: String, kind: Kind, source: SourceId, genre: String, year: Int }
    type Publisher { name: String!, url: String! }
    type Source { id: SourceId!, name: String!, url: String!, publisher: Publisher!, count: Int!, updatedAt: String, error: String }
    type Details { ratingCount: Int, language: String, network: String, country: String, status: String,
      location: String, neighborhood: String, director: String, cast: [String!] }
    type Entry @key(fields: "id") {
      id: ID!, title: String!, year: Int, kind: Kind!, genres: [String!]!, rating: Float, url: String,
      source: Source!, details: Details
    }
    type EntryPage { items: [Entry!]!, total: Int!, page: Int!, pages: Int! }
    type CatalogStatus { count: Int!, syncing: Boolean!, sources: [Source!]!, genres: [String!]! }
    type Query {
      catalog: CatalogStatus!
      entry(id: ID!): Entry
      entries(filter: EntryFilter, order: EntryOrder! = TITLE_ASC, page: Int! = 1, size: Int! = 15): EntryPage!
    }
  `),
  resolvers: {
    Query: {
      catalog: () => ({ count: byId.size, syncing, sources, genres }),
      entry: (_, { id }) => byId.get(id),
      entries: (_, { filter, order, page, size }) => {
        if (page < 1 || size < 1 || size > 50 || page > 10_000 || (filter?.text?.length ?? 0) > 100 ||
            (filter?.genre?.length ?? 0) > 80) {
          throw new GraphQLError("Некорректная страница или фильтр", { extensions: { code: "BAD_USER_INPUT" } });
        }
        const { kind, source, year, genre, text } = filter || {};
        const search = normalize(text?.trim() || "");
        const key = JSON.stringify([order, kind, source, year, genre, search]);
        let rows = cache.get(key);
        if (!rows) {
          rows = listings[order].filter(row => (!kind || row.kind === kind) && (!source || row.id.startsWith(source + ":")) &&
            (!year || row.year === year) && (!genre || row.genres.includes(genre)) && (!search || row.search.includes(search)));
          if (cache.size >= 96) cache.delete(cache.keys().next().value);
          cache.set(key, rows);
        }
        return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page, pages: Math.ceil(rows.length / size) };
      },
    },
    Entry: { __resolveReference: ({ id }) => byId.get(id),
      source: row => sourceMap.get(row.id.split(":")[0]) },
    Source: {
      count: source => sourceState.get(source.id).rows.length,
      updatedAt: source => sourceState.get(source.id).updatedAt,
      error: source => sourceState.get(source.id).error,
    },
  },
}]);

await listen({ name: "catalog", port: Number(process.env.PORT ?? 3115), schema });
if (process.env.DISABLE_IMPORT !== "1") {
  void sync();
  setInterval(sync, Number(process.env.IMPORT_TICK_MS || 60_000)).unref();
}
