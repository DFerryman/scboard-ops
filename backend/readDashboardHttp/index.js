// Web-facing dashboard read endpoint for CloudBase HTTP access.
//
// This mirrors the Mini Program readDashboard cloud function's read path while
// using token auth for normal Web HTTP calls.

const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_HTTP_BODY_BYTES = positiveIntEnv('OPS_DASHBOARD_MAX_BODY_BYTES', 64 * 1024)
const FUNCTION_VERSION = 'readDashboardHttp-2026-05-18-1'
const COLLECTIONS = [
  'push_log',
  'hn_dashboard_summary',
  'hn_dashboard_ingest_runs',
  'hn_dashboard_cloud_sync_runs'
]

function positiveIntEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function logInfo(message, data) {
  try {
    console.log('[readDashboardHttp]', message, data || {})
  } catch (_) {}
}

function logError(message, err, data) {
  try {
    console.error('[readDashboardHttp]', message, {
      ...(data || {}),
      error: String(err && (err.message || err)).slice(0, 500)
    })
  } catch (_) {}
}

function isHttpEvent(event) {
  return event && (
    typeof event.httpMethod === 'string' ||
    typeof event.body === 'string' ||
    event.headers
  )
}

function getHeader(headers, name) {
  if (!headers) return ''
  const target = String(name || '').toLowerCase()
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === target) {
      const value = headers[key]
      if (Array.isArray(value)) return value.length ? String(value[0]) : ''
      return value == null ? '' : String(value)
    }
  }
  return ''
}

function configuredCorsOrigin() {
  const origin = String(process.env.OPS_DASHBOARD_ALLOWED_ORIGIN || '').trim()
  if (origin) return origin
  return process.env.OPS_DASHBOARD_ALLOW_ANY_ORIGIN === '1' ? '*' : ''
}

function corsHeaders() {
  const origin = configuredCorsOrigin()
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-ops-token',
    'vary': 'origin'
  }
  if (origin) headers['access-control-allow-origin'] = origin
  return headers
}

function http(statusCode, payload) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(payload || {})
  }
}

function preflight() {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: ''
  }
}

function rawHttpBody(event) {
  if (!event || !event.body) return ''
  if (typeof event.body === 'object') return JSON.stringify(event.body)
  return event.isBase64Encoded
    ? Buffer.from(String(event.body), 'base64').toString('utf8')
    : String(event.body)
}

function parseHttpBody(event) {
  if (!event || !event.body) return {}
  if (typeof event.body === 'object') return event.body
  const rawBody = rawHttpBody(event)

  const direct = parseBodyText(rawBody)
  if (direct) return direct

  const rawText = String(rawBody || '').trim()
  if (!rawText.includes('=')) {
    const err = new Error('invalid JSON body')
    err.statusCode = 400
    throw err
  }

  try {
    const params = new URLSearchParams(rawBody)
    const payload = params.get('payload') || params.get('body') || params.get('data')
    if (payload) {
      const parsed = parseBodyText(payload)
      if (parsed) return parsed
    }
    const obj = {}
    for (const [key, value] of params.entries()) {
      obj[key] = value
    }
    if (Object.keys(obj).length > 0) return obj
  } catch (_) {
    // fall through to structured 400 below
  }

  const err = new Error('invalid JSON body')
  err.statusCode = 400
  throw err
}

function queryValue(event, key) {
  if (!event) return ''
  const params = event.queryStringParameters || event.query || {}
  if (params && params[key] != null) return String(params[key])
  const raw = event.queryString || event.rawQueryString || ''
  if (!raw) return ''
  try {
    return new URLSearchParams(String(raw).replace(/^\?/, '')).get(key) || ''
  } catch (_) {
    return ''
  }
}

function parseBodyText(text) {
  const raw = String(text || '').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (_) {
    try {
      return JSON.parse(decodeURIComponent(raw))
    } catch (_) {
      return null
    }
  }
}

function bearerToken(value) {
  const text = String(value || '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(text)
  return match ? match[1].trim() : ''
}

function timingSafeEqualText(actual, expected) {
  const actualBuf = Buffer.from(String(actual || ''), 'utf8')
  const expectedBuf = Buffer.from(String(expected || ''), 'utf8')
  if (actualBuf.length !== expectedBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf)
}

function authorizeHttp(event) {
  const expected = process.env.OPS_DASHBOARD_TOKEN || ''
  if (!expected) {
    return {
      ok: false,
      statusCode: 500,
      code: 'SERVER_NOT_CONFIGURED',
      message: 'OPS_DASHBOARD_TOKEN is not configured'
    }
  }

  const headers = event && event.headers ? event.headers : {}
  const actual = bearerToken(getHeader(headers, 'authorization')) ||
    getHeader(headers, 'x-ops-token')

  if (!actual || !timingSafeEqualText(actual, expected)) {
    return {
      ok: false,
      statusCode: 401,
      code: 'FORBIDDEN',
      message: 'dashboard access denied'
    }
  }

  return { ok: true }
}

function requireHttpCorsOrigin() {
  if (configuredCorsOrigin()) return null
  return {
    ok: false,
    statusCode: 500,
    code: 'SERVER_NOT_CONFIGURED',
    message: 'OPS_DASHBOARD_ALLOWED_ORIGIN is not configured'
  }
}

function publicError(code, message) {
  return { error: { code: code || 'INTERNAL', message: message || 'internal error' } }
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

function byTsDesc(a, b) {
  const av = Number(a && a.ts != null ? a.ts : 0)
  const bv = Number(b && b.ts != null ? b.ts : 0)
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
  const cappedLimit = clampLimit(limit, DEFAULT_LIMIT)

  try {
    const res = await db.collection(collection)
      .where({ syncVersion })
      .orderBy('started_at', 'desc')
      .limit(cappedLimit)
      .get()

    return ((res && res.data) || [])
      .map(stripSystemFields)
      .sort(byStartedAtDesc)
      .slice(0, cappedLimit)
  } catch (e) {
    if (isNotFoundError(e)) return []
    throw e
  }
}

async function getPushLog(limit) {
  const cappedLimit = clampLimit(limit, DEFAULT_LIMIT)
  try {
    const res = await db.collection('push_log')
      .orderBy('ts', 'desc')
      .limit(cappedLimit)
      .get()

    return ((res && res.data) || [])
      .map(stripSystemFields)
      .sort(byTsDesc)
      .slice(0, cappedLimit)
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
    loaded: true,
    ...(meta || {})
  }
}

function collectionPlaceholder(name, meta) {
  return {
    name,
    count: null,
    docs: [],
    loaded: false,
    ...(meta || {})
  }
}

function normalizeCollectionName(value) {
  const name = String(value || '').trim()
  return COLLECTIONS.includes(name) ? name : ''
}

function payloadSyncVersion(payload) {
  if (!payload || payload.syncVersion == null || payload.syncVersion === '') return null
  const value = Number(payload.syncVersion)
  return Number.isInteger(value) ? value : null
}

async function readCollection(payload) {
  const defaultLimit = clampLimit(payload && payload.limit, DEFAULT_LIMIT)
  const pushLogLimit = clampLimit(payload && payload.pushLogLimit, defaultLimit)
  const ingestLimit = clampLimit(payload && payload.ingestLimit, defaultLimit)
  const cloudSyncLimit = clampLimit(payload && payload.cloudSyncLimit, defaultLimit)
  const collection = normalizeCollectionName(payload && payload.collection)
  const startedAt = Date.now()

  if (!collection) {
    const err = new Error('unknown dashboard collection')
    err.statusCode = 400
    err.code = 'BAD_REQUEST'
    throw err
  }

  logInfo('collection start', { collection, defaultLimit, pushLogLimit, ingestLimit, cloudSyncLimit })

  if (collection === 'push_log') {
    const docs = await getPushLog(pushLogLimit)
    const result = collectionSnapshot('push_log', docs, {
      query: 'latest documents',
      limit: pushLogLimit,
      sort: 'ts desc'
    })
    logInfo('collection loaded', { elapsedMs: Date.now() - startedAt, collection, docs: docs.length })
    return {
      ok: true,
      action: 'readCollection',
      collection: result,
      collections: [result],
      asOf: Math.floor(Date.now() / 1000)
    }
  }

  if (collection === 'hn_dashboard_summary') {
    const summary = await getSummary()
    const result = collectionSnapshot('hn_dashboard_summary', summary ? [summary] : [], {
      query: { _id: 'summary' }
    })
    logInfo('collection loaded', { elapsedMs: Date.now() - startedAt, collection, docs: summary ? 1 : 0 })
    return {
      ok: true,
      action: 'readCollection',
      syncVersion: summary && Number.isInteger(summary.syncVersion) ? summary.syncVersion : null,
      summary,
      collection: result,
      collections: [result],
      asOf: Math.floor(Date.now() / 1000)
    }
  }

  let syncVersion = payloadSyncVersion(payload)
  let summary = null
  if (!Number.isInteger(syncVersion)) {
    summary = await getSummary()
    syncVersion = summary && Number.isInteger(summary.syncVersion) ? summary.syncVersion : null
  }

  const limit = collection === 'hn_dashboard_ingest_runs' ? ingestLimit : cloudSyncLimit
  const docs = await getRuns(collection, syncVersion, limit)
  const result = collectionSnapshot(collection, docs, {
    query: { syncVersion },
    limit,
    sort: 'started_at desc'
  })
  logInfo('collection loaded', { elapsedMs: Date.now() - startedAt, collection, syncVersion, docs: docs.length })
  return {
    ok: true,
    action: 'readCollection',
    syncVersion,
    summary,
    collection: result,
    collections: [result],
    asOf: Math.floor(Date.now() / 1000)
  }
}

async function readDashboardSnapshot(payload) {
  const defaultLimit = clampLimit(payload && payload.limit, DEFAULT_LIMIT)
  const pushLogLimit = clampLimit(payload && payload.pushLogLimit, defaultLimit)
  const ingestLimit = clampLimit(payload && payload.ingestLimit, defaultLimit)
  const cloudSyncLimit = clampLimit(payload && payload.cloudSyncLimit, defaultLimit)
  const startedAt = Date.now()
  logInfo('overview start', { defaultLimit, pushLogLimit, ingestLimit, cloudSyncLimit })

  try {
    const summary = await getSummary()
    const syncVersion = summary && Number.isInteger(summary.syncVersion)
      ? summary.syncVersion
      : null
    logInfo('summary loaded', {
      elapsedMs: Date.now() - startedAt,
      hasSummary: Boolean(summary),
      syncVersion
    })

    const collections = [
      collectionPlaceholder(
        'push_log',
        { query: 'latest documents', limit: pushLogLimit, sort: 'ts desc' }
      ),
      collectionPlaceholder(
        'hn_dashboard_summary',
        { query: { _id: 'summary' } }
      ),
      collectionPlaceholder(
        'hn_dashboard_ingest_runs',
        { query: { syncVersion }, limit: ingestLimit, sort: 'started_at desc' }
      ),
      collectionPlaceholder(
        'hn_dashboard_cloud_sync_runs',
        { query: { syncVersion }, limit: cloudSyncLimit, sort: 'started_at desc' }
      )
    ]

    return {
      ok: true,
      mode: 'overview',
      syncVersion,
      summary,
      ingestRuns: [],
      cloudSyncRuns: [],
      collections,
      asOf: Math.floor(Date.now() / 1000)
    }
  } catch (e) {
    logError('snapshot failed', e, { elapsedMs: Date.now() - startedAt })
    const err = e && typeof e === 'object' ? e : new Error(String(e))
    err.statusCode = err.statusCode || 500
    throw err
  }
}

exports.main = async (event) => {
  const startedAt = Date.now()
  const httpMode = isHttpEvent(event)
  logInfo('request start', {
    httpMode,
    method: event && event.httpMethod ? event.httpMethod : '(callFunction)',
    hasBody: Boolean(event && event.body)
  })

  if (httpMode) {
    const cors = requireHttpCorsOrigin()
    if (cors) {
      logInfo('cors rejected', { elapsedMs: Date.now() - startedAt, code: cors.code })
      return http(cors.statusCode, publicError(cors.code, cors.message))
    }
  }

  if (httpMode && queryValue(event, 'versionProbe')) {
    return http(200, {
      ok: true,
      versionProbe: true,
      version: FUNCTION_VERSION,
      httpMode,
      asOf: Math.floor(Date.now() / 1000)
    })
  }

  if (httpMode && event && event.httpMethod === 'OPTIONS') {
    return preflight()
  }

  if (httpMode && event && event.httpMethod && event.httpMethod !== 'POST') {
    return http(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
  }

  let payload = httpMode ? {} : (event || {})
  if (httpMode) {
    const rawBody = rawHttpBody(event)
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_HTTP_BODY_BYTES) {
      return http(413, publicError('PAYLOAD_TOO_LARGE', 'request body too large'))
    }
    const auth = authorizeHttp(event)
    if (!auth.ok) {
      logInfo('auth rejected', {
        elapsedMs: Date.now() - startedAt,
        code: auth.code,
        statusCode: auth.statusCode || 403
      })
      return http(auth.statusCode || 403, publicError(auth.code, auth.message))
    }
    try {
      payload = parseHttpBody(event)
    } catch (e) {
      logError('parse body failed', e, { elapsedMs: Date.now() - startedAt })
      return http(e.statusCode || 400, publicError(e.code || 'BAD_REQUEST', 'invalid request body'))
    }
  }

  if (payload && payload.versionProbe) {
    const probe = {
      ok: true,
      versionProbe: true,
      version: FUNCTION_VERSION,
      httpMode,
      asOf: Math.floor(Date.now() / 1000)
    }
    return httpMode ? http(200, probe) : probe
  }

  logInfo('auth ok', { elapsedMs: Date.now() - startedAt, httpMode })

  try {
    if (payload && payload.debugPing) {
      logInfo('debug ping complete', { elapsedMs: Date.now() - startedAt, httpMode })
      return http(200, {
        ok: true,
        pong: true,
        debugPing: true,
        version: FUNCTION_VERSION,
        httpMode,
        asOf: Math.floor(Date.now() / 1000)
      })
    }

    const result = payload && payload.action === 'readCollection'
      ? await readCollection(payload)
      : await readDashboardSnapshot(payload)
    logInfo('request complete', {
      elapsedMs: Date.now() - startedAt,
      ok: Boolean(result && result.ok),
      collections: result && Array.isArray(result.collections) ? result.collections.length : 0
    })
    return http(200, result)
  } catch (e) {
    logError('request failed', e, { elapsedMs: Date.now() - startedAt })
    return http(e.statusCode || 500, {
      error: {
        code: e.code || 'INTERNAL',
        message: e.statusCode && e.statusCode < 500 ? String(e && (e.message || e)) : 'dashboard request failed'
      }
    })
  }
}
