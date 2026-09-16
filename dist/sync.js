"use strict";

(() => {
  const config = window.MOT_JUSTE_SUPABASE || {};
  const state = {
    session: null,
    user: null,
    syncing: false,
    syncPromise: null,
    timer: null,
    initialized: false,
    message: "",
    error: "",
  };

  const $ = (selector) => document.querySelector(selector);
  const hasConfig = () => /^https:\/\/.+\.supabase\.co$/.test(config.url || "") && /^sb_publishable_/.test(config.publishableKey || "");
  const app = () => window.MotJusteApp;
  const nowIso = () => new Date().toISOString();
  const asIso = (value, fallback = nowIso()) => {
    const date = value ? new Date(value) : new Date(fallback);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  };
  const uuid = () => app()?.makeId?.() || crypto.randomUUID();
  const normalize = (value) => app()?.normalizeFrench?.(value || "") || String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");

  function errorMessage(error) {
    if (!error) return "同步失败，请稍后重试";
    if (error.status === 401) return "登录已失效，请重新登录";
    if (error.status === 422) return error.message || "邮箱或密码不符合要求";
    if (error.status === 429) return "请求过于频繁，请稍后重试";
    return error.message || "同步失败，请稍后重试";
  }

  async function apiFetch(path, options = {}, retryAuth = true) {
    const headers = new Headers(options.headers || {});
    headers.set("apikey", config.publishableKey);
    if (state.session?.access_token) headers.set("Authorization", `Bearer ${state.session.access_token}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(`${config.url}${path}`, { ...options, headers });
    if (response.status === 401 && retryAuth && state.session?.refresh_token) {
      await refreshSession();
      return apiFetch(path, options, false);
    }
    if (!response.ok) {
      let detail = {};
      try { detail = await response.json(); } catch { detail = { message: await response.text().catch(() => "") }; }
      const error = new Error(detail.msg || detail.message || detail.error_description || detail.details || `请求失败 (${response.status})`);
      error.status = response.status;
      error.code = detail.code;
      throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function normalizeSession(payload) {
    if (!payload?.access_token) return null;
    const expiresAt = Number(payload.expires_at) || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600);
    return { ...payload, expires_at: expiresAt };
  }

  async function persistSession(session) {
    state.session = normalizeSession(session);
    state.user = state.session?.user || null;
    if (state.session) await app().saveSetting("supabaseSession", state.session);
    else await app().deleteSetting("supabaseSession");
  }

  async function refreshSession() {
    if (!state.session?.refresh_token) throw Object.assign(new Error("登录已失效，请重新登录"), { status: 401 });
    const payload = await apiFetch("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: state.session.refresh_token }),
    }, false);
    await persistSession(payload);
    return state.session;
  }

  async function ensureFreshSession() {
    if (!state.session) throw Object.assign(new Error("请先登录"), { status: 401 });
    if ((Number(state.session.expires_at) || 0) * 1000 < Date.now() + 60000) await refreshSession();
    return state.session;
  }

  async function adoptSession(session) {
    const normalized = normalizeSession(session);
    if (!normalized) return false;
    const user = normalized.user || await apiFetchWithSession(normalized, "/auth/v1/user");
    normalized.user = user;
    await verifyOwner(user.id);
    await persistSession(normalized);
    await app().saveSetting("syncOwnerUserId", user.id);
    state.error = "";
    render();
    if (navigator.onLine) await syncNow();
    return true;
  }

  async function apiFetchWithSession(session, path) {
    const response = await fetch(`${config.url}${path}`, {
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${session.access_token}` },
    });
    if (!response.ok) throw Object.assign(new Error("无法读取账号信息"), { status: response.status });
    return response.json();
  }

  async function verifyOwner(userId) {
    const settings = app().getState().settings;
    const previousOwner = settings.syncOwnerUserId;
    const [words, reviews] = await Promise.all([app().getAll(app().stores.words), app().getAll(app().stores.reviews)]);
    if (previousOwner && previousOwner !== userId && (words.length || reviews.length)) {
      throw new Error("此浏览器已有另一个账号的本机缓存。请先导出备份并清空本机数据，再登录新账号。");
    }
  }

  function parseRedirectSession() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (!params.get("access_token")) return null;
    const session = normalizeSession({
      access_token: params.get("access_token"),
      refresh_token: params.get("refresh_token"),
      expires_in: Number(params.get("expires_in") || 3600),
      token_type: params.get("token_type") || "bearer",
    });
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return session;
  }

  async function register() {
    await authenticate("signup");
  }

  async function login(event) {
    event?.preventDefault?.();
    await authenticate("login");
  }

  async function authenticate(mode) {
    const email = $("#authEmail")?.value.trim();
    const password = $("#authPassword")?.value || "";
    if (!email || password.length < 6) {
      setFeedback("请输入有效邮箱和至少 6 位密码", true);
      return;
    }
    setAuthBusy(true);
    setFeedback(mode === "signup" ? "正在创建账号…" : "正在登录…");
    try {
      const path = mode === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
      const body = mode === "signup"
        ? { email, password, options: { email_redirect_to: `${location.origin}${location.pathname}` } }
        : { email, password };
      const payload = await apiFetch(path, { method: "POST", body: JSON.stringify(body) }, false);
      if (payload?.access_token) {
        await adoptSession(payload);
        setFeedback("登录成功，本机与云端数据已合并");
        if ($("#authPassword")) $("#authPassword").value = "";
      } else {
        setFeedback("注册成功，请查收验证邮件；验证后返回此页面登录。", false);
      }
    } catch (error) {
      state.error = errorMessage(error);
      setFeedback(state.error, true);
    } finally {
      setAuthBusy(false);
      render();
    }
  }

  async function logout() {
    setAuthBusy(true);
    try {
      if (navigator.onLine && state.session) await apiFetch("/auth/v1/logout", { method: "POST" }, false).catch(() => null);
      await persistSession(null);
      state.message = "已退出；本机离线数据仍然保留";
      state.error = "";
      setFeedback(state.message);
    } finally {
      setAuthBusy(false);
      render();
    }
  }

  function cloudWord(row) {
    const createdAt = asIso(row.created_at);
    return {
      id: row.id,
      term: row.term,
      translation: row.translation,
      normalized: row.normalized || normalize(row.term),
      createdAt,
      createdDate: app().localDate(createdAt),
      updatedAt: asIso(row.updated_at, createdAt),
      deletedAt: row.deleted_at ? asIso(row.deleted_at) : null,
      mastery: 0,
      reviewCount: 0,
      errorCount: 0,
      streak: 0,
      lastResult: null,
      lastReviewedAt: null,
      nextReviewAt: null,
      syncState: "synced",
    };
  }

  function cloudReview(row) {
    const reviewedAt = asIso(row.reviewed_at);
    return {
      id: row.id,
      wordId: row.word_id,
      result: row.result,
      reviewedAt,
      reviewedDate: app().localDate(reviewedAt),
      syncState: "synced",
    };
  }

  function serializeWord(word, userId) {
    return {
      id: word.id,
      user_id: userId,
      term: word.term,
      translation: word.translation,
      normalized: word.normalized || normalize(word.term),
      created_at: asIso(word.createdAt),
      updated_at: asIso(word.updatedAt, word.createdAt),
      deleted_at: word.deletedAt ? asIso(word.deletedAt) : null,
    };
  }

  function serializeReview(review, userId) {
    return {
      id: review.id,
      user_id: userId,
      word_id: review.wordId,
      result: review.result,
      reviewed_at: asIso(review.reviewedAt),
    };
  }

  function wordCloudEqual(local, remote) {
    if (!remote) return false;
    return local.id === remote.id
      && local.term === remote.term
      && local.translation === remote.translation
      && normalize(local.term) === normalize(remote.term)
      && asIso(local.createdAt) === asIso(remote.createdAt)
      && asIso(local.updatedAt, local.createdAt) === asIso(remote.updatedAt, remote.createdAt)
      && (local.deletedAt ? asIso(local.deletedAt) : null) === (remote.deletedAt ? asIso(remote.deletedAt) : null);
  }

  function selectWordWinner(entries) {
    const deleted = entries.filter((entry) => entry.word.deletedAt);
    const pool = deleted.length ? deleted : entries;
    return [...pool].sort((a, b) => {
      const time = String(b.word.updatedAt || b.word.createdAt || "").localeCompare(String(a.word.updatedAt || a.word.createdAt || ""));
      if (time) return time;
      if (a.source !== b.source) return a.source === "remote" ? -1 : 1;
      return String(a.word.id).localeCompare(String(b.word.id));
    })[0];
  }

  function mergeDatasets(localWords, localReviews, remoteWords, remoteReviews) {
    const groups = new Map();
    const add = (word, source) => {
      const normalized = word.normalized || normalize(word.term);
      const key = normalized || `id:${word.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ word: { ...word, normalized }, source });
    };
    localWords.forEach((word) => add(word, "local"));
    remoteWords.forEach((word) => add(word, "remote"));

    const idMap = new Map();
    const words = [];
    const pendingWords = [];
    for (const entries of groups.values()) {
      const remoteEntries = entries.filter((entry) => entry.source === "remote");
      const canonical = remoteEntries.length
        ? [...remoteEntries].sort((a, b) => String(a.word.createdAt).localeCompare(String(b.word.createdAt)) || String(a.word.id).localeCompare(String(b.word.id)))[0]
        : [...entries].sort((a, b) => String(a.word.createdAt).localeCompare(String(b.word.createdAt)) || String(a.word.id).localeCompare(String(b.word.id)))[0];
      const winner = selectWordWinner(entries).word;
      entries.forEach(({ word }) => idMap.set(word.id, canonical.word.id));
      const merged = {
        ...winner,
        id: canonical.word.id,
        normalized: canonical.word.normalized,
        createdAt: entries.map(({ word }) => asIso(word.createdAt)).sort()[0],
        createdDate: app().localDate(entries.map(({ word }) => asIso(word.createdAt)).sort()[0]),
        updatedAt: entries.map(({ word }) => asIso(word.updatedAt, word.createdAt)).sort().at(-1),
        deletedAt: entries.some(({ word }) => word.deletedAt)
          ? entries.filter(({ word }) => word.deletedAt).map(({ word }) => asIso(word.deletedAt)).sort().at(-1)
          : null,
      };
      const remoteCanonical = remoteEntries.find(({ word }) => word.id === merged.id)?.word;
      merged.syncState = wordCloudEqual(merged, remoteCanonical) ? "synced" : "pending";
      words.push(merged);
      if (merged.syncState === "pending") pendingWords.push(merged);
    }

    const remoteReviewMap = new Map(remoteReviews.map((review) => [review.id, review]));
    const reviewMap = new Map();
    for (const review of remoteReviews) reviewMap.set(review.id, { ...review, wordId: idMap.get(review.wordId) || review.wordId, syncState: "synced" });
    for (const review of localReviews) {
      const rekeyed = { ...review, id: typeof review.id === "string" ? review.id : uuid(), wordId: idMap.get(review.wordId) || review.wordId };
      const remote = remoteReviewMap.get(rekeyed.id);
      reviewMap.set(rekeyed.id, remote
        ? { ...remote, wordId: idMap.get(remote.wordId) || remote.wordId, syncState: "synced" }
        : { ...rekeyed, syncState: "pending" });
    }
    const reviews = [...reviewMap.values()];
    const pendingReviews = reviews.filter((review) => review.syncState === "pending");
    return { words, reviews, pendingWords, pendingReviews, idMap };
  }

  function recomputeSrs(words, reviews) {
    const reviewsByWord = new Map();
    reviews.forEach((review) => {
      if (!reviewsByWord.has(review.wordId)) reviewsByWord.set(review.wordId, []);
      reviewsByWord.get(review.wordId).push(review);
    });
    return words.map((word) => {
      let derived = {
        ...word,
        mastery: 0,
        reviewCount: 0,
        errorCount: 0,
        streak: 0,
        lastResult: null,
        lastReviewedAt: null,
        nextReviewAt: null,
      };
      const history = [...(reviewsByWord.get(word.id) || [])].sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt)) || String(a.id).localeCompare(String(b.id)));
      history.forEach((review) => {
        derived = app().getSrsUpdate(derived, review.result, new Date(review.reviewedAt));
        delete derived.intervalDays;
      });
      return derived;
    });
  }

  async function fetchCloud() {
    const [wordRows, reviewRows] = await Promise.all([
      apiFetch("/rest/v1/words?select=id,user_id,term,translation,normalized,created_at,updated_at,deleted_at&order=created_at.asc"),
      apiFetch("/rest/v1/reviews?select=id,user_id,word_id,result,reviewed_at&order=reviewed_at.asc"),
    ]);
    return { words: wordRows.map(cloudWord), reviews: reviewRows.map(cloudReview) };
  }

  async function uploadBatches(table, rows, conflict, prefer) {
    for (let index = 0; index < rows.length; index += 200) {
      await apiFetch(`/rest/v1/${table}?on_conflict=${conflict}`, {
        method: "POST",
        headers: { Prefer: `${prefer},return=minimal` },
        body: JSON.stringify(rows.slice(index, index + 200)),
      });
    }
  }

  async function performSync(attempt = 0) {
    await ensureFreshSession();
    const userId = state.session.user?.id || state.user?.id;
    if (!userId) throw new Error("无法确定当前用户");
    const [localWords, localReviews, cloud] = await Promise.all([
      app().getAll(app().stores.words),
      app().getAll(app().stores.reviews),
      fetchCloud(),
    ]);
    const merged = mergeDatasets(localWords, localReviews, cloud.words, cloud.reviews);
    try {
      await uploadBatches("words", merged.pendingWords.map((word) => serializeWord(word, userId)), "id", "resolution=merge-duplicates");
      await uploadBatches("reviews", merged.pendingReviews.map((review) => serializeReview(review, userId)), "id", "resolution=ignore-duplicates");
    } catch (error) {
      if (attempt === 0 && (error.status === 409 || error.code === "23505")) return performSync(1);
      throw error;
    }
    merged.pendingWords.forEach((word) => { word.syncState = "synced"; });
    merged.pendingReviews.forEach((review) => { review.syncState = "synced"; });
    const recalculated = recomputeSrs(merged.words, merged.reviews);
    await app().commitSyncedData(recalculated, merged.reviews);
    await app().saveSetting("lastSyncAt", nowIso());
  }

  async function syncNow() {
    if (state.syncPromise) return state.syncPromise;
    if (!state.session) {
      render();
      return;
    }
    if (!navigator.onLine) {
      state.message = "离线，本机已保存";
      render();
      return;
    }
    clearTimeout(state.timer);
    state.syncing = true;
    state.error = "";
    render();
    state.syncPromise = performSync()
      .then(() => { state.message = "同步完成"; })
      .catch(async (error) => {
        state.error = errorMessage(error);
        if (error.status === 401) await persistSession(null).catch(() => null);
        throw error;
      })
      .finally(() => {
        state.syncing = false;
        state.syncPromise = null;
        render();
      });
    return state.syncPromise;
  }

  function queue(delay = 700) {
    render();
    clearTimeout(state.timer);
    if (!state.session || !navigator.onLine) return;
    state.timer = setTimeout(() => syncNow().catch(() => null), delay);
  }

  async function pendingCount() {
    if (!app()?.getDb?.()) return 0;
    const [words, reviews] = await Promise.all([app().getAll(app().stores.words), app().getAll(app().stores.reviews)]);
    return words.filter((item) => item.syncState !== "synced").length + reviews.filter((item) => item.syncState !== "synced").length;
  }

  function render() {
    const badge = $("#syncStatusBtn");
    if (!badge) return;
    pendingCount().then((pending) => {
      let text = "☁️ 未登录";
      let mode = "signed-out";
      if (state.syncing) { text = "↻ 正在同步"; mode = "syncing"; }
      else if (!navigator.onLine) { text = "⚠️ 离线，本地已保存"; mode = "offline"; }
      else if (state.session && pending > 0) { text = `↑ ${pending} 条待同步`; mode = "pending"; }
      else if (state.session) { text = "☁️ 已同步"; mode = "synced"; }
      badge.textContent = text;
      badge.dataset.status = mode;
      badge.title = state.error || (state.session ? "打开设置或立即同步" : "打开设置并登录");
    }).catch(() => null);

    const signedIn = Boolean(state.session);
    if ($("#authForm")) $("#authForm").hidden = signedIn;
    if ($("#signedInPanel")) $("#signedInPanel").hidden = !signedIn;
    if ($("#signedInEmail")) $("#signedInEmail").textContent = state.session?.user?.email || state.user?.email || "已登录";
    if ($("#lastSyncText")) {
      const last = app()?.getState?.().settings.lastSyncAt;
      $("#lastSyncText").textContent = last ? `上次同步：${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(last))}` : "尚未完成同步";
    }
    if (state.error) setFeedback(state.error, true);
  }

  function setFeedback(message, isError = false) {
    const element = $("#authStatus");
    if (!element) return;
    element.textContent = message || "";
    element.classList.toggle("error", Boolean(isError));
    element.classList.toggle("success", Boolean(message) && !isError);
  }

  function setAuthBusy(busy) {
    ["#loginBtn", "#registerBtn", "#logoutBtn", "#syncNowSettingsBtn"].forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = busy;
    });
  }

  function openSettings() {
    if (typeof window.switchView === "function") window.switchView("settings");
    setTimeout(() => $("#accountTitle")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function bindEvents() {
    $("#authForm")?.addEventListener("submit", (event) => login(event).catch((error) => setFeedback(errorMessage(error), true)));
    $("#registerBtn")?.addEventListener("click", () => register().catch((error) => setFeedback(errorMessage(error), true)));
    $("#logoutBtn")?.addEventListener("click", () => logout().catch((error) => setFeedback(errorMessage(error), true)));
    $("#syncNowSettingsBtn")?.addEventListener("click", () => syncNow().catch((error) => setFeedback(errorMessage(error), true)));
    $("#syncStatusBtn")?.addEventListener("click", () => {
      if (state.session && navigator.onLine) syncNow().catch(() => null);
      openSettings();
    });
  }

  async function init() {
    if (state.initialized || !app()?.getDb?.()) return;
    state.initialized = true;
    bindEvents();
    if (!hasConfig()) {
      state.error = "Supabase 配置缺失";
      render();
      return;
    }
    try {
      const redirectSession = parseRedirectSession();
      if (redirectSession) await adoptSession(redirectSession);
      else {
        const stored = app().getState().settings.supabaseSession;
        if (stored) {
          state.session = normalizeSession(stored);
          state.user = state.session?.user || null;
          await ensureFreshSession();
          if (!state.session.user) {
            state.session.user = await apiFetch("/auth/v1/user");
            await persistSession(state.session);
          }
          await verifyOwner(state.session.user.id);
          if (navigator.onLine) await syncNow();
        }
      }
    } catch (error) {
      state.error = errorMessage(error);
      if (error.status === 401) await persistSession(null).catch(() => null);
    }
    render();
  }

  function networkChanged(online) {
    render();
    if (online && state.session) queue(100);
  }

  function onLocalReset() {
    clearTimeout(state.timer);
    state.session = null;
    state.user = null;
    state.error = "";
    state.message = "本机数据已清空，请重新登录";
    render();
  }

  window.MotJusteSync = { init, queue, syncNow, render, networkChanged, onLocalReset };
  window.MotJusteSyncTest = { mergeDatasets, recomputeSrs, cloudWord, cloudReview, serializeWord, serializeReview };
  document.addEventListener("motjuste:ready", () => init().catch(console.error), { once: true });
})();
