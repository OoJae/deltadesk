// Conformance test for the x402 handlers: every path must return a Web Response (x402 Cloud 500s on anything else and
// then cannot settle). Runs each handler against a mocked upstream API.  node --experimental-strip-types x402/tests/handlers.test.mjs
import assert from "node:assert/strict";

process.env.DELTADESK_API = "https://upstream.test";
process.env.DELTADESK_API_KEY = "test-key";
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), key: init?.headers?.["x-deltadesk-key"] });
  if (String(url).includes("/fail/") || String(url).includes("wallet=0x" + "f".repeat(40))) return new Response("boom", { status: 503 });
  return new Response(JSON.stringify({ ok: true, url: String(url) }), { status: 200, headers: { "content-type": "application/json" } });
};

const cases = [
  ["safe-to-lp", "?pool=NVDA", 200, "/safe-to-lp/NVDA"],
  ["safe-to-lp", "?pool=DOGE", 400],
  ["fair-value", "?pool=SPY", 200, "/fair-value/SPY"],
  ["pool-toxicity", "?pool=TSLA", 200, "/pool-toxicity/TSLA"],
  ["lp-league", "?limit=5", 200, "/lp-league"],
  ["tearsheet", `?wallet=0x${"a".repeat(40)}&chain=base&role=owner`, 200, `/tearsheet/base/0x${"a".repeat(40)}?role=owner`],
  ["tearsheet", "?wallet=nope", 400],
  ["tearsheet", `?wallet=0x${"a".repeat(40)}&chain=solana`, 400],
];
let n = 0;
for (const [svc, qs, status, path] of cases) {
  const { default: handler } = await import(`../${svc}/index.ts`);
  calls.length = 0;
  const res = await handler(new Request(`https://x402.test/${svc}${qs}`));
  assert.ok(res instanceof Response, `${svc}${qs}: handler must return a Response, got ${typeof res}`);
  assert.equal(res.status, status, `${svc}${qs}: status`);
  const body = await res.json();
  if (status === 200) {
    assert.ok(body.ok, `${svc}: body passed through`);
    assert.ok(calls[0].url.includes(path), `${svc}: upstream path ${calls[0].url}`);
    assert.equal(calls[0].key, "test-key", `${svc}: premium key forwarded`);
  } else {
    assert.ok(body.error, `${svc}${qs}: error body`);
  }
  n++;
}
console.log(`x402 handlers: ${n} cases passed`);
