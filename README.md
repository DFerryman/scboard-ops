# scboard-ops

Standalone Web ops panel for the SCBoard/HackerMini CloudBase dashboard data.

The public Mini Program should not expose an ops page. This repo keeps the Web
panel separate and reads dashboard data through a protected server-side API.
The browser never talks to CloudBase database collections directly and never
holds CloudBase credentials.

## Current Architecture

```text
Ops browser
  -> static Web panel
  -> protected dashboard HTTP API
  -> CloudBase cloud function with root database access
  -> push_log
  -> hn_dashboard_summary
  -> hn_dashboard_ingest_runs
  -> hn_dashboard_cloud_sync_runs
```

Only ops collections are read. Business collections such as `stories`,
`topics`, `digests`, and `meta` are not read by this panel. The ops collections
should stay on creator-only permissions. The API is the only read boundary for
the Web panel.

## Files

- `index.html`: static app shell.
- `assets/app.js`: dashboard API client, state handling, rendering.
- `assets/styles.css`: operational workspace styling.
- `backend/readDashboardHttp/`: reference CloudBase HTTP cloud function.
- `docs/api-contract.md`: API contract and deployment notes.

## Local Preview

Open `index.html` directly in a browser. With no API endpoint configured, the
panel shows an empty state. It does not render mock data.

For live data, enter the protected dashboard API URL and token in the Settings
panel. The endpoint must implement the contract in `docs/api-contract.md`.

## Recommended Backend

Use the reference function in `backend/readDashboardHttp/` as the Web-facing
dashboard API. It follows the existing Mini Program cloud-function style:

- reads recent `push_log` documents;
- reads `hn_dashboard_summary/summary`;
- reads recent `hn_dashboard_ingest_runs` documents;
- reads recent `hn_dashboard_cloud_sync_runs` documents;
- enforces `OPS_DASHBOARD_TOKEN`;
- returns one JSON snapshot with a `collections[]` array for the Web UI.

This is intentionally separate from the Mini Program `readDashboard` OPENID
allowlist, because a normal Web browser request does not have a Mini Program
OPENID context.
