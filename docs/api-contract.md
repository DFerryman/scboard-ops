# Dashboard API Contract

The Web panel expects a protected HTTP endpoint. The default request should read
only the dashboard summary and return a lightweight overview. Collection rows
are loaded lazily with `action: "readCollection"` so the panel does not spend
CloudBase reads or response bandwidth on tables the operator never opens.

The endpoint must not read business collections such as `stories`, `topics`,
`digests`, or `meta`. Counts with those names may appear inside ops documents
because `cloud_sync_runs` records how many business documents were pushed, but
the panel does not fetch the business document contents.

CloudBase HTTP access is the intended deployment shape: configure a cloud
function as a normal HTTP endpoint, then the static Web panel calls it with
`fetch`.

## Request

Fast HTTP reachability probe. This does not require token auth and must not read
database collections:

```http
GET /api/dashboard?versionProbe=1
```

Authenticated token probe. This verifies HTTP body parsing and token auth but
must not read database collections:

```json
{
  "debugPing": true,
  "token": "<ops-token>"
}
```

```http
POST /api/dashboard
content-type: application/json
authorization: Bearer <ops-token>

{
  "limit": 100,
  "ingestLimit": 100,
  "cloudSyncLimit": 100,
  "pushLogLimit": 100
}
```

Lazy-load one collection after the operator opens it:

```json
{
  "action": "readCollection",
  "collection": "push_log",
  "limit": 100,
  "token": "<ops-token>"
}
```

Allowed collection names are `push_log`, `hn_dashboard_summary`,
`hn_dashboard_ingest_runs`, and `hn_dashboard_cloud_sync_runs`.

`x-ops-token: <ops-token>` is also accepted by the reference backend.

## Response

```json
{
  "ok": true,
  "mode": "overview",
  "syncVersion": 42,
  "summary": {
    "_id": "summary",
    "syncVersion": 42,
    "publishedAt": 1779070000,
    "metrics": {},
    "latestRun": {},
    "latestCloudSync": {},
    "ai": {}
  },
  "ingestRuns": [],
  "cloudSyncRuns": [],
  "collections": [
    {
      "name": "push_log",
      "count": null,
      "loaded": false,
      "query": "latest documents",
      "limit": 100,
      "sort": "ts desc",
      "docs": []
    },
    {
      "name": "hn_dashboard_summary",
      "count": null,
      "loaded": false,
      "query": {"_id": "summary"},
      "docs": []
    },
    {
      "name": "hn_dashboard_ingest_runs",
      "count": null,
      "loaded": false,
      "query": {"syncVersion": 42},
      "limit": 100,
      "sort": "started_at desc",
      "docs": []
    },
    {
      "name": "hn_dashboard_cloud_sync_runs",
      "count": null,
      "loaded": false,
      "query": {"syncVersion": 42},
      "limit": 100,
      "sort": "started_at desc",
      "docs": []
    }
  ],
  "asOf": 1779070100
}
```

`readCollection` responses return one loaded collection:

```json
{
  "ok": true,
  "action": "readCollection",
  "collection": {
    "name": "push_log",
    "count": 1,
    "loaded": true,
    "query": "latest documents",
    "limit": 100,
    "sort": "ts desc",
    "docs": []
  },
  "collections": [
    {
      "name": "push_log",
      "count": 1,
      "loaded": true,
      "query": "latest documents",
      "limit": 100,
      "sort": "ts desc",
      "docs": []
    }
  ],
  "asOf": 1779070100
}
```

Error responses use the same envelope shape as the Mini Program cloud
functions:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "dashboard access denied"
  }
}
```

## Data Reads

The backend should keep this ops-only query flow:

1. Default overview request reads only `hn_dashboard_summary/summary`.
2. `readCollection` for `push_log` reads latest `push_log` documents, sorted by
   `ts` descending.
3. `readCollection` for `hn_dashboard_summary` reads document `summary`.
4. `readCollection` for `hn_dashboard_ingest_runs` reads documents for the
   requested or current `syncVersion`, sorted by
   `started_at` descending.
5. `readCollection` for `hn_dashboard_cloud_sync_runs` reads documents for the
   requested or current `syncVersion`, sorted by `started_at` descending.
6. Strip system fields such as `_openid`.

This mirrors the Mini Program `readDashboard` function while replacing OPENID
authorization with Web-appropriate token authorization.

## Required Cloud Function Environment

- `OPS_DASHBOARD_TOKEN`: shared token required by the Web panel.
- `OPS_DASHBOARD_ALLOWED_ORIGIN`: optional CORS origin. Use the deployed panel
  origin in production.

Do not put CloudBase `secretId`, `secretKey`, database credentials, or a
long-lived admin token in browser JavaScript.

## Deployment Notes

1. Deploy `backend/readDashboardHttp` as a CloudBase cloud function.
2. Configure HTTP access for that function, for example `/api/dashboard`.
3. Set `OPS_DASHBOARD_TOKEN`.
4. Set `OPS_DASHBOARD_ALLOWED_ORIGIN` to the Web panel origin.
5. Deploy this repo as static files.
6. Configure the endpoint and token in the panel Settings.

References:

- CloudBase HTTP access service: https://docs.cloudbase.net/service/access-cloud-function
- CloudBase cloud function calls: https://docs.cloudbase.net/cloud-function/function-calls/
- CloudBase database SDK in cloud functions: https://docs.cloudbase.net/cloud-function/resource-integration/cloudbase
