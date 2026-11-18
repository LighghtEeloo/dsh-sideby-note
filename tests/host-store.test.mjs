/**
 * Host-side store contract: the operations the browser route exposes.
 *
 * A fake storage domain stands in for `ctx.storageDomain`, so these tests
 * exercise the exact read-modify-write and migration logic without touching a
 * real profile or file.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createStore, StoreError } from '../host/store.js'
import { registerStoreRoutes, STORE_PATH } from '../host/store-route.js'
import { createSpec, sessionSchema, workspaceSchema } from '../host/store-spec.js'
import { fakeCtx, fakeDomain } from './fake-store.mjs'

function fakeServer() {
  const routes = new Map()
  return {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    route(path) {
      return routes.get(path)
    },
  }
}

function response() {
  return {
    status: 0,
    body: undefined,
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.body = JSON.parse(payload)
    },
  }
}

function request(method, headers = {}, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { host: '127.0.0.1:53272', ...headers },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

async function storeWith(domain) {
  return createStore(fakeCtx(domain))
}

test('empty snapshot reports empty and a stable revision', async () => {
  const store = await storeWith(fakeDomain())
  const snapshot = await store.snapshot()
  assert.equal(snapshot.empty, true)
  assert.equal(snapshot.rev, 0)
  assert.deepEqual(snapshot.data.sessions, {})
  assert.deepEqual(snapshot.data.prefs, { version: 1 })
})

test('list.patch creates, orders and deletes notes', async () => {
  const store = await storeWith(fakeDomain())
  const a = { id: 'a', text: 'A', done: false, createdAt: 1, updatedAt: 1 }
  const b = { id: 'b', text: 'B', done: false, createdAt: 2, updatedAt: 2 }

  let result = await store.apply({ op: 'list.patch', kind: 'session', listKey: 's1', order: ['a'], upserts: [a] })
  assert.equal(result.record.items.length, 1)
  assert.equal(result.rev, 1)

  result = await store.apply({ op: 'list.patch', kind: 'session', listKey: 's1', order: ['b', 'a'], upserts: [b] })
  assert.deepEqual(result.record.items.map(item => item.id), ['b', 'a'])

  result = await store.apply({ op: 'list.patch', kind: 'session', listKey: 's1', order: ['b'], deletes: ['a'] })
  assert.deepEqual(result.record.items.map(item => item.id), ['b'])

  const snapshot = await store.snapshot()
  assert.equal(snapshot.data.sessions.s1.items.length, 1)
  assert.equal(snapshot.empty, false)
})

test('STORE-023 宿主合并另一标签页新增的条目', async () => {
  const store = await storeWith(fakeDomain())
  const a = { id: 'a', text: 'A', done: false, createdAt: 1, updatedAt: 1 }
  const b = { id: 'b', text: 'B', done: false, createdAt: 2, updatedAt: 2 }
  const c = { id: 'c', text: 'C', done: false, createdAt: 3, updatedAt: 3 }

  await store.apply({ op: 'list.patch', kind: 'workspace', listKey: 'w1', order: ['a'], upserts: [a] })
  // Tab 2 still sees only [a] and adds b.
  await store.apply({ op: 'list.patch', kind: 'workspace', listKey: 'w1', order: ['b', 'a'], upserts: [b] })
  // Tab 1 writes a stale order [a] plus c; b must survive.
  const result = await store.apply({ op: 'list.patch', kind: 'workspace', listKey: 'w1', order: ['c', 'a'], upserts: [c] })
  assert.deepEqual(result.record.items.map(item => item.id), ['c', 'a', 'b'])
})

test('list.ensure folds member sessions in exactly once', async () => {
  const store = await storeWith(fakeDomain())
  const note = { id: 'n1', text: 'from s1', done: false, createdAt: 1, updatedAt: 1 }
  await store.apply({ op: 'list.patch', kind: 'session', listKey: 's1', order: ['n1'], upserts: [note] })

  let result = await store.apply({ op: 'list.ensure', workspaceId: 'w1', sessionIds: ['s1'] })
  assert.deepEqual(result.record.items.map(item => item.id), ['n1'])
  assert.deepEqual(result.record.seededSessionIds, ['s1'])

  // Deleting the workspace note must not resurrect it on the next ensure.
  await store.apply({ op: 'list.patch', kind: 'workspace', listKey: 'w1', order: [], deletes: ['n1'] })
  result = await store.apply({ op: 'list.ensure', workspaceId: 'w1', sessionIds: ['s1'] })
  assert.deepEqual(result.record.items, [])
  assert.equal(result.rev, 3)
})

test('STORE-026 宿主模式转发标记持久化', async () => {
  const store = await storeWith(fakeDomain())
  await store.apply({ op: 'forward.set', listKey: 'ws:w1', itemId: 'n1', on: true })
  let snapshot = await store.snapshot()
  assert.deepEqual(snapshot.data.forwarded['ws:w1'], { n1: true })

  await store.apply({ op: 'forward.set', listKey: 'ws:w1', itemId: 'n1', on: false })
  snapshot = await store.snapshot()
  assert.equal(snapshot.data.forwarded['ws:w1'], undefined)
})

test('STORE-026 宿主模式偏好持久化', async () => {
  const store = await storeWith(fakeDomain())
  await store.apply({ op: 'prefs.set', patch: { scopeMode: 'session', forwardPrefix: '请处理' } })
  let snapshot = await store.snapshot()
  assert.equal(snapshot.data.prefs.scopeMode, 'session')
  assert.equal(snapshot.data.prefs.forwardPrefix, '请处理')

  await store.apply({ op: 'prefs.set', patch: { forwardPrefix: null, sendShortcut: 'ctrl-enter' } })
  snapshot = await store.snapshot()
  assert.equal(snapshot.data.prefs.forwardPrefix, undefined)
  assert.equal(snapshot.data.prefs.sendShortcut, 'ctrl-enter')
})

test('migrate is two-phase and idempotent', async () => {
  const store = await storeWith(fakeDomain())
  const snapshot = {
    sessions: { s1: { updatedAt: 1, items: [{ id: 'n1', text: 'old', done: false, createdAt: 1, updatedAt: 1 }] } },
    workspaces: { w1: { updatedAt: 2, items: [], seededSessionIds: ['s1'] } },
    forwarded: { 'ws:w1': { n1: true } },
    prefs: { scopeMode: 'workspace', forwardPrefix: '前缀' },
  }
  const first = await store.apply({ op: 'migrate', snapshot, source: 'localStorage' })
  assert.equal(first.migrated, 3)
  const data = (await store.snapshot()).data
  assert.equal(data.sessions.s1.items[0].text, 'old')
  assert.equal(data.workspaces.w1.seededSessionIds[0], 's1')
  assert.equal(data.prefs.migration.complete, true)
  assert.equal(data.prefs.forwardPrefix, '前缀')

  const second = await store.apply({ op: 'migrate', snapshot, source: 'localStorage' })
  assert.equal(second.alreadyComplete, true)
  assert.equal(second.migrated, 0)
})

test('STORE-024 迁移中断后重启补完且不重复', async () => {
  const domain = fakeDomain()
  const store = await storeWith(domain)
  await store.apply({ op: 'migrate', snapshot: { sessions: {}, prefs: {} }, source: 'localStorage' })
  // Simulate a crash after the marker was written but before the records were.
  await domain.global.set({ version: 1, migration: { complete: false, at: 1, source: 'localStorage' } })

  const result = await store.apply({
    op: 'migrate',
    snapshot: { sessions: { s9: { updatedAt: 1, items: [] } }, prefs: {} },
    source: 'localStorage',
  })
  assert.equal(result.migrated, 1)
  const data = (await store.snapshot()).data
  assert.equal(data.prefs.migration.complete, true)
  assert.ok(data.sessions.s9)
})

test('STORE-025 宿主文件打不开时报告存储错误', async () => {
  const noStorage = createStore({ get: () => undefined })
  await assert.rejects(noStorage.snapshot(), error => error instanceof StoreError && error.code === 'STORE_UNAVAILABLE' && error.status === 503)

  const broken = createStore(fakeCtx(undefined))
  await assert.rejects(broken.snapshot(), error => error instanceof StoreError && error.code === 'STORE_OPEN_FAILED')
})

test('the spec is valid and rejects malformed records', () => {
  const spec = createSpec()
  assert.equal(spec.name, 'aside_note')
  assert.equal(spec.version, 1)
  assert.equal(spec.layout, 'single')
  assert.deepEqual(Object.keys(spec.tables).sort(), ['forwarded', 'sessions', 'workspaces'])
  assert.equal(sessionSchema.safeParse({ updatedAt: 1, items: [{ id: 'a', text: '', done: false, createdAt: 1, updatedAt: 1 }] }).success, false)
  assert.equal(workspaceSchema.safeParse({ updatedAt: 1, items: [], seededSessionIds: [] }).success, true)
})

test('store routes enforce method, origin, content type and JSON body', async () => {
  const server = fakeServer()
  const store = await storeWith(fakeDomain())
  const dispose = registerStoreRoutes(server, { ctx: { get: () => undefined }, store })
  const route = server.route(STORE_PATH)
  assert.equal(route.kind, 'exact')

  let res = response()
  await route.handler(request('GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.empty, true)

  res = response()
  await route.handler(request('GET', { 'sec-fetch-site': 'cross-site' }), res)
  assert.equal(res.status, 403)

  res = response()
  await route.handler(request('PUT'), res)
  assert.equal(res.status, 405)

  res = response()
  await route.handler(request('POST', { 'content-type': 'text/plain' }, {}), res)
  assert.equal(res.status, 400)

  res = response()
  await route.handler(request('POST', { 'content-type': 'application/json' }, { op: 'list.patch', kind: 'session', listKey: 's1', order: [], upserts: [] }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)

  res = response()
  await route.handler(request('POST', { 'content-type': 'application/json' }, { op: 'nope' }), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'STORE_BAD_REQUEST')

  if (typeof dispose === 'function') dispose()
})

test('store routes honor the shared browser-session check when available', async () => {
  const server = fakeServer()
  const store = await storeWith(fakeDomain())
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => 401 }
      return undefined
    },
  }
  registerStoreRoutes(server, { ctx, store })
  const res = response()
  await server.route(STORE_PATH).handler(request('GET'), res)
  assert.equal(res.status, 403)
})

test('STORE-027 宿主模式 400 条仍可新增', async () => {
  const store = await storeWith(fakeDomain())
  const notes = Array.from({ length: 400 }, (_, index) => ({
    id: `n${index}`,
    text: `条目 ${index}`,
    done: false,
    createdAt: index,
    updatedAt: index,
  }))
  const first = await store.apply({
    op: 'list.patch',
    kind: 'session',
    listKey: 'big',
    order: notes.map(note => note.id),
    upserts: notes,
  })
  assert.equal(first.record.items.length, 400)

  const extra = { id: 'n400', text: '第 401 条', done: false, createdAt: 400, updatedAt: 400 }
  const second = await store.apply({
    op: 'list.patch',
    kind: 'session',
    listKey: 'big',
    order: [...notes.map(note => note.id), extra.id],
    upserts: [extra],
  })
  assert.equal(second.record.items.length, 401)
  const snapshot = await store.snapshot()
  assert.equal(snapshot.data.sessions.big.items.length, 401)
})
