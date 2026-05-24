const assert = require('assert')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')

function blockAfter(name) {
  const start = source.indexOf(name)
  assert.notEqual(start, -1, `${name} not found`)
  const open = source.indexOf('[', start)
  assert.notEqual(open, -1, `${name} array not found`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth += 1
    if (source[i] === ']') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`${name} array did not close`)
}

function objectEntryBlock(entryName) {
  const marker = `${entryName}: [`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${entryName} table column entry not found`)
  return blockAfter(marker)
}

function assertHas(block, field, message) {
  assert.ok(block.includes(`"${field}"`), message || `${field} missing`)
}

const preferredColumns = blockAfter('const PREFERRED_COLUMNS')
;[
  'cleanup_status',
  'insights_content_changed',
  'insightsContentChanged',
  'previousVersion',
  'retainedVersions',
  'keepVersions',
  'businessSkipped',
  'imageCleanup'
].forEach(field => assertHas(preferredColumns, field))

const cloudSyncColumns = objectEntryBlock('hn_dashboard_cloud_sync_runs')
;[
  'status',
  'cleanup_status',
  'run_id',
  'sync_version',
  'started_at',
  'elapsed_seconds'
].forEach(field => assertHas(cloudSyncColumns, field))

assert.ok(
  /doc\.cleanup_status/.test(source),
  'record badges should surface cleanup_status without opening row details'
)

assert.ok(
  /key === "cleanup_status"/.test(source),
  'cleanup_status should render as an operational status value'
)

assert.ok(
  source.includes('update_interval_min_seconds') &&
    source.includes('update_interval_max_seconds'),
  'insights randomized interval min/max fields should be used by the dashboard'
)

assert.ok(
  /formatIntervalRange/.test(source),
  'dashboard should render randomized interval ranges, not only a fixed interval'
)
