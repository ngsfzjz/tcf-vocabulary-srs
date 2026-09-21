"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  const core = await import("../supabase/functions/_shared/lookup-core.mjs");
  assert.equal(core.normalizeTerm("  prendre   en compte  "), "prendre en compte");
  assert.throws(() => core.normalizeTerm(""));
  assert.deepEqual(core.readOpenAiResult({ output_text: JSON.stringify({ translation: "考虑到", partOfSpeech: "动词短语", collocation: "prendre en compte les besoins" }) }), {
    translation: "考虑到",
    partOfSpeech: "动词短语",
    collocation: "prendre en compte les besoins",
  });
  assert.throws(() => core.validateLookupResult({ translation: "考虑到" }));

  let handler;
  let apiKey = "test-secret-not-in-source";
  let llmCall;
  const source = fs.readFileSync(path.join(__dirname, "..", "supabase", "functions", "lookup-french", "index.ts"), "utf8")
    .replace(/^import .* from "\.\.\/_shared\/lookup-core\.mjs";\r?\n/, "");
  const context = vm.createContext({
    ...core,
    console,
    Response,
    AbortSignal,
    Set,
    JSON,
    Deno: {
      env: { get: (name) => ({ SUPABASE_URL: "https://project.supabase.co", OPENAI_API_KEY: apiKey })[name] },
      serve: (fn) => { handler = fn; },
    },
    fetch: async (url, options) => {
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1" }), { status: options.headers.Authorization.includes("valid-jwt") ? 200 : 401 });
      llmCall = { url, options };
      return new Response(JSON.stringify({ output_text: JSON.stringify({ translation: "考虑到", partOfSpeech: "动词短语", collocation: "prendre en compte les besoins" }) }), { status: 200 });
    },
  });
  vm.runInContext(source, context, { filename: "lookup-french/index.ts" });

  const request = (token, method = "POST") => ({
    method,
    headers: new Headers({ Origin: "https://ngsfzjz.github.io", Authorization: `Bearer ${token}`, apikey: "sb_publishable_test" }),
    json: async () => ({ term: "prendre en compte" }),
  });
  const preflight = await handler(request("", "OPTIONS"));
  assert.equal(preflight.status, 204);
  const denied = await handler(request("bad-jwt"));
  assert.equal(denied.status, 401);
  assert.equal(llmCall, undefined);
  const response = await handler(request("valid-jwt"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).translation, "考虑到");
  assert.equal(llmCall.url, "https://api.openai.com/v1/responses");
  assert.equal(JSON.parse(llmCall.options.body).input, "prendre en compte");
  assert.equal(JSON.parse(llmCall.options.body).store, false);
  apiKey = "";
  const missingKey = await handler(request("valid-jwt"));
  assert.equal(missingKey.status, 503);
  console.log("Lookup Edge Function: all assertions passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
