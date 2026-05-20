(function () {
  "use strict";

  const STORAGE_KEY = "scboard.ops.settings";
  const SESSION_TOKEN_KEY = "scboard.ops.token";
  const SETTINGS_SCHEMA_VERSION = 2;
  const APP_VERSION = "ops-debug-2026-05-20-2";
  const DEFAULT_LIMIT = 20;
  const DEFAULT_REFRESH_SECONDS = 0;
  const REQUEST_TIMEOUT_MS = 60000;
  const REQUEST_RETRY_DELAY_MS = 1200;
  const COLLECTION_ORDER = [
    "push_log",
    "hn_dashboard_summary",
    "hn_dashboard_ingest_runs",
    "hn_dashboard_cloud_sync_runs"
  ];
  const COLLECTION_LABELS = {
    push_log: "Push log",
    hn_dashboard_summary: "Dashboard summary",
    hn_dashboard_ingest_runs: "Ingest runs",
    hn_dashboard_cloud_sync_runs: "Cloud sync runs"
  };
  const COLLECTION_HELP = {
    push_log: "Recent pushSync API calls and their outcome, useful for troubleshooting failed or partial publishes.",
    hn_dashboard_summary: "One current summary document for the published dashboard snapshot.",
    hn_dashboard_ingest_runs: "Recent ingest pipeline runs for the selected sync version.",
    hn_dashboard_cloud_sync_runs: "Recent cloud sync runs for the selected sync version."
  };
  const FIELD_LABELS = {
    raw_status: "Original status"
  };
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
    "ai",
    "insights"
  ];
  const TABLE_MAX_COLUMNS = 6;
  const COLLECTION_TABLE_COLUMNS = {
    push_log: ["action", "ok", "statusCode", "syncVersion", "ts", "counts"],
    hn_dashboard_summary: ["syncVersion", "publishedAt", "metrics", "latestRun", "latestCloudSync", "insights"],
    hn_dashboard_ingest_runs: ["status", "run_id", "syncVersion", "started_at", "finished_at", "elapsed_seconds"],
    hn_dashboard_cloud_sync_runs: ["status", "run_id", "syncVersion", "started_at", "finished_at", "elapsed_seconds"],
    default: ["status", "ok", "action", "run_id", "syncVersion", "started_at"]
  };

  const config = Object.assign({
    dashboardEndpoint: "",
    refreshSeconds: DEFAULT_REFRESH_SECONDS
  }, window.SCBOARD_OPS_CONFIG || {});

  const state = {
    loading: false,
    timer: null,
    snapshot: null,
    loadingCollections: new Set(),
    settings: loadSettings()
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
    collectionSections: document.getElementById("collectionSections")
  };
  els.debugLog = document.getElementById("debugLog");
  els.copyLogButton = document.getElementById("copyLogButton");
  els.clearLogButton = document.getElementById("clearLogButton");
  els.testApiButton = document.getElementById("testApiButton");

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (_) {
      saved = {};
    }
    const endpoint = normalizeEndpoint(saved.endpoint || config.dashboardEndpoint || "");
    const savedVersion = clampInt(saved.settingsVersion, 0, 0, SETTINGS_SCHEMA_VERSION);
    const refreshInterval = savedVersion >= SETTINGS_SCHEMA_VERSION
      ? clampInt(saved.refreshInterval, config.refreshSeconds, 0, 3600)
      : config.refreshSeconds;
    return {
      endpoint,
      token: sessionStorage.getItem(SESSION_TOKEN_KEY) || "",
      limit: clampInt(saved.limit, DEFAULT_LIMIT, 1, 100),
      refreshInterval
    };
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      settingsVersion: SETTINGS_SCHEMA_VERSION,
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

  function normalizeEndpoint(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/^https:\/\//i.test(text)) return text;
    if (isLocalHttpEndpoint(text)) return text;
    return "";
  }

  function endpointProblem(value) {
    const text = String(value || "").trim();
    if (!text) return "Configure the dashboard API endpoint to load live data.";
    if (/^file:/i.test(text)) return "The API endpoint is set to a local file:// URL. Enter the real https:// dashboard API endpoint.";
    if (!/^https?:\/\//i.test(text)) return "The API endpoint must start with https://.";
    if (/^http:\/\//i.test(text) && !isLocalHttpEndpoint(text)) return "The API endpoint must use https:// outside local development.";
    return "";
  }

  function isLocalHttpEndpoint(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
    } catch (_) {
      return false;
    }
  }

  function init() {
    bindSettings();
    renderEmpty();
    logDebug("init", {
      version: APP_VERSION,
      pageProtocol: window.location.protocol,
      endpointConfigured: Boolean(state.settings.endpoint),
      tokenConfigured: Boolean(state.settings.token),
      limit: state.settings.limit,
      autoRefreshSeconds: state.settings.refreshInterval
    });
    if (window.location.protocol === "file:") {
      showAlert("This page is opened as file://. Use an http:// local server or the deployed Web URL for reliable API requests.");
      logDebug("file protocol detected; browser may block or delay cross-origin API requests", {
        href: window.location.href
      }, "error");
    }
    els.refreshButton.addEventListener("click", () => refresh());
    if (els.clearLogButton) {
      els.clearLogButton.addEventListener("click", () => {
        if (els.debugLog) els.debugLog.textContent = "";
        logDebug("debug log cleared");
      });
    }
    if (els.copyLogButton) {
      els.copyLogButton.addEventListener("click", copyDebugLog);
    }
    if (els.testApiButton) {
      els.testApiButton.addEventListener("click", testApi);
    }
    els.settingsForm.addEventListener("submit", event => {
      event.preventDefault();
      const endpointInput = els.endpointInput.value.trim();
      const endpoint = normalizeEndpoint(endpointInput);
      state.settings = {
        endpoint,
        token: els.tokenInput.value.trim(),
        limit: clampInt(els.limitInput.value, DEFAULT_LIMIT, 1, 100),
        refreshInterval: clampInt(els.refreshIntervalInput.value, DEFAULT_REFRESH_SECONDS, 0, 3600)
      };
      saveSettings();
      if (endpoint !== endpointInput) {
        els.endpointInput.value = endpoint;
      }
      logDebug("settings applied", {
        endpoint: state.settings.endpoint || endpointInput || "(empty)",
        tokenConfigured: Boolean(state.settings.token),
        limit: state.settings.limit,
        autoRefreshSeconds: state.settings.refreshInterval
      });
      const problem = endpointProblem(endpointInput);
      if (problem) {
        showAlert(problem);
        logDebug("settings rejected endpoint", { endpoint: endpointInput || "(empty)" }, "error");
        return;
      }
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
      logDebug("auto refresh timer cleared");
    }
    if (state.settings.refreshInterval > 0) {
      state.timer = window.setInterval(refresh, state.settings.refreshInterval * 1000);
      logDebug("auto refresh timer set", { seconds: state.settings.refreshInterval });
    }
  }

  async function refresh() {
    if (state.loading) {
      logDebug("refresh skipped: previous request still loading");
      return;
    }
    const startedAt = Date.now();
    state.loading = true;
    els.refreshButton.disabled = true;
    els.refreshButton.textContent = "Loading";
    els.headlineMeta.textContent = "Requesting dashboard API...";
    hideAlert();
    logDebug("refresh start", {
      endpoint: state.settings.endpoint,
      tokenConfigured: Boolean(state.settings.token),
      limit: state.settings.limit
    });

    try {
      const problem = endpointProblem(state.settings.endpoint);
      if (problem) {
        renderEmpty();
        showAlert(problem);
        logDebug("refresh stopped: invalid endpoint", { endpoint: state.settings.endpoint || "(empty)" });
        return;
      }
      const snapshot = await fetchDashboardWithRetry();
      logDebug("fetch complete", {
        elapsedMs: Date.now() - startedAt,
        collections: Array.isArray(snapshot.collections) ? snapshot.collections.length : 0,
        syncVersion: snapshot.syncVersion
      });
      els.headlineMeta.textContent = "Rendering dashboard data...";
      const renderStartedAt = Date.now();
      state.snapshot = snapshot;
      renderDashboard(snapshot);
      logDebug("render complete", {
        elapsedMs: Date.now() - renderStartedAt,
        totalElapsedMs: Date.now() - startedAt
      });
    } catch (err) {
      showAlert(err.message || String(err));
      logDebug("refresh failed", {
        elapsedMs: Date.now() - startedAt,
        name: err && err.name,
        message: err && err.message ? err.message : String(err)
      }, "error");
    } finally {
      state.loading = false;
      els.refreshButton.disabled = false;
      els.refreshButton.textContent = "Refresh";
      logDebug("refresh end", { elapsedMs: Date.now() - startedAt });
    }
  }

  async function testApi() {
    if (state.loading) {
      logDebug("test api skipped: request already loading");
      return;
    }
    state.loading = true;
    if (els.testApiButton) els.testApiButton.disabled = true;
    hideAlert();
    const startedAt = Date.now();
    logDebug("test api start", {
      endpoint: state.settings.endpoint,
      tokenConfigured: Boolean(state.settings.token)
    });
    try {
      const problem = endpointProblem(state.settings.endpoint);
      if (problem) {
        showAlert(problem);
        logDebug("test api stopped: invalid endpoint", { endpoint: state.settings.endpoint || "(empty)" });
        return;
      }
      const version = await fetchVersionProbe();
      logDebug("version probe success", {
        elapsedMs: Date.now() - startedAt,
        version: version && version.version,
        asOf: version && version.asOf
      });
      const payload = await fetchDashboardWithRetry({ debugPing: true, limit: 1, ingestLimit: 1, cloudSyncLimit: 1 });
      logDebug("test api success", {
        elapsedMs: Date.now() - startedAt,
        pong: payload && payload.pong,
        debugPing: payload && payload.debugPing,
        version: payload && payload.version,
        asOf: payload && payload.asOf
      });
      showAlert("Test API succeeded. HTTP access and token auth are working.");
    } catch (err) {
      logDebug("test api failed", {
        elapsedMs: Date.now() - startedAt,
        name: err && err.name,
        message: err && err.message ? err.message : String(err)
      }, "error");
      showAlert(err.message || String(err));
    } finally {
      state.loading = false;
      if (els.testApiButton) els.testApiButton.disabled = false;
    }
  }

  async function fetchVersionProbe() {
    const url = appendQuery(state.settings.endpoint, "versionProbe=1");
    logDebug("version probe request", { url, method: "GET", timeoutMs: REQUEST_TIMEOUT_MS });
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        signal: controller.signal
      });
      logDebug("version probe response headers", {
        elapsedMs: Date.now() - startedAt,
        status: response.status,
        ok: response.ok,
        type: response.type
      });
      const text = await response.text();
      logDebug("version probe response body", {
        elapsedMs: Date.now() - startedAt,
        chars: text.length,
        content: "received"
      });
      const payload = parseJson(text);
      if (!response.ok) {
        const message = payload && (payload.message || payload.error && payload.error.message || payload.error);
        throw new Error(message || `HTTP ${response.status}`);
      }
      return normalizePayload(payload);
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`Version probe timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function fetchDashboardWithRetry(extraBody) {
    try {
      return await fetchDashboard(extraBody, 1);
    } catch (err) {
      if (!err || err.name !== "AbortError") throw err;
      logDebug("fetch timeout; retrying once after short delay", {
        delayMs: REQUEST_RETRY_DELAY_MS,
        nextAttempt: 2
      }, "error");
      await sleep(REQUEST_RETRY_DELAY_MS);
      return fetchDashboard(extraBody, 2);
    }
  }

  async function fetchDashboard(extraBody, attempt) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    const body = Object.assign({
      limit: state.settings.limit,
      pushLogLimit: state.settings.limit,
      ingestLimit: state.settings.limit,
      cloudSyncLimit: state.settings.limit
    }, extraBody || {});
      logDebug("fetch request prepared", {
      endpoint: state.settings.endpoint,
      method: "POST",
      contentType: "application/json",
      timeoutMs: REQUEST_TIMEOUT_MS,
      attempt: attempt || 1,
      body: redactRequestBody(body)
    });

    try {
      logDebug("fetch sending", { attempt: attempt || 1 });
      const response = await fetch(state.settings.endpoint, {
        method: "POST",
        mode: "cors",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${state.settings.token}`
        },
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      logDebug("fetch response headers received", {
        elapsedMs: Date.now() - startedAt,
        status: response.status,
        ok: response.ok,
        type: response.type
      });

      const text = await response.text();
      logDebug("fetch response body received", {
        elapsedMs: Date.now() - startedAt,
        chars: text.length,
        content: "received"
      });
      const payload = parseJson(text);
      logDebug("response JSON parsed", {
        hasOk: payload && Object.prototype.hasOwnProperty.call(payload, "ok"),
        hasBodyWrapper: payload && typeof payload.body === "string",
        hasError: Boolean(payload && payload.error)
      });
      if (!response.ok) {
        const message = payload && (payload.message || payload.error && payload.error.message || payload.error);
        throw new Error(message || `HTTP ${response.status}`);
      }
      return normalizePayload(payload);
    } catch (err) {
      if (err && err.name === "AbortError") {
        logDebug("fetch aborted by timeout", {
          elapsedMs: Date.now() - startedAt,
          attempt: attempt || 1
        }, "error");
        const timeoutErr = new Error(`Dashboard API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
        timeoutErr.name = "AbortError";
        throw timeoutErr;
      }
      logDebug("fetch error", {
        elapsedMs: Date.now() - startedAt,
        name: err && err.name,
        message: err && err.message ? err.message : String(err)
      }, "error");
      throw err;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function requestBodyForDebug() {
    return {
      tokenHeader: state.settings.token ? "(configured)" : "",
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
      logDebug("JSON parse failed", { chars: String(text || "").length }, "error");
      throw new Error("Dashboard API returned non-JSON response");
    }
  }

  function appendQuery(url, query) {
    return `${url}${url.indexOf("?") === -1 ? "?" : "&"}${query}`;
  }

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function normalizePayload(payload) {
    if (payload && typeof payload.body === "string") {
      logDebug("normalizing CloudBase HTTP body wrapper");
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
    if (payload.collection) {
      normalized.collection = normalizeCollection(payload.collection);
    }
    normalized.ingestRuns = Array.isArray(payload.ingestRuns) ? payload.ingestRuns : [];
    normalized.cloudSyncRuns = Array.isArray(payload.cloudSyncRuns) ? payload.cloudSyncRuns : [];
    normalized.asOf = payload.asOf || Math.floor(Date.now() / 1000);
      logDebug("payload normalized", {
        collections: normalized.collections.length,
        ingestRuns: normalized.ingestRuns.length,
      cloudSyncRuns: normalized.cloudSyncRuns.length,
      asOf: normalized.asOf
    });
    return normalized;
  }

  function normalizeCollections(payload) {
    if (Array.isArray(payload.collections)) {
      logDebug("using payload.collections", { count: payload.collections.length });
      return payload.collections.map(normalizeCollection);
    }

    const summaryDocs = payload.summary ? [payload.summary] : [];
    logDebug("payload.collections missing; derived collections from legacy fields");
    return [
      { name: "hn_dashboard_summary", count: summaryDocs.length, docs: summaryDocs, loaded: true, query: { _id: "summary" } },
      {
        name: "hn_dashboard_ingest_runs",
        count: Array.isArray(payload.ingestRuns) ? payload.ingestRuns.length : 0,
        docs: Array.isArray(payload.ingestRuns) ? payload.ingestRuns : [],
        loaded: true,
        query: { syncVersion: payload.syncVersion }
      },
      {
        name: "hn_dashboard_cloud_sync_runs",
        count: Array.isArray(payload.cloudSyncRuns) ? payload.cloudSyncRuns.length : 0,
        docs: Array.isArray(payload.cloudSyncRuns) ? payload.cloudSyncRuns : [],
        loaded: true,
        query: { syncVersion: payload.syncVersion }
      }
    ];
  }

  function normalizeCollection(item) {
    const docs = Array.isArray(item && item.docs) ? item.docs : [];
    return {
      name: item && item.name,
      count: Number.isInteger(item && item.count) ? item.count : docs.length,
      docs,
      loaded: item && item.loaded === false ? false : Array.isArray(item && item.docs),
      query: item && item.query,
      limit: item && item.limit,
      sort: item && item.sort
    };
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
        <p class="empty-panel__title">No dashboard snapshot loaded</p>
        <p>Configure the API endpoint and token, then refresh. Once data arrives, every returned field is rendered as labeled, readable content instead of a machine-shaped payload.</p>
      </section>`;
    els.freshness.textContent = "No data";
  }

  function renderDashboard(snapshot) {
    const summary = snapshot.summary || {};
    const metrics = summary.metrics || {};
    const latestRun = summary.latestRun || {};
    const latestCloudSync = summary.latestCloudSync || {};
    const insights = summary.insights || {};
    const latestInsights = insights.latest || {};
    const collections = orderedCollections(snapshot.collections);
    const docCount = collections.reduce((sum, collection) => sum + collection.docs.length, 0);
    const pipelineStatus = latestRun.status || "unknown";
    const syncStatus = latestCloudSync.status || "unknown";
    const insightsStatus = insightsHealthStatus(insights);

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
      ["Rows loaded", docCount],
      ["Limit", state.settings.limit],
      ["Catalog", valueOrDash(metrics.catalog_version)],
      ["Stories", valueOrDash(metrics.total_stories)],
      ["Failure rate", formatPercent(metrics.failure_rate)],
      ["Insights", labelForStatus(insightsStatus)],
      ["Insights latest", latestInsights.generated_at ? formatTime(latestInsights.generated_at) : "-"],
      ["Insights interval", formatIntervalSeconds(insights.update_interval_seconds)]
    ]);

    els.collectionSections.innerHTML = collections.map(renderCollection).join("");
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
    const name = collection.name || "(unknown)";
    const loaded = collection.loaded === true;
    const loading = state.loadingCollections.has(name);
    return `
      <section class="panel collection-panel" data-collection="${escapeHtml(name)}">
        <div class="panel__header">
          <div>
            <p class="section-label">Collection</p>
            <h3>${escapeHtml(labelForCollection(name))}</h3>
            <p class="panel-description">${escapeHtml(COLLECTION_HELP[name] || "Returned dashboard records from the protected ops API.")}</p>
          </div>
          <div class="collection-meta">
            <span>${loaded ? `${docs.length} docs` : "not loaded"}</span>
            ${collection.limit ? `<span>limit ${escapeHtml(collection.limit)}</span>` : ""}
            ${collection.sort ? `<span>${escapeHtml(collection.sort)}</span>` : ""}
            <button class="button button--compact js-load-collection" type="button" data-collection="${escapeHtml(name)}" ${loading ? "disabled" : ""}>
              ${loaded ? "Reload" : (loading ? "Loading" : "Load rows")}
            </button>
          </div>
        </div>
        ${renderCollectionContext(collection, docs)}
        ${loaded ? (docs.length ? renderRecords(docs, columns, name) : `<div class="empty-panel">No documents returned.</div>`) : renderDeferredCollection(name)}
      </section>`;
  }

  function renderDeferredCollection(name) {
    return `
      <div class="empty-panel empty-panel--compact">
        <p class="empty-panel__title">${escapeHtml(labelForCollection(name))} details are not loaded.</p>
        <p>Use Load rows to fetch this collection only.</p>
      </div>`;
  }

  function renderCollectionContext(collection, docs) {
    const fields = [
      ["Source collection", collection.name || "(unknown)"],
      ["Returned documents", collection.loaded === true ? docs.length : "not loaded"]
    ];
    if (collection.count !== undefined && collection.count !== docs.length) {
      fields.push(["Reported count", collection.count]);
    }
    if (collection.query !== undefined) fields.push(["Query", collection.query]);
    if (collection.sort !== undefined) fields.push(["Sort", collection.sort]);
    if (collection.limit !== undefined) fields.push(["Limit", collection.limit]);

    return `
      <div class="collection-context">
        <dl class="field-list field-list--context">
          ${fields.map(([label, value]) => renderNamedField(label, value)).join("")}
        </dl>
      </div>`;
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

  function renderRecords(docs, columns, collectionName) {
    const visibleColumns = tableColumns(columns, collectionName);
    const columnCount = visibleColumns.length + 2;
    return `
      <div class="table-wrap">
        <table class="collection-table">
          <thead>
            <tr>
              <th class="toggle-column" aria-label="Expand row"></th>
              <th>Record</th>
              ${visibleColumns.map(column => `<th>${escapeHtml(labelForKey(column))}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${docs.map((doc, index) => renderRecordRows(doc, columns, visibleColumns, collectionName, index, columnCount)).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderRecordRows(doc, allColumns, visibleColumns, collectionName, index, columnCount) {
    const meta = recordMeta(doc);
    const badges = recordBadges(doc);
    const detailId = `detail-${safeDomId(collectionName)}-${index}`;
    return `
      <tr class="record-row js-record-row" tabindex="0" data-detail-id="${escapeHtml(detailId)}" aria-expanded="false">
        <td class="toggle-cell">
          <button class="row-toggle js-row-toggle" type="button" aria-expanded="false" aria-controls="${escapeHtml(detailId)}">
            <span class="row-toggle__icon" aria-hidden="true">›</span>
            <span>Details</span>
          </button>
        </td>
        <th scope="row" class="record-title-cell">
          <span class="record-title-main">${escapeHtml(recordTitle(doc, collectionName, index))}</span>
          ${meta ? `<span class="record-title-meta">${meta}</span>` : ""}
          ${badges ? `<span class="record-title-badges">${badges}</span>` : ""}
        </th>
        ${visibleColumns.map(column => `<td>${tableValueHtml(doc ? doc[column] : undefined, column)}</td>`).join("")}
      </tr>
      <tr id="${escapeHtml(detailId)}" class="record-detail-row" hidden>
        <td class="record-detail-cell" colspan="${columnCount}">
          <div class="detail-panel">
            <dl class="field-list field-list--detail">
              ${allColumns.map(column => renderField(column, doc ? doc[column] : undefined)).join("")}
            </dl>
            <details class="raw-json-detail">
              <summary>Raw JSON</summary>
              <pre>${escapeHtml(formatJson(doc || {}))}</pre>
            </details>
          </div>
        </td>
      </tr>`;
  }

  function tableColumns(columns, collectionName) {
    const preferred = COLLECTION_TABLE_COLUMNS[collectionName] || COLLECTION_TABLE_COLUMNS.default;
    const selected = [];
    preferred.forEach(column => {
      if (columns.includes(column) && !selected.includes(column)) selected.push(column);
    });
    columns.forEach(column => {
      if (column !== "_id" && !selected.includes(column)) selected.push(column);
    });
    return selected.slice(0, TABLE_MAX_COLUMNS);
  }

  function tableValueHtml(value, key) {
    if (value === null || value === undefined || value === "") return `<span class="muted">-</span>`;
    if (typeof value === "boolean") return booleanBadge(value, "Yes", "No");
    if (key && looksLikeTimeKey(key)) return escapeHtml(formatTime(value));
    if (key && looksLikeDurationKey(key)) return escapeHtml(formatDuration(value, key));
    if (key && looksLikeRateKey(key)) return escapeHtml(formatPercent(value));
    if (Array.isArray(value)) return `<span class="muted">${value.length} items</span>`;
    if (typeof value === "object") return `<span class="muted">${Object.keys(value).length} fields</span>`;
    return `<span class="cell-text">${escapeHtml(String(value))}</span>`;
  }

  function metricItems(items) {
    return items.map(([label, value]) => (
      `<div><dt>${escapeHtml(label)}</dt><dd>${valueHtml(value)}</dd></div>`
    )).join("");
  }

  function valueHtml(value, key) {
    if (value === null || value === undefined || value === "") return `<span class="muted">-</span>`;
    if (typeof value === "boolean") return booleanBadge(value, "Yes", "No");
    if (key && looksLikeTimeKey(key)) {
      return `${escapeHtml(formatTime(value))}<span class="subtle">${escapeHtml(String(value))}</span>`;
    }
    if (key && looksLikeDurationKey(key)) {
      return escapeHtml(formatDuration(value, key));
    }
    if (key && looksLikeRateKey(key)) {
      return `${escapeHtml(formatPercent(value))}<span class="subtle">${escapeHtml(String(value))}</span>`;
    }
    if (Array.isArray(value)) return renderArrayValue(value, key);
    if (typeof value === "object") return renderObjectValue(value);
    return escapeHtml(String(value));
  }

  function renderNamedField(label, value, key) {
    return `
      <div class="field-row">
        <dt>${escapeHtml(label)}</dt>
        <dd>${valueHtml(value, key || label)}</dd>
      </div>`;
  }

  function renderField(key, value) {
    return renderNamedField(labelForKey(key), value);
  }

  function renderObjectValue(value) {
    const keys = objectFieldKeys(value);
    if (!keys.length) return `<span class="muted">No fields</span>`;
    return `
      <dl class="field-list field-list--nested">
        ${keys.map(key => renderField(key, value[key])).join("")}
      </dl>`;
  }

  function renderArrayValue(value, key) {
    if (!value.length) return `<span class="muted">No items</span>`;
    const objectsOnly = value.every(item => item && typeof item === "object" && !Array.isArray(item));
    if (objectsOnly) {
      return `
        <div class="nested-record-list">
          ${value.map((item, index) => `
            <div class="nested-record">
              <p class="nested-record__title">${escapeHtml(arrayItemTitle(item, key, index))}</p>
              ${renderObjectValue(item)}
            </div>`).join("")}
        </div>`;
    }
    return `
      <ul class="value-list">
        ${value.map(item => `<li>${valueHtml(item, key)}</li>`).join("")}
      </ul>`;
  }

  function objectFieldKeys(value) {
    if (!value || typeof value !== "object") return [];
    const keys = Object.keys(value);
    const preferred = PREFERRED_COLUMNS.filter(key => keys.includes(key));
    return preferred.concat(keys.filter(key => !preferred.includes(key)));
  }

  function recordTitle(doc, collectionName, index) {
    if (!doc || typeof doc !== "object") return `Document ${index + 1}`;
    if (collectionName === "hn_dashboard_summary" || doc._id === "summary") {
      return "Current dashboard summary";
    }
    if (doc.run_id) return `Run ${doc.run_id}`;
    if (doc.action && doc.status) return `${humanizeToken(doc.action)} / ${labelForStatus(doc.status)}`;
    if (doc.phase) return humanizeToken(doc.phase);
    if (doc.status) return labelForStatus(doc.status);
    if (doc._id) return String(doc._id);
    return `Document ${index + 1}`;
  }

  function recordMeta(doc) {
    if (!doc || typeof doc !== "object") return "";
    const parts = [];
    if (doc.syncVersion !== undefined) parts.push(`sync v${valueOrDash(doc.syncVersion)}`);
    if (doc.sync_version !== undefined) parts.push(`sync v${valueOrDash(doc.sync_version)}`);
    if (doc.started_at) parts.push(`started ${formatTime(doc.started_at)}`);
    if (doc.finished_at) parts.push(`finished ${formatTime(doc.finished_at)}`);
    if (doc.publishedAt) parts.push(`published ${formatTime(doc.publishedAt)}`);
    if (doc.ts && !doc.started_at) parts.push(`time ${formatTime(doc.ts)}`);
    if (doc._id) parts.push(`id ${doc._id}`);
    return parts.map(escapeHtml).join(" / ");
  }

  function recordBadges(doc) {
    if (!doc || typeof doc !== "object") return "";
    const badges = [];
    if (doc.status !== undefined) badges.push(statusBadge(doc.status));
    if (doc.ok !== undefined) badges.push(booleanBadge(doc.ok, "OK", "Not OK"));
    if (doc.stale !== undefined) badges.push(booleanBadge(!isTruthyFlag(doc.stale), "Fresh", "Stale"));
    if (doc.has_error !== undefined) badges.push(booleanBadge(!isTruthyFlag(doc.has_error), "No error", "Has error"));
    if (doc.signatureOk !== undefined) badges.push(booleanBadge(doc.signatureOk, "Signature OK", "Signature failed"));
    return badges.join("");
  }

  function arrayItemTitle(item, key, index) {
    const prefix = `${labelForKey(key || "item")} ${index + 1}`;
    if (!item || typeof item !== "object") return prefix;
    if (item.run_id) return `${prefix}: run ${item.run_id}`;
    if (item._id) return `${prefix}: ${item._id}`;
    if (item.status) return `${prefix}: ${labelForStatus(item.status)}`;
    if (item.name) return `${prefix}: ${item.name}`;
    return prefix;
  }

  function booleanBadge(value, trueLabel, falseLabel) {
    const ok = isTruthyFlag(value);
    return `<span class="boolean-pill ${ok ? "boolean-pill--ok" : "boolean-pill--bad"}">${escapeHtml(ok ? trueLabel : falseLabel)}</span>`;
  }

  function isTruthyFlag(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return /^(1|true|yes|ok|success)$/i.test(value.trim());
    return Boolean(value);
  }

  function statusBadge(status) {
    const text = String(status || "unknown");
    return `<span class="status ${statusClass(text)}">${escapeHtml(labelForStatus(text))}</span>`;
  }

  function statusClass(status) {
    const s = status.toLowerCase();
    if (["ok", "success", "healthy", "true"].includes(s)) return "status--ok";
    if (["failed", "error", "stale", "false"].includes(s)) return "status--bad";
    if (["warning", "deferred", "due"].includes(s)) return "status--warn";
    if (["running", "in_progress"].includes(s)) return "status--info";
    return "status--idle";
  }

  function labelForStatus(status) {
    const text = String(status || "unknown");
    if (text === "ok") return "OK";
    return humanizeToken(text);
  }

  function labelForCollection(name) {
    return COLLECTION_LABELS[name] || labelForKey(name || "collection");
  }

  function labelForKey(key) {
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    return humanizeToken(String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " "));
  }

  function humanizeToken(value) {
    return String(value || "")
      .replace(/[-_.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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

  function formatDuration(value, key) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    if (/ms/i.test(String(key))) return formatMilliseconds(n);
    return formatSeconds(n);
  }

  function formatIntervalSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    if (n === 0) return "Always";
    if (n % 86400 === 0) return `${n / 86400} d`;
    if (n % 3600 === 0) return `${n / 3600} h`;
    if (n % 60 === 0) return `${n / 60} min`;
    return formatSeconds(n);
  }

  function insightsHealthStatus(insights) {
    if (!insights || typeof insights !== "object") return "unknown";
    if (insights.enabled === false) return "disabled";
    const latestRun = insights.latestRun || {};
    if (latestRun.status === "failed") return "failed";
    const latest = insights.latest || {};
    if (latest.due === true) return "due";
    if (latest.generated_at) return "ok";
    return latestRun.status || "unknown";
  }

  function formatMilliseconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    if (Math.abs(n) < 1000) return `${Math.round(n)} ms`;
    const seconds = n / 1000;
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  }

  function looksLikeTimeKey(key) {
    return /(^ts$|^asOf$|_at$|At$|Time$|publishedAt|serverTime)/.test(String(key));
  }

  function looksLikeDurationKey(key) {
    return /seconds|duration|elapsed|durationMs/i.test(String(key));
  }

  function looksLikeRateKey(key) {
    return /rate|ratio|percent|percentage/i.test(String(key));
  }

  function showAlert(message) {
    els.alert.textContent = message;
    els.alert.hidden = false;
    logDebug("alert shown", { message });
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

  function safeDomId(value) {
    return String(value || "row").replace(/[^a-z0-9_-]+/gi, "-");
  }

  function formatJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }

  function toggleRecordDetail(button) {
    const row = button.closest(".js-record-row");
    const detailId = button.getAttribute("aria-controls") || (row && row.dataset.detailId);
    const detail = detailId ? document.getElementById(detailId) : null;
    if (!row || !detail) return;
    const expanded = button.getAttribute("aria-expanded") === "true";
    const next = !expanded;
    button.setAttribute("aria-expanded", String(next));
    row.setAttribute("aria-expanded", String(next));
    detail.hidden = !next;
  }

  function redactRequestBody(body) {
    return Object.assign({}, body);
  }

  function logDebug(message, data, level) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}` +
      (data === undefined ? "" : ` ${formatDebugData(data)}`);
    if (els.debugLog) {
      els.debugLog.textContent += `${line}\n`;
      els.debugLog.scrollTop = els.debugLog.scrollHeight;
    }
    const method = level === "error" ? "error" : "log";
    try {
      console[method]("[scboard-ops]", line);
    } catch (_) {}
  }

  function formatDebugData(value) {
    if (!value || typeof value !== "object") return String(value);
    return Object.keys(value)
      .map(key => `${labelForKey(key)}=${formatDebugValue(value[key])}`)
      .join("; ");
  }

  function formatDebugValue(value) {
    if (value === null || value === undefined || value === "") return "-";
    if (Array.isArray(value)) return `${value.length} items`;
    if (typeof value === "object") {
      return Object.keys(value)
        .map(key => `${labelForKey(key)}:${formatDebugValue(value[key])}`)
        .join(", ");
    }
    return String(value);
  }

  function copyDebugLog() {
    const text = els.debugLog ? els.debugLog.textContent : "";
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => logDebug("debug log copied"))
        .catch(err => logDebug("copy failed", { message: err && err.message }, "error"));
      return;
    }
    logDebug("clipboard API unavailable; select and copy the log manually");
  }

  async function loadCollection(name) {
    if (!name || state.loadingCollections.has(name)) return;
    const snapshot = state.snapshot || {};
    const startedAt = Date.now();
    state.loadingCollections.add(name);
    renderDashboard(snapshot);
    logDebug("collection load start", {
      collection: name,
      syncVersion: snapshot.syncVersion,
      limit: state.settings.limit
    });
    try {
      const payload = await fetchDashboardWithRetry({
        action: "readCollection",
        collection: name,
        syncVersion: snapshot.syncVersion,
        limit: state.settings.limit,
        pushLogLimit: state.settings.limit,
        ingestLimit: state.settings.limit,
        cloudSyncLimit: state.settings.limit
      });
      const loaded = collectionFromPayload(payload, name) || payload.collection;
      if (!loaded || !loaded.name) throw new Error("Dashboard API returned no collection payload");
      state.snapshot = mergeCollection(state.snapshot || snapshot, loaded, payload);
      logDebug("collection load complete", {
        collection: loaded.name,
        elapsedMs: Date.now() - startedAt,
        docs: Array.isArray(loaded.docs) ? loaded.docs.length : 0
      });
    } catch (err) {
      showAlert(err.message || String(err));
      logDebug("collection load failed", {
        collection: name,
        elapsedMs: Date.now() - startedAt,
        message: err && err.message ? err.message : String(err)
      }, "error");
    } finally {
      state.loadingCollections.delete(name);
      renderDashboard(state.snapshot || snapshot);
    }
  }

  function mergeCollection(snapshot, collection, payload) {
    const next = Object.assign({}, snapshot);
    if (payload && payload.summary) next.summary = payload.summary;
    if (payload && payload.syncVersion !== undefined && payload.syncVersion !== null) {
      next.syncVersion = payload.syncVersion;
    }
    const collections = Array.isArray(next.collections) ? next.collections.slice() : [];
    const index = collections.findIndex(item => item && item.name === collection.name);
    if (index >= 0) collections[index] = collection;
    else collections.push(collection);
    next.collections = collections;
    next.asOf = payload && payload.asOf ? payload.asOf : Math.floor(Date.now() / 1000);
    return normalizePayload(next);
  }

  function collectionFromPayload(payload, name) {
    const collections = Array.isArray(payload && payload.collections) ? payload.collections : [];
    return collections.find(item => item && item.name === name) || null;
  }

  document.addEventListener("click", event => {
    const loadButton = event.target.closest(".js-load-collection");
    if (loadButton) {
      event.preventDefault();
      event.stopPropagation();
      loadCollection(loadButton.dataset.collection);
      return;
    }
    const button = event.target.closest(".js-row-toggle");
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      toggleRecordDetail(button);
      return;
    }
    const row = event.target.closest(".js-record-row");
    if (!row) return;
    const toggle = row.querySelector(".js-row-toggle");
    if (toggle) toggleRecordDetail(toggle);
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".js-record-row");
    if (!row) return;
    event.preventDefault();
    const toggle = row.querySelector(".js-row-toggle");
    if (toggle) toggleRecordDetail(toggle);
  });

  init();
}());
