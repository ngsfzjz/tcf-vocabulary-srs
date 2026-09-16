"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const context = vm.createContext({
  console,
  Date,
  Intl,
  crypto: require("node:crypto").webcrypto,
  document: { addEventListener() {} },
  window: {},
});
vm.runInContext(source, context, { filename: "app.js" });

const reviewedAt = new Date("2026-09-16T12:00:00.000Z");
let word = {
  mastery: 0,
  streak: 0,
  reviewCount: 0,
  errorCount: 0,
  createdAt: reviewedAt.toISOString(),
};

let update = context.getSrsUpdate(word, "correct", reviewedAt);
assert.deepEqual([update.mastery, update.streak, update.intervalDays], [2, 1, 3]);
update = context.getSrsUpdate(update, "correct", reviewedAt);
assert.deepEqual([update.mastery, update.streak, update.intervalDays], [3, 2, 7]);
update = context.getSrsUpdate(update, "correct", reviewedAt);
assert.deepEqual([update.mastery, update.streak, update.intervalDays], [3, 3, 14]);
update = context.getSrsUpdate(update, "correct", reviewedAt);
assert.deepEqual([update.mastery, update.streak, update.intervalDays], [3, 4, 30]);

const failed = context.getSrsUpdate(update, "fail", reviewedAt);
assert.deepEqual([failed.mastery, failed.streak, failed.intervalDays], [0, 0, 1]);
assert.equal(failed.errorCount, 1);

const slow = context.getSrsUpdate(word, "slow", reviewedAt);
assert.deepEqual([slow.mastery, slow.streak, slow.intervalDays], [1, 0, 2]);

console.log("SRS rules: all assertions passed");
