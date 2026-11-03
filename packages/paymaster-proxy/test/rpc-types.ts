// Shape of a JSON-RPC error body, to narrow `unknown`/parsed JSON in adapter
// test assertions without reaching for `any`.
export type RpcErrorBody = {
  jsonrpc: string;
  id: unknown;
  error: { code: number; message: string };
};
