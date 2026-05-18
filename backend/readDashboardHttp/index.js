// Web-facing dashboard read endpoint for CloudBase HTTP access.
//
// This is separate from the Mini Program readDashboard function. A normal Web
// browser request does not have a Mini Program OPENID, so this endpoint uses a
// server-side token and keeps all database reads inside the cloud function.

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function getHeader(headers, name) {
  if (!headers) return ''
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || ''
}

function corsHeaders() {
  const origin = process.env.OPS_DASHBOARD_ALLOWED_ORIGIN || '*'
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-ops-token',
    'vary': 'origin'
  }
}

function http(statusCode, payload) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(payload || {})
  }
}

function parseBody(event) {
  if (!event || !event.body) return {}
  if (typeof event.body === 'object') return event.body
  try {
    return JSON.parse(event.body)
  } catch (_) {
    const err = new Error('invalid JSON body')
    err.statusCode = 400
    throw err
  }
}

function bearerToken(value) {
  const text = String(value || '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(text)
  return match ? match[1].trim() : ''
}

function authorize(event, payload) {
  const expected = process.env.OPS_DASHBOARD_TOKEN || ''
  if (!expected) {
    return { ok: false, statusCode: 500, message: 'OPS_DASHBOARD_TOKEN is not configured' }
  }

  const headers = event && event.headers ? event.headers : {}
  const actual = bearerToken(getHeader(headers, 'authorization')) ||
    getHeader(headers, 'x-ops-token') ||
    (payload && (payload.token || payload.opsToken || payload.accessToken))
  if (!actual || actual !== expected) {
    return { ok: false, statusCode: 401, message: 'dashboard access denied' }
  }

  return { ok: true }
}

function clampLimit(value, fallback) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

function isNotFoundError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '')
  return /not exist|not found|does not exist|collection.*not/i.test(msg)
}

function stripSystemFields(doc) {
  if (!doc || typeof doc !== 'object') return doc
  const copy = Object.assign({}, doc)
  delete copy._openid
  return copy
}

function byStartedAtDesc(a, b) {
  const av = Number(a && a.started_at != null ? a.started_at : 0)
  const bv = Number(b && b.started_at != null ? b.started_at : 0)
  return bv - av
}

async function getSummary() {
  try {
    const res = await db.collection('hn_dashboard_summary').doc('summary').get()
    return stripSystemFields((res && res.data) || null)
  } catch (e) {
    if (isNotFoundError(e)) return null
    throw e
  }
}

async function getRuns(collection, syncVersion, limit) {
  if (!Number.isInteger(syncVersion)) return []

  try {
    const res = await db.collection(collection)
      .where({ syncVersion })
      .orderBy('started_at', 'desc')
      .limit(MAX_LIMIT)
      .get()

    return ((res && res.data) || [])
      .map(stripSystemFields)
      .sort(byStartedAtDesc)
      .slice(0, limit)
  } catch (e) {
    if (isNotFoundError(e)) return []
    throw e
  }
}

function collectionSnapshot(name, docs, meta) {
  const rows = Array.isArray(docs) ? docs : []
  return {
    name,
    count: rows.length,
    docs: rows,
    ...(meta || {})
  }
}

exports.main = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return http(204, {})
  }

  if (event && event.httpMethod && event.httpMethod !== 'POST') {
    return http(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
  }

  try {
    const body = parseBody(event)
    const auth = authorize(event, body)
    if (!auth.ok) {
      return http(auth.statusCode, { error: { code: 'FORBIDDEN', message: auth.message } })
    }

    if (body && body.debugPing) {
      return http(200, {
        ok: true,
        pong: true,
        debugPing: true,
        asOf: Math.floor(Date.now() / 1000)
      })
    }

    const defaultLimit = clampLimit(body.limit, DEFAULT_LIMIT)
    const ingestLimit = clampLimit(body.ingestLimit, defaultLimit)
    const cloudSyncLimit = clampLimit(body.cloudSyncLimit, defaultLimit)

    const summary = await getSummary()
    const syncVersion = summary && Number.isInteger(summary.syncVersion)
      ? summary.syncVersion
      : null

    const [ingestRuns, cloudSyncRuns] = await Promise.all([
      getRuns('hn_dashboard_ingest_runs', syncVersion, ingestLimit),
      getRuns('hn_dashboard_cloud_sync_runs', syncVersion, cloudSyncLimit)
    ])
    const collections = [
      collectionSnapshot(
        'hn_dashboard_summary',
        summary ? [summary] : [],
        { query: { _id: 'summary' } }
      ),
      collectionSnapshot(
        'hn_dashboard_ingest_runs',
        ingestRuns,
        { query: { syncVersion }, limit: ingestLimit, sort: 'started_at desc' }
      ),
      collectionSnapshot(
        'hn_dashboard_cloud_sync_runs',
        cloudSyncRuns,
        { query: { syncVersion }, limit: cloudSyncLimit, sort: 'started_at desc' }
      )
    ]

    return http(200, {
      ok: true,
      syncVersion,
      summary,
      ingestRuns,
      cloudSyncRuns,
      collections,
      asOf: Math.floor(Date.now() / 1000)
    })
  } catch (e) {
    return http(e.statusCode || 500, {
      error: {
        code: e.code || 'INTERNAL',
        message: String(e && (e.message || e))
      }
    })
  }
}
