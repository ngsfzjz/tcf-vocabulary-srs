"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const context = vm.createContext({
  console,
  Date,
  Intl,
  URLSearchParams,
  Headers,
  crypto: webcrypto,
  setTimeout,
  clearTimeout,
  document: { addEventListener() {}, querySelector() { return null; } },
  navigator: { onLine: true },
  location: { hash: "", origin: "https://example.test", pathname: "/tcf-vocabulary-srs/", search: "" },
  history: { replaceState() {} },
  window: { MOT_JUSTE_SUPABASE: { url: "https://example.supabase.co", publishableKey: "sb_publishable_test" } },
});

vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8"), context, { filename: "app.js" });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "sync.js"), "utf8"), context, { filename: "sync.js" });

const { mergeDatasets, recomputeSrs } = context.window.MotJusteSyncTest;
const base = {
  term: "partager",
  translation: "分享",
  normalized: "partager",
  createdAt: "2026-09-01T08:00:00.000Z",
  createdDate: "2026-09-01",
  updatedAt: "2026-09-01T08:00:00.000Z",
  deletedAt: null,
  mastery: 0,
  reviewCount: 0,
  errorCount: 0,
  streak: 0,
  lastResult: null,
  lastReviewedAt: null,
  nextReviewAt: null,
};

// Same normalized term from two devices: retain the cloud UUID, keep the newer edit,
// and move the local review to the canonical word before upload.
const localWord = { ...base, id: "11111111-1111-4111-8111-111111111111", translation: "共同分享", updatedAt: "2026-09-03T08:00:00.000Z", syncState: "pending" };
const cloudWord = { ...base, id: "22222222-2222-4222-8222-222222222222", syncState: "synced" };
const localReview = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", wordId: localWord.id, result: "correct", reviewedAt: "2026-09-04T08:00:00.000Z", reviewedDate: "2026-09-04", syncState: "pending" };
const mergedDuplicate = mergeDatasets([localWord], [localReview], [cloudWord], []);
assert.equal(mergedDuplicate.words.length, 1);
assert.equal(mergedDuplicate.words[0].id, cloudWord.id);
assert.equal(mergedDuplicate.words[0].translation, "共同分享");
assert.equal(mergedDuplicate.reviews[0].wordId, cloudWord.id);
assert.equal(mergedDuplicate.pendingWords.length, 1);
assert.equal(mergedDuplicate.pendingReviews.length, 1);

// A tombstone always wins over a non-deleted offline copy, preventing resurrection.
const deletedCloud = { ...cloudWord, deletedAt: "2026-09-05T08:00:00.000Z", updatedAt: "2026-09-05T08:00:00.000Z" };
const editedOffline = { ...localWord, updatedAt: "2026-09-06T08:00:00.000Z", deletedAt: null };
const mergedDelete = mergeDatasets([editedOffline], [], [deletedCloud], []);
assert.equal(mergedDelete.words[0].deletedAt, "2026-09-05T08:00:00.000Z");

// Independent words and reviews are unioned; review UUIDs are deduplicated.
const anotherWord = { ...base, id: "33333333-3333-4333-8333-333333333333", term: "pourtant", normalized: "pourtant", translation: "然而" };
const remoteReview = { ...localReview, wordId: cloudWord.id, syncState: "synced" };
const union = mergeDatasets([localWord, anotherWord], [localReview], [cloudWord], [remoteReview]);
assert.equal(union.words.length, 2);
assert.equal(union.reviews.length, 1);

// SRS is derived from the complete ordered review history after both devices merge.
const history = [
  { id: "00000000-0000-4000-8000-000000000001", wordId: cloudWord.id, result: "correct", reviewedAt: "2026-09-10T08:00:00.000Z" },
  { id: "00000000-0000-4000-8000-000000000002", wordId: cloudWord.id, result: "correct", reviewedAt: "2026-09-11T08:00:00.000Z" },
  { id: "00000000-0000-4000-8000-000000000003", wordId: cloudWord.id, result: "fail", reviewedAt: "2026-09-12T08:00:00.000Z" },
];
const [recomputed] = recomputeSrs([cloudWord], history);
assert.deepEqual([recomputed.mastery, recomputed.streak, recomputed.reviewCount, recomputed.errorCount], [0, 0, 3, 1]);
assert.equal(recomputed.nextReviewAt, "2026-09-13T08:00:00.000Z");

console.log("Sync merge rules: all assertions passed");
