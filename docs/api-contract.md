# Dashboard API Contract

The Web panel expects a protected HTTP endpoint. It should read CloudBase
ops collections on the server side and return one snapshot.

The endpoint must not read business collections such as `stories`, `topics`,
`digests`, or `meta`. Counts with those names may appear inside ops documents
because `cloud_sync_runs` records how many business documents were pushed, but
the panel does not fetch the business document contents.

CloudBase HTTP access is the intended deployment shape: configure a cloud
function as a normal HTTP endpoint, then the static Web panel calls it with
`fetch`.

## Request

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

`x-ops-token: <ops-token>` is also accepted by the reference backend.

## Response

```json
{
  "ok": true,
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
      "count": 1,
      "query": "latest documents",
      "limit": 100,
      "sort": "ts desc",
      "docs": []
    },
    {
      "name": "hn_dashboard_summary",
      "count": 1,
      "query": {"_id": "summary"},
      "docs": []
    },
    {
      "name": "hn_dashboard_ingest_runs",
      "count": 1,
      "query": "latest documents",
      "limit": 100,
      "sort": "started_at desc",
      "docs": []
    },
    {
      "name": "hn_dashboard_cloud_sync_runs",
      "count": 1,
      "query": "latest documents",
      "limit": 100,
      "sort": "started_at desc",
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

1. Read latest `push_log` documents, sorted by `ts` descending.
2. Read `hn_dashboard_summary` document `summary`.
3. Read latest `hn_dashboard_ingest_runs` documents, sorted by `started_at` descending.
4. Read latest `hn_dashboard_cloud_sync_runs` documents, sorted by `started_at` descending.
5. Also return `ingestRuns` and `cloudSyncRuns` filtered to `summary.syncVersion`
   for backward compatibility.
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
