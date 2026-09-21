"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  let handler;
  let apiKey = "test-secret-not-in-source";
  let llmCall;
  const source = fs.readFileSync(path.join(__dirname, "..", "supabase", "functions", "lookup-french", "index.ts"), "utf8");
  const context = vm.createContext({
    console,
    Response,
    AbortSignal,
    Set,
    JSON,
    Deno: {
      env: { get: (name) => ({ SUPABASE_URL: "https://project.supabase.co", DEEPSEEK_API_KEY: apiKey })[name] },
      serve: (fn) => { handler = fn; },
    },
    fetch: async (url, options) => {
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1" }), { status: options.headers.Authorization.includes("valid-jwt") ? 200 : 401 });
      llmCall = { url, options };
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ translation: "考虑到", partOfSpeech: "动词短语", collocation: "prendre en compte les besoins" }) }] }] }), { status: 200 });
    },
  });
  vm.runInContext(source, context, { filename: "lookup-french/index.ts" });
  const normalizeTerm = vm.runInContext("normalizeTerm", context);
  const validateLookupResult = vm.runInContext("validateLookupResult", context);
  const readDeepSeekResult = vm.runInContext("readDeepSeekResult", context);
  assert.equal(normalizeTerm("  prendre   en compte  "), "prendre en compte");
  assert.throws(() => normalizeTerm(""));
  const parsed = readDeepSeekResult({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ translation: "考虑到", partOfSpeech: "动词短语", collocation: "prendre en compte les besoins" }) }] }] });
  assert.equal(JSON.stringify(parsed), JSON.stringify({ translation: "考虑到", partOfSpeech: "动词短语", collocation: "prendre en compte les besoins" }));
  assert.throws(() => validateLookupResult({ translation: "考虑到" }));
  assert.throws(() => validateLookupResult({ translation: "考虑到", partOfSpeech: "动词短语", collocation: "prendre en compte les besoins", extra: "不允许" }));
  assert.throws(() => readDeepSeekResult({ status: "incomplete", output: [] }));

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
  assert.equal(llmCall.url, "https://api.deepseek.com/responses");
  const llmBody = JSON.parse(llmCall.options.body);
  assert.equal(llmBody.input, "prendre en compte");
  assert.equal(llmBody.model, "deepseek-flash");
  assert.equal(llmBody.reasoning.effort, "none");
  assert.equal(llmBody.text.format.type, "json_schema");
  assert.deepEqual(llmBody.text.format.schema.required, ["translation", "partOfSpeech", "collocation"]);
  assert.equal(llmBody.text.format.schema.additionalProperties, false);
  apiKey = "";
  const missingKey = await handler(request("valid-jwt"));
  assert.equal(missingKey.status, 503);
  console.log("Lookup Edge Function: all assertions passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
