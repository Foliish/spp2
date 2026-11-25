import { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } from "@apollo/gateway";
import { listen } from "./service.js";

const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({ subgraphs: [
    { name: "catalog", url: process.env.CATALOG_URL || "http://127.0.0.1:3115/graphql" },
    { name: "collection", url: process.env.COLLECTION_URL || "http://127.0.0.1:3116/graphql" },
  ] }),
  buildService({ url }) {
    return new RemoteGraphQLDataSource({
      url,
      fetcher: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(2500) }),
      willSendRequest({ request, context }) {
        if (context.traceId) request.http.headers.set("x-trace-id", context.traceId);
        if (context.span) request.http.headers.set("x-parent-span", context.span);
        if (context.owner) request.http.headers.set("x-collection", context.owner);
      },
    });
  },
});
await listen({ name: "gateway", port: Number(process.env.PORT ?? 3105), gateway, publicSite: true });
