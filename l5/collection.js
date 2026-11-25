import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { GraphQLError, parse } from "graphql";
import { listen } from "./service.js";

const dir = process.env.DATA_DIR || "data";
await mkdir(dir, { recursive: true });
const db = new DatabaseSync(join(dir, "collection.sqlite"));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS saved (owner TEXT, id TEXT, added INTEGER, PRIMARY KEY(owner, id))`);
const find = db.prepare("SELECT 1 FROM saved WHERE owner=? AND id=?");
const list = db.prepare("SELECT id FROM saved WHERE owner=? ORDER BY added DESC, id LIMIT 30");
const count = db.prepare("SELECT count(*) AS n FROM saved WHERE owner=?");
const add = db.prepare("INSERT OR IGNORE INTO saved VALUES (?, ?, ?)");
const drop = db.prepare("DELETE FROM saved WHERE owner=? AND id=?");

const schema = buildSubgraphSchema([{
  typeDefs: parse(`
    extend schema @link(url: "https://specs.apollo.dev/federation/v2.7", import: ["@key"])
    type Entry @key(fields: "id") { id: ID!, savedByMe: Boolean }
    type Query { savedEntries: [Entry]! }
    type Mutation { setSaved(id: ID!, save: Boolean!): Entry! }
  `),
  resolvers: {
    Query: { savedEntries: (_, __, { owner }) => owner ? list.all(owner) : [] },
    Mutation: {
      setSaved: (_, { id, save }, { owner }) => {
        if (!owner || !/^(MOVIELENS|TVMAZE|DATASF):[a-zA-Z0-9_.~-]{1,80}$/.test(id)) {
          throw new GraphQLError("Требуется ключ коллекции и корректный ID", { extensions: { code: "BAD_USER_INPUT" } });
        }
        if (save && !find.get(owner, id) && count.get(owner).n >= 30) {
          throw new GraphQLError("В избранном может быть до 30 записей", { extensions: { code: "BAD_USER_INPUT" } });
        }
        if (save) add.run(owner, id, Date.now());
        else drop.run(owner, id);
        return { id };
      },
    },
    Entry: {
      __resolveReference: ({ id }) => ({ id }),
      savedByMe: ({ id }, _, { owner }) => Boolean(owner && find.get(owner, id)),
    },
  },
}]);

await listen({ name: "collection", port: Number(process.env.PORT ?? 3116), schema });
