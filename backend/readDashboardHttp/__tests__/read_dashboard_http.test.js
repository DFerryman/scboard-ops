const assert = require('assert')
const Module = require('module')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createMockDb(seed) {
  const failCollections = new Set()
  const readCounts = new Map()
  const queryLimits = new Map()

  function count(name, type) {
    const current = readCounts.get(name) || { doc: 0, query: 0 }
    current[type] += 1
    readCounts.set(name, current)
  }

  function collection(name) {
    const state = {
      name,
      docs: seed[name] || [],
      filter: null,
      sortField: null,
      sortDirection: 'asc',
      max: 100
    }

    return {
      doc(id) {
        return {
          async get() {
            if (failCollections.has(name)) throw new Error(`${name} failed`)
            count(name, 'doc')
            const doc = state.docs.find(item => item && item._id === id)
            if (!doc) throw new Error('document not exist')
            return { data: clone(doc) }
          }
        }
      },

      where(filter) {
        state.filter = filter || null
        return this
      },

      orderBy(field, direction) {
        state.sortField = field
        state.sortDirection = direction
        return this
      },

      limit(max) {
        state.max = max
        return this
      },

      async get() {
        if (failCollections.has(name)) throw new Error(`${name} failed`)
        count(name, 'query')
        queryLimits.set(name, state.max)
        let rows = state.docs.slice()
        if (state.filter) {
          rows = rows.filter(doc => Object.keys(state.filter).every(key => doc[key] === state.filter[key]))
        }
        if (state.sortField) {
          const sign = state.sortDirection === 'desc' ? -1 : 1
          rows.sort((a, b) => {
            const av = Number(a && a[state.sortField] != null ? a[state.sortField] : 0)
            const bv = Number(b && b[state.sortField] != null ? b[state.sortField] : 0)
            return av === bv ? 0 : (av > bv ? sign : -sign)
          })
        }
        return { data: clone(rows.slice(0, state.max)) }
      }
    }
  }

  return { collection, failCollections, readCounts, queryLimits }
}

async function run() {
  const mockDb = createMockDb({
    push_log: [
      { _id: 'p1', ts: 10, action: 'ping', ok: true, _openid: 'hidden' },
      { _id: 'p3', ts: 30, action: 'cleanupOld', ok: false },
      { _id: 'p2', ts: 20, action: 'writeDashboard', ok: true }
    ],
    hn_dashboard_summary: [
      {
        _id: 'summary',
        syncVersion: 42,
        publishedAt: 1779070000,
        insights: {
          enabled: true,
          update_interval_seconds: 14400,
          latest: { date: '2026-05-19', generated_at: 1779060000, due: false },
          latestRun: { status: 'ok' }
        },
        _openid: 'hidden'
      }
    ],
    hn_dashboard_ingest_runs: [
      { _id: '42:run-old', syncVersion: 42, started_at: 100 },
      { _id: '41:run-other', syncVersion: 41, started_at: 300 },
      { _id: '42:run-new', syncVersion: 42, started_at: 200, _openid: 'hidden' }
    ],
    hn_dashboard_cloud_sync_runs: [
      { _id: '42:push-old', syncVersion: 42, started_at: 100 },
      { _id: '42:push-new', syncVersion: 42, started_at: 250 },
      { _id: '41:push-other', syncVersion: 41, started_at: 500 }
    ]
  })

  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database() {
          return mockDb
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  process.env.OPS_DASHBOARD_TOKEN = 'secret'
  const dashboard = require('../index.js')

  const okResponse = await dashboard.main({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer secret' },
    body: JSON.stringify({ limit: 2, pushLogLimit: 2, ingestLimit: 2, cloudSyncLimit: 2 })
  })
  assert.equal(okResponse.statusCode, 200)

  const payload = JSON.parse(okResponse.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.mode, 'overview')
  assert.deepEqual(payload.collections.map(item => item.name), [
    'push_log',
    'hn_dashboard_summary',
    'hn_dashboard_ingest_runs',
    'hn_dashboard_cloud_sync_runs'
  ])
  assert.deepEqual(payload.collections.map(item => item.loaded), [false, false, false, false])
  assert.deepEqual(payload.collections.map(item => item.docs.length), [0, 0, 0, 0])
  assert.equal((mockDb.readCounts.get('push_log') || { query: 0 }).query, 0)
  assert.equal((mockDb.readCounts.get('hn_dashboard_ingest_runs') || { query: 0 }).query, 0)
  assert.equal((mockDb.readCounts.get('hn_dashboard_cloud_sync_runs') || { query: 0 }).query, 0)
  assert.equal(payload.summary.insights.update_interval_seconds, 14400)
  assert.equal(payload.summary.insights.latest.date, '2026-05-19')
  assert.equal(Object.prototype.hasOwnProperty.call(payload.summary, '_openid'), false)

  const pushLogResponse = await dashboard.main({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer secret' },
    body: JSON.stringify({ action: 'readCollection', collection: 'push_log', limit: 2, pushLogLimit: 2 })
  })
  assert.equal(pushLogResponse.statusCode, 200)
  const pushLogPayload = JSON.parse(pushLogResponse.body)
  assert.equal(pushLogPayload.collection.loaded, true)
  assert.deepEqual(pushLogPayload.collection.docs.map(item => item._id), ['p3', 'p2'])
  assert.equal(mockDb.queryLimits.get('push_log'), 2)
  assert.equal(Object.prototype.hasOwnProperty.call(pushLogPayload.collection.docs[0], '_openid'), false)

  const ingestResponse = await dashboard.main({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer secret' },
    body: JSON.stringify({
      action: 'readCollection',
      collection: 'hn_dashboard_ingest_runs',
      syncVersion: 42,
      limit: 2,
      ingestLimit: 2
    })
  })
  assert.equal(ingestResponse.statusCode, 200)
  const ingestPayload = JSON.parse(ingestResponse.body)
  assert.deepEqual(ingestPayload.collection.docs.map(item => item._id), ['42:run-new', '42:run-old'])
  assert.equal(mockDb.queryLimits.get('hn_dashboard_ingest_runs'), 2)

  const rejectedResponse = await dashboard.main({
    httpMethod: 'POST',
    headers: {},
    body: '{}'
  })
  assert.equal(rejectedResponse.statusCode, 401)

  const probeResponse = await dashboard.main({
    httpMethod: 'GET',
    queryStringParameters: { versionProbe: '1' }
  })
  assert.equal(probeResponse.statusCode, 200)
  assert.equal(JSON.parse(probeResponse.body).versionProbe, true)

  mockDb.failCollections.add('push_log')
  const failedResponse = await dashboard.main({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: JSON.stringify({ action: 'readCollection', collection: 'push_log', limit: 2 })
  })
  assert.equal(failedResponse.statusCode, 500)
  assert.equal(JSON.parse(failedResponse.body).error.code, 'INTERNAL')

  Module._load = originalLoad
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
