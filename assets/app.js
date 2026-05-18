(function () {
  "use strict";

  const STORAGE_KEY = "scboard.ops.settings";
  const SESSION_TOKEN_KEY = "scboard.ops.token";
  const DEFAULT_LIMIT = 20;
  const DEFAULT_REFRESH_SECONDS = 60;

  const config = Object.assign({
    dashboardEndpoint: "",
    refreshSeconds: DEFAULT_REFRESH_SECONDS
  }, window.SCBOARD_OPS_CONFIG || {});

  const state = {
    loading: false,
    timer: null,
    settings: loadSettings(),
    data: null
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
    summaryFields: document.getElementById("summaryFields"),
    metricsFields: document.getElementById("metricsFields"),
    latestRunFields: document.getElementById("latestRunFields"),
    latestCloudSyncFields: document.getElementById("latestCloudSyncFields"),
    aiFields: document.getElementById("aiFields"),
    ingestRows: document.getElementById("ingestRows"),
    cloudRows: document.getElementById("cloudRows"),
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
    renderShell();
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
    hideAlert();

    try {
      if (!state.settings.endpoint) {
        state.data = null;
        renderShell();
        showAlert("Configure the dashboard API endpoint to load live data.");
        return;
      }
      state.data = await fetchDashboard();
      renderDashboard(state.data);
    } catch (err) {
      showAlert(err.message || String(err));
    } finally {
      state.loading = false;
      els.refreshButton.disabled = false;
      els.refreshButton.textContent = "Refresh";
    }
  }

  async function fetchDashboard() {
    const headers = {
      "content-type": "application/json"
    };
    if (state.settings.token) {
      headers.authorization = `Bearer ${state.settings.token}`;
      headers["x-ops-token"] = state.settings.token;
    }

    const response = await fetch(state.settings.endpoint, {
      method: "POST",
      mode: "cors",
      headers,
      body: JSON.stringify({ limit: state.settings.limit })
    });

    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      const message = payload && (payload.message || payload.error && payload.error.message || payload.error);
      throw new Error(message || `HTTP ${response.status}`);
    }
    return normalizePayload(payload);
  }

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
    return {
      ok: true,
      syncVersion: payload.syncVersion,
      summary: payload.summary || null,
      ingestRuns: Array.isArray(payload.ingestRuns) ? payload.ingestRuns : [],
      cloudSyncRuns: Array.isArray(payload.cloudSyncRuns) ? payload.cloudSyncRuns : [],
      asOf: payload.asOf || Math.floor(Date.now() / 1000)
    };
  }

  function renderShell() {
    els.metricStrip.innerHTML = metricItems([
      ["Pipeline", "Waiting"],
      ["Cloud sync", "Waiting"],
      ["Catalog", "-"],
      ["Failure rate", "-"],
      ["AI", "-"],
      ["Stories", "-"]
    ]);
    renderRows(els.ingestRows, []);
    renderRows(els.cloudRows, []);
  }

  function renderDashboard(snapshot, sampleMode) {
    const summary = snapshot.summary || {};
    const metrics = summary.metrics || {};
    const latestRun = summary.latestRun || {};
    const latestCloudSync = summary.latestCloudSync || {};
    const ai = summary.ai || {};
    const pipelineStatus = latestRun.status || "unknown";
    const syncStatus = latestCloudSync.status || "unknown";

    els.headlineStatus.innerHTML = `${statusBadge(pipelineStatus)} ${escapeHtml(labelForStatus(pipelineStatus))}`;
    els.headlineMeta.textContent = [
      `sync v${valueOrDash(snapshot.syncVersion || summary.syncVersion)}`,
      `published ${formatTime(summary.publishedAt)}`,
      sampleMode ? "sample data" : "live data"
    ].join(" · ");

    els.metricStrip.innerHTML = metricItems([
      ["Pipeline", labelForStatus(pipelineStatus)],
      ["Cloud sync", labelForStatus(syncStatus)],
      ["Catalog", valueOrDash(metrics.catalog_version)],
      ["Failure rate", formatPercent(metrics.failure_rate)],
      ["AI", ai.status || "unknown"],
      ["Stories", valueOrDash(metrics.total_stories)]
    ]);

    renderIngestRows(snapshot.ingestRuns);
    renderCloudRows(snapshot.cloudSyncRuns);
    els.freshness.textContent = `As of ${formatTime(snapshot.asOf)}`;
  }

  function metricItems(items) {
    return items.map(([label, value]) => (
      `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`
    )).join("");
  }

  function renderRows(target, rows) {
    if (rows.length) return;
    target.innerHTML = `<tr><td class="empty-row" colspan="5">No rows</td></tr>`;
  }

  function renderIngestRows(rows) {
    if (!rows.length) {
      renderRows(els.ingestRows, rows);
      return;
    }
    els.ingestRows.innerHTML = rows.map(row => {
      const usage = row.ai_usage || {};
      return `<tr>
        <td>${statusBadge(row.status)}<span class="subtle">${escapeHtml(row.run_id || "")}</span></td>
        <td>${escapeHtml(formatTime(row.started_at))}<span class="subtle">${escapeHtml(formatDuration(row.overdue_seconds, "overdue"))}</span></td>
        <td>${escapeHtml(row.phase || "-")}<span class="subtle">raw ${valueOrDash(row.raw_status)}</span></td>
        <td>${escapeHtml(progressText(row))}</td>
        <td>${escapeHtml(formatAiUsage(usage))}</td>
      </tr>`;
    }).join("");
  }

  function renderCloudRows(rows) {
    if (!rows.length) {
      renderRows(els.cloudRows, rows);
      return;
    }
    els.cloudRows.innerHTML = rows.map(row => `<tr>
      <td>${statusBadge(row.status)}<span class="subtle">${escapeHtml(row.error || "")}</span></td>
      <td>${escapeHtml(formatTime(row.started_at))}<span class="subtle">${escapeHtml(row.run_id || "")}</span></td>
      <td>${escapeHtml(valueOrDash(row.sync_version || row.syncVersion))}</td>
      <td>${escapeHtml(payloadText(row))}</td>
      <td>${escapeHtml(formatSeconds(row.elapsed_seconds))}</td>
    </tr>`).join("");
  }

  function statusBadge(status) {
    const text = String(status || "unknown");
    return `<span class="status ${statusClass(text)}">${escapeHtml(text)}</span>`;
  }

  function statusClass(status) {
    const s = status.toLowerCase();
    if (["ok", "success", "healthy"].includes(s)) return "status--ok";
    if (["failed", "error", "stale"].includes(s)) return "status--bad";
    if (["warning", "deferred"].includes(s)) return "status--warn";
    if (["running", "in_progress"].includes(s)) return "status--info";
    return "status--idle";
  }

  function labelForStatus(status) {
    const text = String(status || "unknown");
    if (text === "ok") return "OK";
    return text.replace(/_/g, " ");
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

  function formatDuration(value, suffix) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    return `${formatSeconds(n)} ${suffix}`;
  }

  function progressText(row) {
    const parts = [
      `claimed ${valueOrDash(row.claimed)}`,
      `done ${valueOrDash(row.done)}`,
      `failed ${valueOrDash(row.failed)}`,
      `retried ${valueOrDash(row.retried)}`
    ];
    return parts.join(" · ");
  }

  function formatAiUsage(usage) {
    const tokens = valueOrDash(usage.total_tokens);
    const cost = usage.cost === null || usage.cost === undefined ? "-" : `$${Number(usage.cost).toFixed(4)}`;
    return `${tokens} tokens · ${cost}`;
  }

  function payloadText(row) {
    return `stories ${valueOrDash(row.stories)} · topics ${valueOrDash(row.topics)} · digests ${valueOrDash(row.digests)}`;
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

  function sampleDashboard() {
    const now = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      syncVersion: 42,
      asOf: now,
      summary: {
        syncVersion: 42,
        publishedAt: now - 180,
        metrics: {
          catalog_version: 42,
          failure_rate: 0.018,
          total_stories: 586
        },
        latestRun: {
          run_id: "run-sample-latest",
          started_at: now - 960,
          status: "ok",
          raw_status: "ok",
          phase: "finalize",
          claimed: 90,
          done: 88,
          failed: 2,
          retried: 3,
          ai_usage: { total_tokens: 183240, cost: 1.9234 }
        },
        latestCloudSync: {
          run_id: "run-sample-latest",
          started_at: now - 240,
          status: "ok",
          sync_version: 42,
          stories: 586,
          topics: 18,
          digests: 4,
          elapsed_seconds: 8.4
        },
        ai: {
          status: "ok"
        }
      },
      ingestRuns: [
        {
          run_id: "run-sample-latest",
          started_at: now - 960,
          status: "ok",
          raw_status: "ok",
          phase: "finalize",
          claimed: 90,
          done: 88,
          failed: 2,
          retried: 3,
          ai_usage: { total_tokens: 183240, cost: 1.9234 }
        },
        {
          run_id: "run-sample-prev",
          started_at: now - 7320,
          status: "warning",
          raw_status: "ok",
          phase: "enrich",
          claimed: 90,
          done: 84,
          failed: 6,
          retried: 9,
          ai_usage: { total_tokens: 170920, cost: 1.7721 }
        }
      ],
      cloudSyncRuns: [
        {
          run_id: "run-sample-latest",
          started_at: now - 240,
          status: "ok",
          sync_version: 42,
          stories: 586,
          topics: 18,
          digests: 4,
          elapsed_seconds: 8.4
        },
        {
          run_id: "run-sample-prev",
          started_at: now - 6600,
          status: "deferred",
          sync_version: 41,
          stories: 0,
          topics: 0,
          digests: 0,
          elapsed_seconds: 0.2
        }
      ]
    };
  }

  init();
}());
