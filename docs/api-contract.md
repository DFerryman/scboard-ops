# Dashboard API Contract

The Web panel expects a protected HTTP endpoint. It should read CloudBase
dashboard collections on the server side and return one snapshot.

CloudBase HTTP access is the intended deployment shape: configure a cloud
function as a normal HTTP endpoint, then the static Web panel calls it with
`fetch`.

## Request

```http
POST /api/dashboard
content-type: application/json
authorization: Bearer <ops-token>

{
  "limit": 20,
  "ingestLimit": 20,
  "cloudSyncLimit": 20
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

The backend should keep this query flow:

1. Read `hn_dashboard_summary` document `summary`.
2. Use `summary.syncVersion`.
3. Query `hn_dashboard_ingest_runs` with `{ syncVersion }`.
4. Query `hn_dashboard_cloud_sync_runs` with `{ syncVersion }`.
5. Sort both run lists by `started_at` descending.
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
