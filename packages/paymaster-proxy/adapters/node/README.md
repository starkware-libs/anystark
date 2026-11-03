# Node / fetch adapter

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

A runtime-agnostic adapter for any platform that speaks the Web Fetch API
(`Request` -> `Response`): Node 20+, Cloud Run, Bun, Deno, or a framework like
Hono or Fastify (with its web-fetch shim). Unlike the Vercel and Cloudflare
adapters, this one is not tied to a platform entry-point convention. It exposes
a factory that returns a standard fetch handler you mount however your runtime
mounts one.

`createPaymasterProxyHandler(env?)` reads config from `env` (default
`process.env`) via `configFromEnv`, memoizes it per handler instance (parsed once
on the first request), and returns a `(request: Request) => Promise<Response>`
that rejects non-POST with 405, returns a generic 500 on misconfiguration or
unexpected runtime error, and otherwise forwards to `handlePaymasterRequest`.

Each factory call owns its own config, so two handlers built with different envs
never share a sponsorship key / policy / budget.

## HTTP status semantics

Only transport-level problems use non-200 statuses: a non-POST method returns
405, and a misconfiguration or unexpected runtime error returns a generic 500
(no error message, stack, key, or upstream URL is included in the body). A
misconfiguration includes a `PAYMASTER_POLICY` that does not sponsor the deploy
class hash pinned by the installed `@starkware-libs/anystark-core` (the startup
version-skew guard), which returns the same generic 500. Every application-level
outcome, including policy denials, rate-limit rejections, and invalid params, is
returned with HTTP 200 and a JSON-RPC error body, per the usual JSON-RPC
convention (the HTTP transport succeeded, the RPC call did not).

## Request body size

The adapter reads the full request body with no size limit; fetch runtimes do
not all cap it. On bare Node / Deno / Bun you should enforce a request body-size
cap at the edge (your gateway, load balancer, or Cloud Run ingress) to avoid
unbounded memory use from a hostile client.

## Environment variables

Same contract as the other adapters (all read by `configFromEnv`):

- `PAYMASTER_API_KEY` - **required**, the secret upstream key.
- `PAYMASTER_POLICY` - **required**, the sponsorship policy as JSON. Its
  `sponsoredClassHashes` must include the deploy class hash pinned by the installed
  `@starkware-libs/anystark-core`; the startup version-skew guard fails closed (a
  generic 500) otherwise. Generate the policy with the policy generator against the
  installed core so this holds by construction.
- `PAYMASTER_UPSTREAM_URL` - optional, defaults to the AVNU Sepolia paymaster.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` - optional; required (or
  `policy.allowInMemoryStore`) if the policy sets a `rateLimit` / `globalCap`,
  otherwise `configFromEnv` throws (fail closed) and the handler returns 500.

## Hono (Cloud Run, Node 20+)

```ts
import { Hono } from "hono";
import { createPaymasterProxyHandler } from "@starkware-libs/anystark-paymaster-proxy/node";

const app = new Hono();
const paymaster = createPaymasterProxyHandler();
app.all("/paymaster", (c) => paymaster(c.req.raw));

export default app;
```

Point the SDK's `PaymasterRpc({ nodeUrl: "https://<your-service>/paymaster" })`
at that route.

## Bun / plain fetch runtime

```ts
import { createPaymasterProxyHandler } from "@starkware-libs/anystark-paymaster-proxy/node";

// Bun / Node / Cloud Run: process.env is available, so the default works.
const paymaster = createPaymasterProxyHandler();
Bun.serve({ fetch: (request) => paymaster(request) });
```

```ts
// Deno: there is no `process` global, so pass an explicit env object.
import {
  createPaymasterProxyHandler,
  type ProxyEnv,
} from "@starkware-libs/anystark-paymaster-proxy/node";

const paymaster = createPaymasterProxyHandler(Deno.env.toObject() as ProxyEnv);
export default { fetch: (request: Request) => paymaster(request) };
```
