"use strict";

const DB_NAME = "mot-juste-tcf";
const DB_VERSION = 3;
const STORE_WORDS = "words";
const STORE_REVIEWS = "reviews";
const STORE_SETTINGS = "settings";
const RESULT_LABELS = { fail: "❌ 没认出来", slow: "🟡 反应慢", correct: "✅ 自动认出" };
const CATEGORY_LABELS = { new: "今日新词", due: "到期词", weak: "薄弱词", mature: "熟练复现" };

let db;
let appState = {
  words: [],
  reviews: [],
  settings: {},
  session: null,
  activeView: "today",
  revealAnswer: false,
};
let toastTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    db = await openDatabase();
    bindEvents();
    await loadAllData();
    applyTheme(appState.settings.theme || "system");
    await ensureTodaySession();
    renderAll();
    registerWebMcpTools();
    updateNetworkStatus();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {
        showToast("离线组件将在下次访问时重试");
      });
    }
    document.dispatchEvent(new CustomEvent("motjuste:ready"));
  } catch (error) {
    console.error(error);
    $("#trainingArea").innerHTML = emptyState("无法打开本地数据", "请确认浏览器允许此网站保存数据，然后刷新页面。", "重试", "location.reload()", "!");
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!database.objectStoreNames.contains(STORE_WORDS)) {
        const words = database.createObjectStore(STORE_WORDS, { keyPath: "id" });
        words.createIndex("normalized", "normalized", { unique: true });
        words.createIndex("createdDate", "createdDate", { unique: false });
        words.createIndex("nextReviewAt", "nextReviewAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_REVIEWS)) {
        const reviews = database.createObjectStore(STORE_REVIEWS, { keyPath: "id" });
        reviews.createIndex("wordId", "wordId", { unique: false });
        reviews.createIndex("reviewedDate", "reviewedDate", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
        database.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
      if (event.oldVersion < 2) {
        const wordsStore = transaction.objectStore(STORE_WORDS);
        wordsStore.openCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result;
          if (!cursor) return;
          const word = cursor.value;
          cursor.update({
            ...word,
            deletedAt: word.deletedAt || null,
            syncState: "pending",
          });
          cursor.continue();
        };
      }
      if (event.oldVersion > 0 && event.oldVersion < 3) {
        const legacyReviews = transaction.objectStore(STORE_REVIEWS);
        const readReviews = legacyReviews.getAll();
        readReviews.onsuccess = () => {
          database.deleteObjectStore(STORE_REVIEWS);
          const reviews = database.createObjectStore(STORE_REVIEWS, { keyPath: "id" });
          reviews.createIndex("wordId", "wordId", { unique: false });
          reviews.createIndex("reviewedDate", "reviewedDate", { unique: false });
          readReviews.result.forEach((review) => reviews.put({
            ...review,
            id: typeof review.id === "string" ? review.id : makeId(),
            syncState: review.syncState || "pending",
          }));
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("数据库升级被其他标签页阻止"));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(storeName) {
  const transaction = db.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).getAll());
}

async function putRecord(storeName, value) {
  const transaction = db.transaction(storeName, "readwrite");
  await requestToPromise(transaction.objectStore(storeName).put(value));
  await transactionDone(transaction);
  return value;
}

async function deleteRecord(storeName, key) {
  const transaction = db.transaction(storeName, "readwrite");
  await requestToPromise(transaction.objectStore(storeName).delete(key));
  await transactionDone(transaction);
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("操作已取消"));
  });
}

async function loadAllData() {
  const [words, reviews, settingsRows] = await Promise.all([
    getAll(STORE_WORDS),
    getAll(STORE_REVIEWS),
    getAll(STORE_SETTINGS),
  ]);
  appState.words = words;
  appState.reviews = reviews;
  appState.settings = Object.fromEntries(settingsRows.map(({ key, value }) => [key, value]));
}

async function saveSetting(key, value) {
  appState.settings[key] = value;
  await putRecord(STORE_SETTINGS, { key, value });
}

async function deleteSetting(key) {
  delete appState.settings[key];
  await deleteRecord(STORE_SETTINGS, key);
}

function activeWords() {
  return appState.words.filter((word) => !word.deletedAt);
}

function localDate(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeFrench(value) {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function errorRate(word) {
  return word.reviewCount ? word.errorCount / word.reviewCount : 0;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function formatDateTime(value) {
  if (!value) return "尚未复习";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDue(value) {
  if (!value) return "未安排";
  const due = new Date(value);
  const diff = Math.ceil((due - new Date()) / 86400000);
  if (diff <= 0) return "今天到期";
  if (diff === 1) return "明天复习";
  return `${diff} 天后复习`;
}

async function ensureTodaySession(forceRebuild = false) {
  const today = localDate();
  const stored = appState.settings.todaySession;
  if (!forceRebuild && stored?.date === today && Array.isArray(stored.wordIds)) {
    const validIds = new Set(activeWords().map((word) => word.id));
    stored.wordIds = stored.wordIds.filter((id) => validIds.has(id));
    stored.completedIds = (stored.completedIds || []).filter((id) => validIds.has(id));
    for (const key of Object.keys(CATEGORY_LABELS)) {
      stored.categories[key] = (stored.categories?.[key] || []).filter((id) => validIds.has(id));
    }
    appState.session = stored;
    return stored;
  }
  const session = buildTodaySession(activeWords(), Number(appState.settings.dailyTarget) || 30);
  appState.session = session;
  await saveSetting("todaySession", session);
  return session;
}

function buildTodaySession(words, target) {
  words = words.filter((word) => !word.deletedAt);
  const today = localDate();
  const now = Date.now();
  const selected = [];
  const selectedIds = new Set();
  const categories = { new: [], due: [], weak: [], mature: [] };
  const addBatch = (category, candidates, limit = Infinity) => {
    for (const word of candidates) {
      if (selectedIds.has(word.id) || categories[category].length >= limit) continue;
      if (category !== "new" && selected.length >= target) break;
      selected.push(word.id);
      selectedIds.add(word.id);
      categories[category].push(word.id);
    }
  };
  const byOldest = (a, b) => (a.lastReviewedAt || a.createdAt).localeCompare(b.lastReviewedAt || b.createdAt);
  const newWords = words.filter((word) => word.createdDate === today).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const dueWords = words.filter((word) => word.nextReviewAt && new Date(word.nextReviewAt).getTime() <= now).sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt));
  const weakWords = words.filter((word) => word.mastery <= 1 || errorRate(word) >= 0.35).sort((a, b) => errorRate(b) - errorRate(a) || byOldest(a, b));
  const matureWords = words.filter((word) => word.mastery === 3).sort(byOldest);
  addBatch("new", newWords);
  addBatch("due", dueWords);
  addBatch("weak", weakWords);
  addBatch("mature", matureWords, Math.max(2, Math.round(target * 0.15)));
  return { date: today, createdAt: new Date().toISOString(), wordIds: selected, completedIds: [], categories };
}

async function addWord(french, chinese) {
  const term = french.normalize("NFC").trim().replace(/\s+/g, " ");
  const translation = chinese.trim().replace(/\s+/g, " ");
  if (!term || !translation) throw new Error("请填写法语词和中文释义");
  const normalized = normalizeFrench(term);
  const duplicate = appState.words.find((word) => word.normalized === normalized);
  if (duplicate && !duplicate.deletedAt) throw new Error(`“${duplicate.term}” 已在词汇库中`);
  const now = new Date();
  const word = {
    ...(duplicate || {}),
    id: duplicate?.id || makeId(),
    term,
    translation,
    normalized,
    createdAt: duplicate?.createdAt || now.toISOString(),
    createdDate: duplicate?.createdDate || localDate(now),
    updatedAt: now.toISOString(),
    deletedAt: null,
    syncState: "pending",
    mastery: duplicate?.mastery || 0,
    reviewCount: duplicate?.reviewCount || 0,
    errorCount: duplicate?.errorCount || 0,
    streak: duplicate?.streak || 0,
    lastResult: duplicate?.lastResult || null,
    lastReviewedAt: duplicate?.lastReviewedAt || null,
    nextReviewAt: duplicate?.nextReviewAt || null,
  };
  await putRecord(STORE_WORDS, word);
  appState.words = duplicate
    ? appState.words.map((item) => item.id === duplicate.id ? word : item)
    : [...appState.words, word];
  await addWordToTodaySession(word.id);
  window.MotJusteSync?.queue();
  return word;
}

async function addWordToTodaySession(wordId) {
  await ensureTodaySession();
  if (!appState.session.wordIds.includes(wordId)) appState.session.wordIds.push(wordId);
  if (!appState.session.categories.new.includes(wordId)) appState.session.categories.new.push(wordId);
  await saveSetting("todaySession", appState.session);
}

function getCurrentTrainingWord() {
  const completed = new Set(appState.session?.completedIds || []);
  const id = appState.session?.wordIds.find((wordId) => !completed.has(wordId));
  return appState.words.find((word) => word.id === id && !word.deletedAt) || null;
}

function categoryForWord(wordId) {
  for (const category of Object.keys(CATEGORY_LABELS)) {
    if (appState.session?.categories?.[category]?.includes(wordId)) return category;
  }
  return "weak";
}

function getSrsUpdate(word, result, reviewedAt = new Date()) {
  let mastery;
  let streak;
  let intervalDays;
  if (result === "fail") {
    mastery = 0; streak = 0; intervalDays = 1;
  } else if (result === "slow") {
    mastery = 1; streak = 0; intervalDays = 2;
  } else {
    streak = (word.streak || 0) + 1;
    if (streak === 1) { mastery = 2; intervalDays = 3; }
    else if (streak === 2) { mastery = 3; intervalDays = 7; }
    else if (streak === 3) { mastery = 3; intervalDays = 14; }
    else { mastery = 3; intervalDays = 30; }
  }
  return {
    ...word,
    mastery,
    streak,
    reviewCount: (word.reviewCount || 0) + 1,
    errorCount: (word.errorCount || 0) + (result === "fail" ? 1 : 0),
    lastResult: result,
    lastReviewedAt: reviewedAt.toISOString(),
    nextReviewAt: addDays(reviewedAt, intervalDays).toISOString(),
    updatedAt: word.updatedAt || reviewedAt.toISOString(),
    intervalDays,
  };
}

async function recordAnswer(result) {
  const word = getCurrentTrainingWord();
  if (!word || !RESULT_LABELS[result]) return;
  const reviewedAt = new Date();
  const updated = getSrsUpdate(word, result, reviewedAt);
  const review = {
    id: makeId(),
    wordId: word.id,
    term: word.term,
    result,
    reviewedAt: reviewedAt.toISOString(),
    reviewedDate: localDate(reviewedAt),
    previousMastery: word.mastery,
    newMastery: updated.mastery,
    intervalDays: updated.intervalDays,
    syncState: "pending",
  };
  delete updated.intervalDays;
  const transaction = db.transaction([STORE_WORDS, STORE_REVIEWS, STORE_SETTINGS], "readwrite");
  transaction.objectStore(STORE_WORDS).put(updated);
  transaction.objectStore(STORE_REVIEWS).put(review);
  if (!appState.session.completedIds.includes(word.id)) appState.session.completedIds.push(word.id);
  transaction.objectStore(STORE_SETTINGS).put({ key: "todaySession", value: appState.session });
  await transactionDone(transaction);
  appState.words = appState.words.map((item) => item.id === word.id ? updated : item);
  appState.reviews.push(review);
  appState.settings.todaySession = appState.session;
  appState.revealAnswer = false;
  renderToday();
  window.MotJusteSync?.queue();
  showToast(`${RESULT_LABELS[result]} · ${review.intervalDays} 天后再见`);
}

function renderAll() {
  renderToday();
  renderLibrary();
  renderStats();
  renderSettings();
  window.MotJusteSync?.render?.();
}

function renderToday() {
  const now = new Date();
  $("#todayDate").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(now);
  const total = appState.session?.wordIds.length || 0;
  const completed = appState.session?.completedIds.length || 0;
  $("#progressNumber").textContent = completed;
  $("#progressTotal").textContent = `/ ${total}`;
  $(".goal-ring").style.background = `conic-gradient(var(--blue) ${total ? completed / total * 360 : 0}deg, transparent 0)`;
  $("#trainingMix").innerHTML = Object.entries(CATEGORY_LABELS).map(([key, label]) => `<span class="mix-chip">${label}<strong>${appState.session?.categories?.[key]?.length || 0}</strong></span>`).join("");
  const word = getCurrentTrainingWord();
  if (!word) {
    const complete = total > 0 && completed >= total;
    $("#trainingArea").innerHTML = emptyState(
      complete ? "今天完成了" : "还没有训练词",
      complete ? `已复习 ${completed} 个词。明天会按 SRS 自动安排下一轮。` : "先加入几个新词，它们会立即进入今日训练。",
      complete ? "去词汇库" : "极速加词",
      `switchView('${complete ? "library" : "add"}')`,
      complete ? "✓" : "+"
    );
  } else {
    const category = categoryForWord(word.id);
    $("#trainingArea").innerHTML = `
      <article class="training-card">
        <div class="card-topline"><span class="category-tag">${CATEGORY_LABELS[category]}</span><span>${completed + 1} / ${total} · 熟练度 ${word.mastery}</span></div>
        <div class="word-face">
          <h2 lang="fr">${escapeHtml(word.term)}</h2>
          <p class="translation ${appState.revealAnswer ? "revealed" : ""}">${appState.revealAnswer ? escapeHtml(word.translation) : "想好后再看答案"}</p>
        </div>
        <div>
          <button id="revealBtn" class="reveal-btn wide" type="button">${appState.revealAnswer ? "隐藏释义" : "显示中文释义"}</button>
          <div class="answer-grid" style="margin-top:10px">
            <button class="answer-btn fail" type="button" data-result="fail">❌ 没认出来<small>1 天后</small></button>
            <button class="answer-btn slow" type="button" data-result="slow">🟡 反应慢<small>2 天后</small></button>
            <button class="answer-btn correct" type="button" data-result="correct">✅ 自动认出<small>按连续正确递增</small></button>
          </div>
        </div>
      </article>`;
    $("#revealBtn").addEventListener("click", () => { appState.revealAnswer = !appState.revealAnswer; renderToday(); });
    $$("[data-result]", $("#trainingArea")).forEach((button) => button.addEventListener("click", () => recordAnswer(button.dataset.result)));
  }
  $("#promptPreview").textContent = buildChatGptPrompt();
}

function emptyState(title, text, buttonText, action, icon) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><h2>${title}</h2><p>${text}</p><button class="primary-btn" type="button" onclick="${action}">${buttonText}</button></div>`;
}

function buildChatGptPrompt() {
  const linesFor = (key) => {
    const ids = appState.session?.categories?.[key] || [];
    const items = ids.map((id) => appState.words.find((word) => word.id === id && !word.deletedAt)).filter(Boolean);
    return items.length ? items.map((word) => `${word.term}（${word.translation}）`).join("；") : "无";
  };
  return `你是一位熟悉 TCF 的法语教师。请使用下面的今日词汇，生成 5 篇难度为 TCF B1+/B2 的法语短阅读。\n\n要求：\n1. 每篇 80–120 个法语词；\n2. 主题彼此不同，语境自然；\n3. 尽量覆盖全部词汇，但不要生硬堆砌；\n4. 每篇后附 2 道法语理解题；\n5. 最后给出理解题答案，不要逐句翻译正文。\n\n【今日新词】\n${linesFor("new")}\n\n【到期词】\n${linesFor("due")}\n\n【薄弱词】\n${linesFor("weak")}\n\n【熟练复现词】\n${linesFor("mature")}`;
}

function renderLibrary() {
  const query = normalizeFrench($("#searchInput")?.value || "");
  const mastery = $("#masteryFilter")?.value || "all";
  const visibleWords = activeWords();
  const filtered = [...visibleWords]
    .filter((word) => !query || word.normalized.includes(query) || word.translation.toLocaleLowerCase("zh-CN").includes(query))
    .filter((word) => mastery === "all" || String(word.mastery) === mastery)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#libraryCount").textContent = `${visibleWords.length} 词`;
  $("#libraryList").innerHTML = filtered.length ? filtered.map((word) => `
    <article class="vocab-card" data-word-id="${word.id}">
      <div class="vocab-main"><div><h2 lang="fr">${escapeHtml(word.term)}</h2><p>${escapeHtml(word.translation)}</p></div><span class="mastery-badge" title="熟练度">L${word.mastery}</span></div>
      <div class="vocab-meta"><span>复习 ${word.reviewCount} 次</span><span>错误率 ${Math.round(errorRate(word) * 100)}%</span><span>连对 ${word.streak}</span><span>${formatDue(word.nextReviewAt)}</span><span>添加于 ${formatDateTime(word.createdAt)}</span></div>
      <div class="vocab-actions"><button class="text-btn" type="button" data-edit-id="${word.id}">编辑</button><button class="text-btn delete" type="button" data-delete-id="${word.id}">删除</button></div>
    </article>`).join("") : `<div class="empty-state"><div class="empty-icon">⌕</div><h2>没有找到词汇</h2><p>${visibleWords.length ? "换个关键词或筛选条件试试。" : "用极速加词建立你的第一个词条。"}</p></div>`;
  $$('[data-edit-id]', $("#libraryList")).forEach((button) => button.addEventListener("click", () => openEditDialog(button.dataset.editId)));
  $$('[data-delete-id]', $("#libraryList")).forEach((button) => button.addEventListener("click", () => removeWord(button.dataset.deleteId)));
}

function renderStats() {
  const today = localDate();
  const visibleWords = activeWords();
  const todayAdded = visibleWords.filter((word) => word.createdDate === today).length;
  const todayReviewed = appState.reviews.filter((review) => review.reviewedDate === today).length;
  const correctCount = appState.reviews.filter((review) => review.result === "correct").length;
  const accuracy = appState.reviews.length ? Math.round(correctCount / appState.reviews.length * 100) : 0;
  const stats = [["词汇总数", visibleWords.length], ["今日新增", todayAdded], ["今日复习", todayReviewed], ["自动认出率", `${accuracy}%`]];
  $("#statCards").innerHTML = stats.map(([label, value]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  const masteryCounts = [0, 1, 2, 3].map((level) => visibleWords.filter((word) => word.mastery === level).length);
  const max = Math.max(1, ...masteryCounts);
  $("#masteryChart").innerHTML = masteryCounts.map((count, level) => `<div class="mastery-row"><span>熟练度 ${level}</span><div class="bar-track"><div class="bar-fill" style="width:${count / max * 100}%"></div></div><strong>${count}</strong></div>`).join("");
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(new Date(), index - 6);
    const dateKey = localDate(date);
    return { date, dateKey, count: appState.reviews.filter((review) => review.reviewedDate === dateKey).length };
  });
  const activityMax = Math.max(1, ...days.map((day) => day.count));
  $("#activityChart").innerHTML = days.map((day) => `<div class="activity-day"><strong>${day.count}</strong><div class="activity-bar" style="height:${Math.max(4, day.count / activityMax * 92)}px"></div><span>${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(day.date)}</span></div>`).join("");
}

function renderSettings() {
  $("#themeSelect").value = appState.settings.theme || "system";
  $("#dailyTarget").value = Number(appState.settings.dailyTarget) || 30;
  $("#dailyTargetOutput").value = $("#dailyTarget").value;
}

function bindEvents() {
  $$('[data-view-target]').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewTarget)));
  $("#quickAddForm").addEventListener("submit", handleQuickAdd);
  $("#chineseInput").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") $("#quickAddForm").requestSubmit();
  });
  $("#searchInput").addEventListener("input", renderLibrary);
  $("#masteryFilter").addEventListener("change", renderLibrary);
  $("#copyPromptBtn").addEventListener("click", copyPrompt);
  $("#themeSelect").addEventListener("change", async (event) => { await saveSetting("theme", event.target.value); applyTheme(event.target.value); });
  $("#dailyTarget").addEventListener("input", (event) => { $("#dailyTargetOutput").value = event.target.value; });
  $("#dailyTarget").addEventListener("change", async (event) => {
    await saveSetting("dailyTarget", Number(event.target.value));
    await ensureTodaySession(true);
    renderToday();
    showToast(`每日目标已设为 ${event.target.value} 词`);
  });
  $("#exportJsonBtn").addEventListener("click", exportJson);
  $("#importJsonBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", importJson);
  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#resetDataBtn").addEventListener("click", resetAllData);
  $("#editForm").addEventListener("submit", saveEditedWord);
  $("#cancelEditBtn").addEventListener("click", () => $("#editDialog").close());
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if ((appState.settings.theme || "system") === "system") applyTheme("system"); });
}

function switchView(view) {
  if (!$("#view-" + view)) return;
  appState.activeView = view;
  $$(".view").forEach((section) => section.classList.toggle("active", section.dataset.view === view));
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.viewTarget === view;
    button.classList.toggle("active", active);
    active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  if (view === "today") renderToday();
  if (view === "library") renderLibrary();
  if (view === "stats") renderStats();
  if (view === "settings") renderSettings();
  if (view === "add") setTimeout(() => $("#frenchInput").focus(), 80);
  $("#mainContent").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
window.switchView = switchView;

async function handleQuickAdd(event) {
  event.preventDefault();
  const feedback = $("#addFeedback");
  feedback.className = "form-feedback";
  try {
    const word = await addWord($("#frenchInput").value, $("#chineseInput").value);
    feedback.textContent = `已添加 · ${formatDateTime(word.createdAt)} · 已加入今日新词`;
    feedback.classList.add("success");
    event.target.reset();
    $("#frenchInput").focus();
    renderAll();
  } catch (error) {
    feedback.textContent = error.message;
    feedback.classList.add("error");
  }
}

function openEditDialog(id) {
  const word = appState.words.find((item) => item.id === id);
  if (!word) return;
  $("#editWordId").value = id;
  $("#editFrench").value = word.term;
  $("#editChinese").value = word.translation;
  $("#editDialog").showModal();
}

async function saveEditedWord(event) {
  event.preventDefault();
  const id = $("#editWordId").value;
  const word = appState.words.find((item) => item.id === id);
  if (!word) return;
  const term = $("#editFrench").value.normalize("NFC").trim().replace(/\s+/g, " ");
  const translation = $("#editChinese").value.trim().replace(/\s+/g, " ");
  const normalized = normalizeFrench(term);
  if (!term || !translation) return showToast("请填写完整");
  if (appState.words.some((item) => item.id !== id && !item.deletedAt && item.normalized === normalized)) return showToast("这个词已经存在");
  const updated = { ...word, term, translation, normalized, updatedAt: new Date().toISOString(), syncState: "pending" };
  await putRecord(STORE_WORDS, updated);
  appState.words = appState.words.map((item) => item.id === id ? updated : item);
  $("#editDialog").close();
  renderAll();
  window.MotJusteSync?.queue();
  showToast("词汇已更新");
}

async function removeWord(id) {
  const word = appState.words.find((item) => item.id === id);
  if (!word || !confirm(`删除“${word.term}”？复习历史会保留，并向其他设备同步删除状态。`)) return;
  const now = new Date().toISOString();
  const deleted = { ...word, deletedAt: now, updatedAt: now, syncState: "pending" };
  const transaction = db.transaction([STORE_WORDS, STORE_SETTINGS], "readwrite");
  transaction.objectStore(STORE_WORDS).put(deleted);
  appState.session.wordIds = appState.session.wordIds.filter((wordId) => wordId !== id);
  appState.session.completedIds = appState.session.completedIds.filter((wordId) => wordId !== id);
  Object.keys(CATEGORY_LABELS).forEach((key) => { appState.session.categories[key] = appState.session.categories[key].filter((wordId) => wordId !== id); });
  transaction.objectStore(STORE_SETTINGS).put({ key: "todaySession", value: appState.session });
  await transactionDone(transaction);
  appState.words = appState.words.map((item) => item.id === id ? deleted : item);
  renderAll();
  window.MotJusteSync?.queue();
  showToast("词汇已删除");
}

async function copyPrompt() {
  const prompt = buildChatGptPrompt();
  try {
    await navigator.clipboard.writeText(prompt);
    showToast("提示词已复制");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = prompt;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("提示词已复制");
  }
}

function applyTheme(theme) {
  const isDark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  $("meta[name='theme-color']").content = isDark ? "#0d1220" : "#1358dc";
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  const portableSettings = Object.entries(appState.settings)
    .filter(([key]) => !["supabaseSession", "syncOwnerUserId", "lastSyncAt"].includes(key))
    .map(([key, value]) => ({ key, value }));
  const backup = {
    format: "mot-juste-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      words: appState.words,
      reviews: appState.reviews,
      settings: portableSettings,
    },
  };
  downloadFile(`mot-juste-backup-${localDate()}.json`, JSON.stringify(backup, null, 2), "application/json");
  $("#backupStatus").textContent = `JSON 备份已导出 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

async function importJson(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.format !== "mot-juste-backup" || parsed?.version !== 1 || !Array.isArray(parsed?.data?.words) || !Array.isArray(parsed?.data?.reviews) || !Array.isArray(parsed?.data?.settings)) {
      throw new Error("这不是有效的 Mot juste JSON 备份");
    }
    const normalizedSet = new Set();
    for (const word of parsed.data.words) {
      if (!word.id || !word.term || !word.translation) throw new Error("备份中存在不完整的词汇记录");
      const normalized = word.normalized || normalizeFrench(word.term);
      if (normalizedSet.has(normalized)) throw new Error("备份中存在重复词汇");
      normalizedSet.add(normalized);
      word.normalized = normalized;
      word.deletedAt = word.deletedAt || null;
      word.syncState = "pending";
    }
    parsed.data.reviews = parsed.data.reviews.map((review) => ({
      ...review,
      id: typeof review.id === "string" ? review.id : makeId(),
      syncState: "pending",
    }));
    if (!confirm(`将用备份中的 ${parsed.data.words.length} 个词覆盖当前本机缓存，继续吗？云端数据会在下次同步时安全合并。`)) return;
    const protectedSettings = ["supabaseSession", "syncOwnerUserId", "lastSyncAt"]
      .filter((key) => appState.settings[key] !== undefined)
      .map((key) => ({ key, value: appState.settings[key] }));
    const transaction = db.transaction([STORE_WORDS, STORE_REVIEWS, STORE_SETTINGS], "readwrite");
    const wordsStore = transaction.objectStore(STORE_WORDS);
    const reviewsStore = transaction.objectStore(STORE_REVIEWS);
    const settingsStore = transaction.objectStore(STORE_SETTINGS);
    wordsStore.clear(); reviewsStore.clear(); settingsStore.clear();
    parsed.data.words.forEach((row) => wordsStore.put(row));
    parsed.data.reviews.forEach((row) => reviewsStore.put(row));
    parsed.data.settings.forEach((row) => { if (row?.key && !["supabaseSession", "syncOwnerUserId", "lastSyncAt"].includes(row.key)) settingsStore.put(row); });
    protectedSettings.forEach((row) => settingsStore.put(row));
    await transactionDone(transaction);
    await loadAllData();
    await ensureTodaySession();
    applyTheme(appState.settings.theme || "system");
    renderAll();
    $("#backupStatus").textContent = `恢复完成 · ${activeWords().length} 个词`;
    window.MotJusteSync?.queue();
    showToast("JSON 备份已恢复");
  } catch (error) {
    $("#backupStatus").textContent = error.message;
    $("#backupStatus").className = "form-feedback error";
  }
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function exportCsv() {
  const headers = ["法语词/词组", "中文释义", "添加时间", "熟练度", "复习次数", "错误次数", "错误率", "连续正确", "最近结果", "上次复习", "下次复习"];
  const rows = activeWords().map((word) => [word.term, word.translation, word.createdAt, word.mastery, word.reviewCount, word.errorCount, `${Math.round(errorRate(word) * 100)}%`, word.streak, word.lastResult ? RESULT_LABELS[word.lastResult] : "", word.lastReviewedAt || "", word.nextReviewAt || ""]);
  const csv = "\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadFile(`mot-juste-vocabulary-${localDate()}.csv`, csv, "text/csv;charset=utf-8");
  $("#backupStatus").textContent = `CSV 已导出 · ${activeWords().length} 个词`;
}

async function resetAllData() {
  if (!confirm("确定清空全部本机数据吗？此操作无法撤销，建议先导出 JSON 备份。")) return;
  const transaction = db.transaction([STORE_WORDS, STORE_REVIEWS, STORE_SETTINGS], "readwrite");
  transaction.objectStore(STORE_WORDS).clear();
  transaction.objectStore(STORE_REVIEWS).clear();
  transaction.objectStore(STORE_SETTINGS).clear();
  await transactionDone(transaction);
  appState.words = []; appState.reviews = []; appState.settings = {};
  await ensureTodaySession(true);
  applyTheme("system");
  renderAll();
  window.MotJusteSync?.onLocalReset?.();
  showToast("本机数据已清空");
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  $("#networkStatus").textContent = online ? "在线" : "离线可用";
  $("#networkStatus").title = online ? "网络正常" : "应用和数据仍可离线使用";
  window.MotJusteSync?.networkChanged?.(online);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

async function refreshTodaySessionAfterSync() {
  const previous = appState.session;
  const rebuilt = buildTodaySession(activeWords(), Number(appState.settings.dailyTarget) || 30);
  const validIds = new Set(activeWords().map((word) => word.id));
  const completedIds = (previous?.completedIds || []).filter((id) => validIds.has(id));
  for (const id of completedIds) {
    if (!rebuilt.wordIds.includes(id)) {
      rebuilt.wordIds.push(id);
      const oldCategory = Object.keys(CATEGORY_LABELS).find((key) => previous?.categories?.[key]?.includes(id)) || "weak";
      rebuilt.categories[oldCategory].push(id);
    }
  }
  rebuilt.completedIds = completedIds;
  appState.session = rebuilt;
  await saveSetting("todaySession", rebuilt);
}

async function commitSyncedData(words, reviews) {
  const [currentWords, currentReviews] = await Promise.all([getAll(STORE_WORDS), getAll(STORE_REVIEWS)]);
  const wordMap = new Map(words.map((word) => [word.id, word]));
  const incomingByNormalized = new Map(words.map((word) => [word.normalized, word]));
  const concurrentIdAliases = new Map();
  for (const current of currentWords) {
    const incoming = wordMap.get(current.id);
    const canonical = incomingByNormalized.get(current.normalized);
    if (!incoming && canonical) {
      concurrentIdAliases.set(current.id, canonical.id);
      if (current.syncState === "pending" && String(current.updatedAt || "") > String(canonical.updatedAt || "")) {
        const canonicalized = { ...current, id: canonical.id };
        wordMap.set(canonical.id, canonicalized);
        incomingByNormalized.set(current.normalized, canonicalized);
      }
      continue;
    }
    if (!incoming || (current.syncState === "pending" && String(current.updatedAt || "") > String(incoming.updatedAt || ""))) {
      wordMap.set(current.id, current);
    }
  }
  const reviewMap = new Map(reviews.map((review) => [review.id, review]));
  currentReviews.forEach((review) => {
    if (!reviewMap.has(review.id)) reviewMap.set(review.id, {
      ...review,
      wordId: concurrentIdAliases.get(review.wordId) || review.wordId,
    });
  });
  const finalWords = [...wordMap.values()];
  const finalReviews = [...reviewMap.values()];
  const transaction = db.transaction([STORE_WORDS, STORE_REVIEWS], "readwrite");
  const wordsStore = transaction.objectStore(STORE_WORDS);
  const reviewsStore = transaction.objectStore(STORE_REVIEWS);
  wordsStore.clear();
  reviewsStore.clear();
  finalWords.forEach((word) => wordsStore.put(word));
  finalReviews.forEach((review) => reviewsStore.put(review));
  await transactionDone(transaction);
  appState.words = finalWords;
  appState.reviews = finalReviews;
  await refreshTodaySessionAfterSync();
  renderAll();
}

window.MotJusteApp = {
  getState: () => appState,
  getDb: () => db,
  stores: { words: STORE_WORDS, reviews: STORE_REVIEWS, settings: STORE_SETTINGS },
  activeWords,
  getAll,
  putRecord,
  saveSetting,
  deleteSetting,
  transactionDone,
  commitSyncedData,
  refreshTodaySessionAfterSync,
  getSrsUpdate,
  normalizeFrench,
  localDate,
  makeId,
  renderAll,
  showToast,
};

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const tools = [
    {
      name: "add_tcf_word",
      title: "添加 TCF 词汇",
      description: "把一个法语词或词组及中文释义保存到本机词汇库，并加入今日新词。",
      inputSchema: { type: "object", properties: { french: { type: "string" }, chinese: { type: "string" } }, required: ["french", "chinese"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        if (!input || typeof input.french !== "string" || typeof input.chinese !== "string") throw new Error("french 和 chinese 必须是文本");
        const word = await addWord(input.french, input.chinese);
        renderAll();
        return { id: word.id, term: word.term, createdAt: word.createdAt, addedToToday: true };
      },
    },
    {
      name: "read_today_training",
      title: "读取今日训练",
      description: "读取今日训练各类词汇数量、进度和当前词，不修改数据。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async () => ({
        date: appState.session?.date,
        total: appState.session?.wordIds.length || 0,
        completed: appState.session?.completedIds.length || 0,
        categories: Object.fromEntries(Object.keys(CATEGORY_LABELS).map((key) => [key, appState.session?.categories?.[key]?.length || 0])),
        currentTerm: getCurrentTrainingWord()?.term || null,
      }),
    },
  ];
  tools.forEach((tool) => {
    try { void Promise.resolve(context.registerTool(tool)).catch(console.warn); } catch (error) { console.warn(error); }
  });
}
