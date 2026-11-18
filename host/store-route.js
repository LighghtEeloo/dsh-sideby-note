/**
 * The note store's same-origin endpoints.
 *
 * One exact path, two methods: GET hydrates the browser cache, POST applies a
 * small mutation. Reads are served from the domain's in-memory state, so a
 * snapshot is cheap; writes go through the domain's durable chain before the
 * response is sent, which is what lets the panel keep "a failed save changes
 * nothing" as its contract.
 */
import { BodyError, readJsonBody, sameOrigin, sendJson } from './http.js'
import { StoreError } from './store.js'

/** Same-origin endpoint; keep in sync with the browser half. */
export const STORE_PATH = '/dsh-aside-note/store'
/** Whole-snapshot writes are bounded; a note list cannot approach this. */
const BODY_LIMIT = 2 * 1024 * 1024

/**
 * Apply the Host/Origin fence and, when the host exposes it, the shared
 * browser-session authentication.
 * @param {any} ctx
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
function authorized(ctx, request) {
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      return connection.requestRejection(request) === undefined
    } catch {
      // Fall through to the carrier-independent Origin check.
    }
  }
  return sameOrigin(request)
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} error
 */
function sendError(response, error) {
  const failure = error instanceof StoreError
    ? error
    : new StoreError('STORE_FAILED', error instanceof Error ? error.message : String(error), 502)
  sendJson(response, failure.status, {
    ok: false,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  })
}

/**
 * Register the store endpoints on the host's web server.
 * @param {{ register?: (route: { kind: 'exact', path: string, handler: (request: any, response: any) => unknown }) => unknown }} server
 * @param {{ ctx: any, store: import('./store.js').Store }} options
 * @returns {(() => void) | undefined}
 */
export function registerStoreRoutes(server, options) {
  if (typeof server?.register !== 'function') return undefined
  const { ctx, store } = options
  const dispose = server.register({
    kind: 'exact',
    path: STORE_PATH,
    handler: async (request, response) => {
      if (!authorized(ctx, request)) {
        sendJson(response, 403, { ok: false, code: 'STORE_FORBIDDEN', message: 'forbidden' })
        return
      }
      if (request.method === 'GET') {
        try {
          const snapshot = await store.snapshot()
          sendJson(response, 200, { ok: true, ...snapshot })
        } catch (error) {
          sendError(response, error)
        }
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'use GET or POST' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.includes('application/json')) {
        sendJson(response, 400, { ok: false, code: 'STORE_BAD_REQUEST', message: 'content-type must be application/json' })
        return
      }
      let body
      try {
        body = await readJsonBody(request, BODY_LIMIT)
      } catch (error) {
        if (error instanceof BodyError) {
          sendJson(response, error.code === 'BODY_TOO_LARGE' ? 413 : 400, {
            ok: false,
            code: error.code === 'BODY_TOO_LARGE' ? 'STORE_TOO_LARGE' : 'STORE_BAD_REQUEST',
            message: error.message,
          })
          return
        }
        sendError(response, error)
        return
      }
      try {
        const result = await store.apply(body)
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        sendError(response, error)
      }
    },
  })
  return dispose
}
