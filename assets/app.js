(function () {
  "use strict";

  const STORAGE_KEY = "scboard.ops.settings";
  const SESSION_TOKEN_KEY = "scboard.ops.token";
  const DEFAULT_LIMIT = 100;
  const DEFAULT_REFRESH_SECONDS = 60;
  const REQUEST_TIMEOUT_MS = 15000;
  const COLLECTION_ORDER = [
    "push_log",
    "hn_dashboard_summary",
    "hn_dashboard_ingest_runs",
    "hn_dashboard_cloud_sync_runs"
  ];
  const PREFERRED_COLUMNS = [
    "_id",
    "status",
    "ok",
    "action",
    "statusCode",
    "run_id",
    "syncVersion",
    "sync_version",
    "started_at",
    "ts",
    "publishedAt",
    "finished_at",
    "deadline_at",
    "phase",
    "raw_status",
    "stale",
    "overdue_seconds",
    "stories",
    "topics",
    "digests",
    "elapsed_seconds",
    "durationMs",
    "has_error",
    "signatureOk",
    "error",
    "counts",
    "metrics",
    "latestRun",
    "latestCloudSync",
    "ai"
  ];

  const config = Object.assign({
    dashboardEndpoint: "",
    refreshSeconds: DEFAULT_REFRESH_SECONDS
  }, window.SCBOARD_OPS_CONFIG || {});

  const state = {
    loading: false,
    timer: null,
    settings: loadSettings(),
    jsonStore: new Map(),
    jsonSeq: 0
  };

  const els = {
    refreshButton: document.getElementById("refreshButton"),
    freshness: document.getElementById("freshness"),
    alert: document.getElementById("alert"),
    settingsForm: document.getElementById("settingsForm"),
    endpointInput: document.getElementById("endpointInput"),
    tokenInput: document.getElementById("tokenInput"),
    limitInput: document.getElementById("limitInput"),
    refreshIntervalInput: document.getElementById("refreshIntervalInput"),
    headlineStatus: document.getElementById("headlineStatus"),
    headlineMeta: document.getElementById("headlineMeta"),
    metricStrip: document.getElementById("metricStrip"),
    collectionSections: document.getElementById("collectionSections"),
    rawJson: document.getElementById("rawJson")
  };

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (_) {
      saved = {};
    }
    return {
      endpoint: saved.endpoint || config.dashboardEndpoint || "",
      token: sessionStorage.getItem(SESSION_TOKEN_KEY) || "",
      limit: clampInt(saved.limit, DEFAULT_LIMIT, 1, 100),
      refreshInterval: clampInt(saved.refreshInterval, config.refreshSeconds, 0, 3600)
    };
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      endpoint: state.settings.endpoint,
      limit: state.settings.limit,
      refreshInterval: state.settings.refreshInterval
    }));
    if (state.settings.token) {
      sessionStorage.setItem(SESSION_TOKEN_KEY, state.settings.token);
    } else {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
    }
  }

  function clampInt(value, fallback, min, max) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function init() {
    bindSettings();
    renderEmpty();
    els.refreshButton.addEventListener("click", () => refresh());
    els.settingsForm.addEventListener("submit", event => {
      event.preventDefault();
      state.settings = {
        endpoint: els.endpointInput.value.trim(),
        token: els.tokenInput.value.trim(),
        limit: clampInt(els.limitInput.value, DEFAULT_LIMIT, 1, 100),
        refreshInterval: clampInt(els.refreshIntervalInput.value, DEFAULT_REFRESH_SECONDS, 0, 3600)
      };
      saveSettings();
      scheduleRefresh();
      refresh();
    });
    scheduleRefresh();
    refresh();
  }

  function bindSettings() {
    els.endpointInput.value = state.settings.endpoint;
    els.tokenInput.value = state.settings.token;
    els.limitInput.value = String(state.settings.limit);
    els.refreshIntervalInput.value = String(state.settings.refreshInterval);
  }

  function scheduleRefresh() {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    if (state.settings.refreshInterval > 0) {
      state.timer = window.setInterval(refresh, state.settings.refreshInterval * 1000);
    }
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    els.refreshButton.disabled = true;
    els.refreshButton.textContent = "Loading";
    els.headlineMeta.textContent = "Requesting dashboard API...";
    hideAlert();

    try {
      if (!state.settings.endpoint) {
        renderEmpty();
        showAlert("Configure the dashboard API endpoint to load live data.");
        return;
      }
      const snapshot = await fetchDashboard();
      els.headlineMeta.textContent = "Rendering dashboard data...";
      renderDashboard(snapshot);
    } catch (err) {
      showAlert(err.message || String(err));
    } finally {
      state.loading = false;
      els.refreshButton.disabled = false;
      els.refreshButton.textContent = "Refresh";
    }
  }

  async function fetchDashboard() {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(state.settings.endpoint, {
        method: "POST",
        mode: "cors",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        signal: controller.signal,
        body: JSON.stringify({
          token: state.settings.token,
          opsToken: state.settings.token,
          accessToken: state.settings.token,
          limit: state.settings.limit,
          ingestLimit: state.settings.limit,
          cloudSyncLimit: state.settings.limit,
          pushLogLimit: state.settings.limit
        })
      });

      const text = await response.text();
      const payload = parseJson(text);
      if (!response.ok) {
        const message = payload && (payload.message || payload.error && payload.error.message || payload.error);
        throw new Error(message || `HTTP ${response.status}`);
      }
      return normalizePayload(payload);
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`Dashboard API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function requestBodyForDebug() {
    return {
      token: state.settings.token ? "(configured)" : "",
      opsToken: state.settings.token ? "(configured)" : "",
      accessToken: state.settings.token ? "(configured)" : "",
      limit: state.settings.limit,
      ingestLimit: state.settings.limit,
      cloudSyncLimit: state.settings.limit,
      pushLogLimit: state.settings.limit
    };
  }

  /*
   * Kept separate from fetchDashboard so operators can inspect what is sent
   * without exposing the actual token in the page.
   */
  void requestBodyForDebug;

  function parseJson(text) {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error("Dashboard API returned non-JSON response");
    }
  }

  function normalizePayload(payload) {
    if (payload && typeof payload.body === "string") {
      payload = parseJson(payload.body);
    }
    if (payload && payload.error) {
      const err = payload.error;
      throw new Error(err.message || err.code || String(err));
    }
    if (!payload || payload.ok !== true) {
      throw new Error("Dashboard API returned an invalid envelope");
    }
    const normalized = Object.assign({}, payload);
    normalized.collections = normalizeCollections(payload);
    normalized.ingestRuns = Array.isArray(payload.ingestRuns) ? payload.ingestRuns : [];
    normalized.cloudSyncRuns = Array.isArray(payload.cloudSyncRuns) ? payload.cloudSyncRuns : [];
    normalized.asOf = payload.asOf || Math.floor(Date.now() / 1000);
    return normalized;
  }

  function normalizeCollections(payload) {
    if (Array.isArray(payload.collections)) {
      return payload.collections.map(item => ({
        name: item.name,
        count: Number.isInteger(item.count) ? item.count : (Array.isArray(item.docs) ? item.docs.length : 0),
        docs: Array.isArray(item.docs) ? item.docs : [],
        query: item.query,
        limit: item.limit,
        sort: item.sort
      }));
    }

    const summaryDocs = payload.summary ? [payload.summary] : [];
    return [
      { name: "hn_dashboard_summary", count: summaryDocs.length, docs: summaryDocs, query: { _id: "summary" } },
      {
        name: "hn_dashboard_ingest_runs",
        count: Array.isArray(payload.ingestRuns) ? payload.ingestRuns.length : 0,
        docs: Array.isArray(payload.ingestRuns) ? payload.ingestRuns : [],
        query: { syncVersion: payload.syncVersion }
      },
      {
        name: "hn_dashboard_cloud_sync_runs",
        count: Array.isArray(payload.cloudSyncRuns) ? payload.cloudSyncRuns.length : 0,
        docs: Array.isArray(payload.cloudSyncRuns) ? payload.cloudSyncRuns : [],
        query: { syncVersion: payload.syncVersion }
      }
    ];
  }

  function renderEmpty() {
    els.headlineStatus.textContent = "Waiting for live data";
    els.headlineMeta.textContent = "No dashboard API response has been loaded.";
    els.metricStrip.innerHTML = metricItems([
      ["Sync version", "-"],
      ["Published", "-"],
      ["As of", "-"],
      ["Collections", "-"],
      ["Documents", "-"],
      ["Limit", state.settings.limit]
    ]);
    els.collectionSections.innerHTML = `
      <section class="panel empty-panel">
        Configure the API endpoint and token, then refresh.
      </section>`;
    els.rawJson.textContent = "{}";
    els.freshness.textContent = "No data";
  }

  function renderDashboard(snapshot) {
    state.jsonStore.clear();
    state.jsonSeq = 0;
    const summary = snapshot.summary || {};
    const metrics = summary.metrics || {};
    const latestRun = summary.latestRun || {};
    const latestCloudSync = summary.latestCloudSync || {};
    const collections = orderedCollections(snapshot.collections);
    const docCount = collections.reduce((sum, collection) => sum + collection.docs.length, 0);
    const pipelineStatus = latestRun.status || "unknown";
    const syncStatus = latestCloudSync.status || "unknown";

    els.headlineStatus.innerHTML = `${statusBadge(pipelineStatus)} ${escapeHtml(labelForStatus(pipelineStatus))}`;
    els.headlineMeta.textContent = [
      `sync v${valueOrDash(snapshot.syncVersion || summary.syncVersion)}`,
      `published ${formatTime(summary.publishedAt)}`,
      "live data"
    ].join(" / ");

    els.metricStrip.innerHTML = metricItems([
      ["Sync version", valueOrDash(snapshot.syncVersion || summary.syncVersion)],
      ["Pipeline", labelForStatus(pipelineStatus)],
      ["Cloud sync", labelForStatus(syncStatus)],
      ["Collections", collections.length],
      ["Documents", docCount],
      ["Limit", state.settings.limit],
      ["Catalog", valueOrDash(metrics.catalog_version)],
      ["Stories", valueOrDash(metrics.total_stories)],
      ["Failure rate", formatPercent(metrics.failure_rate)]
    ]);

    els.collectionSections.innerHTML = collections.map(renderCollection).join("");
    els.rawJson.textContent = "Open this section to render the full response JSON.";
    els.rawJson.dataset.jsonId = storeJson(snapshot);
    els.freshness.textContent = `As of ${formatTime(snapshot.asOf)}`;
  }

  function orderedCollections(collections) {
    const list = Array.isArray(collections) ? collections.slice() : [];
    return list.sort((a, b) => {
      const ai = COLLECTION_ORDER.indexOf(a.name);
      const bi = COLLECTION_ORDER.indexOf(b.name);
      if (ai === -1 && bi === -1) return String(a.name).localeCompare(String(b.name));
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  function renderCollection(collection) {
    const docs = Array.isArray(collection.docs) ? collection.docs : [];
    const columns = collectionColumns(docs);
    return `
      <section class="panel collection-panel">
        <div class="panel__header">
          <div>
            <p class="section-label">Collection</p>
            <h3>${escapeHtml(collection.name || "(unknown)")}</h3>
          </div>
          <div class="collection-meta">
            <span>${docs.length} docs</span>
            ${collection.limit ? `<span>limit ${escapeHtml(collection.limit)}</span>` : ""}
            ${collection.sort ? `<span>${escapeHtml(collection.sort)}</span>` : ""}
          </div>
        </div>
        ${collection.query ? `<div class="query-line">query: ${valueHtml(collection.query)}</div>` : ""}
        ${docs.length ? renderTable(docs, columns) : `<div class="empty-panel">No documents returned.</div>`}
      </section>`;
  }

  function collectionColumns(docs) {
    const keys = new Set();
    docs.forEach(doc => {
      if (doc && typeof doc === "object") {
        Object.keys(doc).forEach(key => keys.add(key));
      }
    });
    const preferred = PREFERRED_COLUMNS.filter(key => keys.has(key));
    const rest = Array.from(keys)
      .filter(key => !preferred.includes(key))
      .sort((a, b) => a.localeCompare(b));
    return preferred.concat(rest);
  }

  function renderTable(docs, columns) {
    return `
      <div class="table-wrap">
        <table class="collection-table">
          <thead>
            <tr>
              ${columns.map(column => `<th>${escapeHtml(labelForKey(column))}</th>`).join("")}
              <th>raw doc</th>
            </tr>
          </thead>
          <tbody>
            ${docs.map(doc => renderRow(doc, columns)).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderRow(doc, columns) {
    return `
      <tr>
        ${columns.map(column => `<td>${valueHtml(doc ? doc[column] : undefined, column)}</td>`).join("")}
        <td>${rawDetails(doc, "open")}</td>
      </tr>`;
  }

  function metricItems(items) {
    return items.map(([label, value]) => (
      `<div><dt>${escapeHtml(label)}</dt><dd>${valueHtml(value)}</dd></div>`
    )).join("");
  }

  function valueHtml(value, key) {
    if (value === null || value === undefined || value === "") return `<span class="muted">-</span>`;
    if (typeof value === "boolean") return escapeHtml(value ? "true" : "false");
    if (key && looksLikeTimeKey(key)) {
      return `${escapeHtml(formatTime(value))}<span class="subtle">${escapeHtml(String(value))}</span>`;
    }
    if (key && looksLikeDurationKey(key)) {
      return escapeHtml(formatSeconds(value));
    }
    if (typeof value === "object") {
      return rawDetails(value, Array.isArray(value) ? `${value.length} items` : "object");
    }
    return escapeHtml(String(value));
  }

  function rawDetails(value, label) {
    const id = storeJson(value);
    return `
      <details class="row-details js-json" data-json-id="${escapeHtml(id)}">
        <summary>${escapeHtml(label || "json")}</summary>
        <pre>Open to render JSON.</pre>
      </details>`;
  }

  function storeJson(value) {
    const id = `json-${state.jsonSeq++}`;
    state.jsonStore.set(id, value);
    return id;
  }

  function renderStoredJson(pre, id) {
    if (!pre || !id || pre.dataset.rendered === "1") return;
    const value = state.jsonStore.get(id);
    pre.textContent = JSON.stringify(value, null, 2);
    pre.dataset.rendered = "1";
  }

  function statusBadge(status) {
    const text = String(status || "unknown");
    return `<span class="status ${statusClass(text)}">${escapeHtml(text)}</span>`;
  }

  function statusClass(status) {
    const s = status.toLowerCase();
    if (["ok", "success", "healthy", "true"].includes(s)) return "status--ok";
    if (["failed", "error", "stale", "false"].includes(s)) return "status--bad";
    if (["warning", "deferred"].includes(s)) return "status--warn";
    if (["running", "in_progress"].includes(s)) return "status--info";
    return "status--idle";
  }

  function labelForStatus(status) {
    const text = String(status || "unknown");
    if (text === "ok") return "OK";
    return text.replace(/_/g, " ");
  }

  function labelForKey(key) {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ");
  }

  function valueOrDash(value) {
    if (value === null || value === undefined || value === "") return "-";
    return value;
  }

  function formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
  }

  function formatTime(value) {
    if (!value) return "-";
    const n = Number(value);
    const date = Number.isFinite(n)
      ? new Date(n > 1000000000000 ? n : n * 1000)
      : new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString();
  }

  function formatSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    if (n < 1) return `${Math.round(n * 1000)} ms`;
    return `${n.toFixed(n < 10 ? 1 : 0)} s`;
  }

  function looksLikeTimeKey(key) {
    return /(^ts$|_at$|At$|Time$|publishedAt|serverTime)/.test(String(key));
  }

  function looksLikeDurationKey(key) {
    return /seconds|duration|elapsed|durationMs/i.test(String(key));
  }

  function showAlert(message) {
    els.alert.textContent = message;
    els.alert.hidden = false;
  }

  function hideAlert() {
    els.alert.hidden = true;
    els.alert.textContent = "";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  document.addEventListener("toggle", event => {
    const details = event.target;
    if (!details || !details.open) return;
    if (details.classList && details.classList.contains("js-json")) {
      renderStoredJson(details.querySelector("pre"), details.dataset.jsonId);
      return;
    }
    const rawJson = details.querySelector && details.querySelector("#rawJson");
    if (rawJson) {
      renderStoredJson(rawJson, rawJson.dataset.jsonId);
    }
  }, true);

  init();
}());
