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
panel. Auto refresh is off by default; use manual refresh or opt into a refresh
interval only while actively monitoring. The endpoint must implement the contract
in `docs/api-contract.md`.

## Cloudflare Workers Deployment

Deploy the static panel with Wrangler:

```sh
npx wrangler deploy
```

The committed `wrangler.jsonc` is the source of truth for Cloudflare Workers.
It uses Workers Static Assets with the repository root as the asset directory,
and `.assetsignore` allowlists only `index.html` and `assets/**`. This prevents
Wrangler's install-time `node_modules/`, backend source files, docs, and project
metadata from being uploaded as public static assets.

For the Cloudflare dashboard build settings, use `npx wrangler deploy` as the
deploy command. No build command or output directory setting is required for the
current no-build static app.

## Recommended Backend

Use the reference function in `backend/readDashboardHttp/` as the Web-facing
dashboard API. It follows the existing Mini Program cloud-function style:

- reads `hn_dashboard_summary/summary` for the initial lightweight overview;
- lazily reads recent `push_log` documents only when that collection is opened;
- lazily reads recent `hn_dashboard_ingest_runs` documents only when opened;
- lazily reads recent `hn_dashboard_cloud_sync_runs` documents only when opened;
- enforces `OPS_DASHBOARD_TOKEN`;
- returns collection placeholders first, then loaded collection rows via
  `action: "readCollection"`.

The panel now prioritizes the cloud sync fields added for retained multi-version
publishing, especially `sync_version`, `cleanup_status`, and
`insights_content_changed`, so cleanup failures are visible without expanding raw
JSON rows. It still does not read the business `meta` collection directly.

This is intentionally separate from the Mini Program `readDashboard` OPENID
allowlist, because a normal Web browser request does not have a Mini Program
OPENID context.
