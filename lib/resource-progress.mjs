export function canonicalResourceKey(resource, revision, dtype) {
  const raw = resource.url || resource.file || resource.name || 'unknown'
  let pathname = raw
  try { pathname = new URL(raw, 'https://huggingface.co').pathname } catch {}
  const marker = '/resolve/'
  const resolveIndex = pathname.indexOf(marker)
  if (resolveIndex >= 0) pathname = pathname.slice(resolveIndex + marker.length).split('/').slice(1).join('/')
  return `${resource.modelId || 'Xenova/nllb-200-distilled-600M'}@${resource.revision || revision}/${pathname.replace(/^\/+/, '')}#${dtype}`
}

export class ResourceProgress {
  constructor(resources, revision, dtype) {
    this.revision = revision
    this.dtype = dtype
    this.runId = 0
    this.rows = new Map(resources.map((resource) => [canonicalResourceKey(resource, revision, dtype), {
      ...resource, key: canonicalResourceKey(resource, revision, dtype), loaded: 0,
      total: Number.isFinite(resource.bytes) && resource.bytes > 0 ? resource.bytes : null,
      status: 'pending', networkBytes: 0,
    }]))
  }
  start() { this.runId += 1; for (const row of this.rows.values()) { row.loaded = 0; row.networkBytes = 0; if (row.status !== 'verified') row.status = 'pending' } return this.runId }
  cancel() { this.runId += 1; for (const row of this.rows.values()) if (row.status === 'downloading' || row.status === 'retrying') { row.loaded = 0; row.networkBytes = 0; row.status = 'pending' } return this.runId }
  apply(event, runId) {
    if (runId !== this.runId) return false
    const file = event?.file || event?.name
    if (!file) return false
    const key = canonicalResourceKey({ file }, this.revision, this.dtype)
    let row = this.rows.get(key)
    if (!row) { row = { key, file, loaded: 0, total: null, status: 'pending', required: true, networkBytes: 0 }; this.rows.set(key, row) }
    if (Number.isFinite(event.total) && event.total > 0 && !row.total) row.total = event.total
    if (event.status === 'progress' && Number.isFinite(event.loaded)) {
      if (row.status === 'cached') return true
      const next = Math.max(0, event.loaded)
      const isRetry = next < row.loaded
      if (isRetry) row.loaded = 0
      row.loaded = next
      row.networkBytes = next
      row.status = isRetry ? 'retrying' : 'downloading'
    } else if (event.status === 'done' || event.status === 'ready') {
      if (row.total) row.loaded = row.total
      if (row.status !== 'cached') row.status = 'verified'
    } else if (event.status === 'cached') {
      row.status = 'cached'
      row.loaded = row.total || row.loaded
    } else if (event.status === 'error') row.status = 'error'
    if (row.total && row.loaded > row.total) row.loaded = row.total
    return true
  }
  summary() {
    const required = [...this.rows.values()].filter((row) => row.required !== false)
    const known = required.every((row) => row.total !== null)
    const total = required.reduce((sum, row) => sum + (row.total || 0), 0)
    const available = required.reduce((sum, row) => sum + (row.status === 'cached' || row.status === 'verified' ? row.total || row.loaded : Math.min(row.loaded, row.total || row.loaded)), 0)
    const verified = required.filter((row) => row.status === 'verified' || row.status === 'cached').length
    return { known, total, available, percent: known && total ? Math.min(100, Math.floor(available / total * 100)) : null, verified, count: required.length, rows: [...this.rows.values()] }
  }
}
