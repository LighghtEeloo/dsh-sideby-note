/**
 * Boots the built bundle the way the shell does.
 *
 * The contract test only reads text; this one actually runs `client/client.js`
 * inside a jsdom realm, hands its factory a module table, calls `apply(ctx)`
 * and checks the two registrations, the injected stylesheet and the host-DOM
 * header entry. It is the P1 stand-in for the real-GUI smoke test.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'client', 'client.js')
const bundle = fs.readFileSync(bundlePath, 'utf8')

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
// Update-flow fixtures move with the build. LATEST is one major above the
// running version, IN_BETWEEN sits in the gap so the panel lists two releases,
// and OLD is below the build so it must never be listed. Pinning these broke
// every release: the build bumps and the "newer" fixture silently becomes older.
const RUNNING = manifest.version
// A build from a published channel (`X.Y.Z-beta.N`) also reads `next`; a stable
// build reads `latest` alone. The expected request list follows the shipped
// version instead of pinning one shape, which broke every release.
const CHANNELS = /-(?:alpha|beta|rc)\./.test(RUNNING) ? ['latest', 'next'] : ['latest']
const REGISTRY_URLS = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
  .flatMap(host => CHANNELS.map(channel => `${host}/dsh-sideby-note/${channel}`))
// The core only: a prerelease build (1.1.2-beta.1) would otherwise make PATCH NaN.
const [MAJOR, MINOR, PATCH] = RUNNING.replace(/-.*$/, '').split('.').map(Number)
const LATEST = `${MAJOR + 1}.0.0`
const IN_BETWEEN = `${MAJOR}.${MINOR}.${PATCH + 1}`
const OLD = '0.0.1'
const PRERELEASE = `${LATEST}-beta.1`
const DRAFT = `${MAJOR + 1}.0.1`

test('the built bundle boots, applies, and seats its slots', async t => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="_headerUtilities"></div>' +
      '<div data-conversation-session="session-1"><textarea data-composer-input></textarea></div></body></html>',
    { url: 'https://example.test/', pretendToBeVisual: true, runScripts: 'outside-only' },
  )
  const { window } = dom
  t.after(() => window.close())
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  // Seed the current keys before the plugin boots: one open note plus a stale
  // send preference from the removed setting. No legacy key is read or copied,
  // and the stale preference must no longer change what Enter does.
  window.localStorage.setItem('dsh.aside-note', JSON.stringify({
    version: 1,
    sessions: { 'session-1': { items: [{ id: 'seed', text: '旧便笺', done: false, createdAt: 1, updatedAt: 1 }] } },
  }))
  window.localStorage.setItem('dsh.aside-note.send-shortcut', 'ctrl-enter')

  // Loaded after the DOM globals exist: react-dom decides `canUseDOM` at import.
  const React = await import('react')
  const ReactDOM = await import('react-dom')
  const ReactDOMClient = await import('react-dom/client')
  const { act } = React

  // The panel probes npm when it opens and asks the host only when a newer
  // version exists. Answer inside this realm so the shipped notes fetch,
  // cache and update flow run without touching the network.
  const RELEASE_BODY = `# English

<!-- app-update-notes:en:start -->
### Added
- **Update centre:** Notes are readable in the panel. (#31)
<!-- app-update-notes:en:end -->

# 中文

<!-- app-update-notes:zh:start -->
### 新增
- **更新中心：** 可以直接在面板里查看更新说明。 （#31）

### 修复
- **提示点：** 已是最新版本时不再显示。 （#32）
<!-- app-update-notes:zh:end -->
`
  const OLDER_BODY = `# 中文

<!-- app-update-notes:zh:start -->
### 修复
- **旧版本：** 修复了上一个版本的问题。 （#30）
<!-- app-update-notes:zh:end -->
`
  const releaseUrl = version => `https://github.com/LighghtEeloo/dsh-sideby-note/releases/tag/v${version}`
  const RELEASES = [
    { tag_name: `v${LATEST}`, html_url: releaseUrl(LATEST), body: RELEASE_BODY },
    { tag_name: `v${IN_BETWEEN}`, html_url: releaseUrl(IN_BETWEEN), body: OLDER_BODY },
    // Older than the running build and a prerelease: neither may appear.
    { tag_name: `v${OLD}`, html_url: releaseUrl(OLD), body: OLDER_BODY },
    { tag_name: `v${PRERELEASE}`, prerelease: true, body: RELEASE_BODY },
    { tag_name: `v${DRAFT}`, draft: true, body: RELEASE_BODY },
  ]
  const calls = []
  let hostUpdates = 0
  let hostTarget = null
  // One manual check is held open so the test can see the in-flight render.
  let holdManualCheck = false
  let releaseManualCheck = null
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  window.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = init.method || 'GET'
    calls.push({ url, method })
    if (url.startsWith('https://registry.npmjs.org/')) return json(404, {})
    if (url.startsWith('https://registry.npmmirror.com/')) {
      if (holdManualCheck) {
        holdManualCheck = false
        return new Promise(resolve => {
          releaseManualCheck = () => resolve(json(200, { version: LATEST }))
        })
      }
      return json(200, { version: LATEST })
    }
    if (url === 'https://api.github.com/repos/LighghtEeloo/dsh-sideby-note/releases?per_page=50') {
      return json(200, RELEASES)
    }
    if (url === '/dsh-sideby-note/update/apply' && method === 'POST') {
      hostUpdates += 1
      hostTarget = JSON.parse(init.body).target
      return json(200, {
        ok: true,
        route: 'dsh',
        previousVersion: RUNNING,
        installedVersion: hostTarget,
        updated: true,
        restartRequired: true,
      })
    }
    return json(404, {})
  }
  const registryCalls = () => calls.filter(call => call.url.includes('registry.'))

  let loaded = null
  window.__ModuleLoader__ = { load: spec => { loaded = spec } }
  window.eval(bundle)

  assert.equal(loaded.id, 'dsh-sideby-note')
  const moduleTable = {
    react: React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
    '@deepseek-ai/dsh-client-ui-primitives': {},
  }
  const requireShim = id => {
    if (!(id in moduleTable)) throw new Error(`module table cannot answer ${id}`)
    return moduleTable[id]
  }
  const exported = loaded.factory(requireShim)
  assert.deepEqual([...exported.inject], ['slots'])
  assert.equal(typeof exported.apply, 'function')

  const effects = []
  const disposers = []
  const registered = []
  const injected = []
  const dictionaries = []
  const locale = {
    bind: () => key => key,
    register: (ns, dict) => { dictionaries.push({ ns, dict }) },
    getLocale: () => ({ active: 'zh' }),
  }
  const ctx = {
    get: name => (name === 'locale' ? locale : undefined),
    effect: (fn, label) => {
      effects.push(label)
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (name, factory) => {
        injected.push(name)
        factory()
      },
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
  }

  await act(async () => { exported.apply(ctx) })

  assert.deepEqual(injected.sort(), ['conversation.composer.dock', 'conversation.hero.options', 'shell.overlay'])
  assert.equal(registered.length, 3, 'the capture, the new-session seat and the toast host must be registered')
  assert.deepEqual(registered.map(entry => entry.meta.name).sort(), injected)
  assert.equal(dictionaries.length, 1, 'the bundle registers one locale namespace')
  assert.deepEqual(
    Object.keys(dictionaries[0].dict).sort(),
    ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'],
    'the built bundle must carry every DSH-official locale',
  )
  // The improver is credited by Chinese name in Chinese only; every other
  // language carries the GitHub handle instead.
  const dict = dictionaries[0].dict
  assert.equal(dict.zh['settings.improverName'], '光吟')
  for (const language of ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru']) {
    assert.equal(
      dict[language]['settings.improverName'],
      'LighghtEeloo',
      `${language} must credit the improver by handle`,
    )
  }

  const seeded = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(seeded.sessions['session-1'].items[0].text, '旧便笺')
  // The plugin neither reads nor rewrites the retired preference.
  assert.equal(window.localStorage.getItem('dsh.aside-note.send-shortcut'), 'ctrl-enter')
  assert.equal(window.localStorage.getItem('dsh.aside-note.migrated'), null, 'no migration marker is written')

  const style = document.querySelector('style[data-dsh-plugin="dsh-sideby-note"]')
  assert.ok(style, 'the document-level stylesheet must be injected')
  assert.match(style.textContent, /\.dsh-an-popover\{/)

  // Render the session capture the shell would mount, then let its effect seat
  // the header entry into the host-owned utilities row.
  const capture = registered.find(entry => entry.meta.name === 'conversation.composer.dock').component
  const container = document.createElement('div')
  document.body.appendChild(container)
  const reactRoot = ReactDOMClient.createRoot(container)
  await act(async () => {
    reactRoot.render(React.createElement(capture, { sessionId: 'session-1' }))
  })

  const button = document.querySelector('._headerUtilities > .dsh-an-headerBtn')
  assert.ok(button, 'the header entry must be injected into the host utilities row')
  assert.equal(button.dataset.sessionId, 'session-1')
  assert.match(button.getAttribute('aria-label'), /边记部/)
  // The seeded note is open, so the entry already shows a count.
  assert.equal(button.querySelector('.dsh-an-headerCount').textContent, '1')

  // Open the panel from that entry and write a note through the real form.
  await act(async () => { button.click() })
  const popover = document.querySelector('.dsh-an-popover')
  assert.ok(popover, 'clicking the header entry must open the panel')
  assert.equal(popover.querySelector('.dsh-an-popTitle').textContent, '边记部', 'the panel title is the product name')
  const addField = popover.querySelector('.dsh-an-input')
  assert.ok(addField, 'the panel must render the add field')
  assert.equal(addField.getAttribute('placeholder'), '随手记一条', 'the composer uses the finalized placeholder')
  // Set the value through the prototype setter so React's value tracker sees a
  // change, then dispatch the input event React listens for. fireEvent would
  // resolve the prototype in the Node realm, not this jsdom one.
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  await act(async () => {
    valueSetter.call(addField, '新的一条')
    addField.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const addButton = popover.querySelector('.dsh-an-addBtn')
  assert.equal(addButton.disabled, false, 'the add button enables once the draft has text')
  await act(async () => { addButton.click() })
  const written = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(written.sessions['session-1'].items[0].text, '新的一条')
  assert.equal(written.sessions['session-1'].items.length, 2)
  // The entry refreshes on a rAF after the store write; give jsdom one frame.
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 40)) })
  assert.equal(document.querySelector('.dsh-an-headerCount').textContent, '2')

  // Settings: only About remains; the forward prefix and the shortcut are gone.
  await act(async () => { popover.querySelector('.dsh-an-settingsBtn').click() })
  assert.ok(popover.querySelector('.dsh-an-settings'), 'the gear must open the settings card')
  const settingsViewport = popover.querySelector('.dsh-an-settingsViewport')
  assert.ok(settingsViewport, 'the settings card must sit in its own scroll viewport')
  assert.ok(settingsViewport.contains(popover.querySelector('.dsh-an-settings')), 'the viewport wraps the card')
  assert.equal(popover.dataset.settings, 'true', 'the panel marks the settings state for the layout rules')
  const brand = popover.querySelector('.dsh-an-settingBrand')
  assert.ok(brand, 'About must show the product identity')
  assert.match(brand.textContent, /边记部/)
  assert.match(brand.textContent, /趁 agent 工作时，异步记下你的想法/)
  // Credits: the author first, then the improver, each as its own key/value row.
  const metaRows = [...popover.querySelectorAll('.dsh-an-settingMetaRow')].map(row => row.textContent)
  assert.ok(metaRows.includes('作者·阿三石'), 'About credits the author')
  assert.ok(metaRows.includes('改良者·光吟'), 'About credits the improver')
  assert.equal(
    metaRows.indexOf('改良者·光吟'),
    metaRows.indexOf('作者·阿三石') + 1,
    'the improver row sits right after the author',
  )
  assert.equal(popover.querySelectorAll('input[type="radio"]').length, 0, 'the shortcut radios are gone')
  assert.doesNotMatch(popover.querySelector('.dsh-an-settings').textContent, /发送快捷键/, 'no shortcut setting remains')

  // The npmjs read fails, the mirror answers with a newer version: the gear
  // gains a dot and About shows the update card.
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 20)) })
  assert.deepEqual(registryCalls().map(call => call.url), REGISTRY_URLS, 'the npmjs miss must fall back to the npmmirror host')
  assert.ok(popover.querySelector('.dsh-an-updateDot'), 'the gear carries the update dot')
  const updateCard = popover.querySelector('.dsh-an-updateCard')
  assert.ok(updateCard, 'a newer version must surface in Settings > About')
  assert.ok(updateCard.textContent.includes(IN_BETWEEN), 'gap | html=' + updateCard.outerHTML.replace(/\\s+/g, ' ').slice(0, 900))
  // Notes are part of the card, loaded without a disclosure click.
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 80)) })
  assert.ok(popover.querySelector('.dsh-an-updateNotes'), 'release notes must load by default')

  // The manual check bypasses the hourly cache and reads the registry again.
  // Hold its answer to assert the card does not unmount while the check runs.
  const beforeCheck = registryCalls().length
  holdManualCheck = true
  await act(async () => { popover.querySelector('.dsh-an-updateCheck').click() })
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 60)) })
  assert.ok(popover.querySelector('.dsh-an-updateCard'), 'the card must stay mounted while a manual check runs')
  assert.ok(popover.querySelector('.dsh-an-updateDot'), 'the update dot must stay while checking')
  assert.equal(popover.querySelector('.dsh-an-updateCheck').textContent, '正在检查…', 'only the button reports progress')
  releaseManualCheck()
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 80)) })
  assert.equal(registryCalls().length, beforeCheck + REGISTRY_URLS.length, 'a manual check must bypass the cache')
  // The checking state is deliberately held for at least three seconds; wait it
  // out before expecting an available release again.
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 3200)) })

  // The release list is already visible: two releases in the gap, the newest
  // open and the older one collapsed until its version heading is clicked.
  const notes = popover.querySelector('.dsh-an-updateNotes')
  assert.ok(notes, 'release notes stay visible after a check')
  assert.match(notes.textContent, /本次更新包含 2 个版本/)
  const heads = [...notes.querySelectorAll('.dsh-an-updateVersionHead')]
  assert.deepEqual(heads.map(head => head.textContent.replace('▸', '')), [`v${LATEST}最新`, `v${IN_BETWEEN}`])
  assert.match(notes.textContent, /更新中心/)
  assert.ok(!notes.textContent.includes(`v${PRERELEASE}`), 'prereleases are not offered')
  assert.ok(!notes.textContent.includes(`v${OLD}`), 'releases older than the build are not listed')
  assert.equal(heads[0].getAttribute('aria-expanded'), 'true', 'the release being installed opens')
  assert.equal(heads[1].getAttribute('aria-expanded'), 'false', 'older releases wait for a click')
  await act(async () => { heads[1].click() })
  assert.match(notes.textContent, /修复了上一个版本的问题/, 'clicking an older version expands its notes')
  const fullLink = popover.querySelector('.dsh-an-updateFull')
  assert.equal(fullLink.getAttribute('href'), releaseUrl(LATEST))
  assert.equal(fullLink.getAttribute('target'), '_blank')
  const actions = popover.querySelector('.dsh-an-updateActions')
  assert.ok(actions, 'the action row carries the update button and the full-release link')
  assert.equal(actions.lastElementChild, fullLink, 'the full-release link sits to the right of the update button')
  const updateButton = actions.querySelector('.dsh-an-updatePrimary')
  assert.ok(updateButton, 'the update button shares that row')
  assert.equal(updateButton.textContent, '立即更新')
  assert.equal(popover.querySelector('.dsh-an-updateFallback'), null,
    'a reachable host shows no manual fallback before it is needed')

  // "Update now" posts one host request and settles on the refresh action.
  await act(async () => { updateButton.click() })
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 200)) })
  assert.equal(hostUpdates, 1, 'the update must POST to the host exactly once')
  assert.equal(hostTarget, LATEST, 'the host receives the offered version')
  assert.equal(calls.filter(call => call.url.includes('/dsh-market/')).length, 0,
    'the update path must not probe the plugin market')
  const done = [...popover.querySelectorAll('.dsh-an-updatePrimary')].map(node => node.textContent)
  assert.ok(done.includes('刷新页面'), `the finished host update offers a refresh, saw ${JSON.stringify(done)}`)

  assert.equal(popover.querySelector('#dsh-an-forward-prefix'), null, 'the forward prefix field is gone')

  // There is no checkbox: open rows lead with a reorder grip instead.
  assert.equal(popover.querySelector('.dsh-an-check'), null, 'notes are no longer completed by hand')
  const openRows = () => [...popover.querySelectorAll('.dsh-an-listSection:first-child .dsh-an-row')]
  const openTexts = () => openRows().map(node => node.querySelector('.dsh-an-text').textContent)
  const storedTexts = () => JSON.parse(window.localStorage.getItem('dsh.aside-note')).sessions['session-1'].items.map(item => item.text)
  assert.deepEqual(openTexts(), ['新的一条', '旧便笺'])
  const firstGrip = openRows()[0].querySelector('.dsh-an-grip')
  assert.ok(firstGrip, 'an open row carries a grip')
  assert.equal(firstGrip.getAttribute('aria-label'), '拖动排序，↑↓ 亦可')

  // ↓ on a focused grip moves that note one slot down and keeps focus on it.
  firstGrip.focus()
  const press = async (node, key) => {
    await act(async () => {
      node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }
  await press(firstGrip, 'ArrowDown')
  assert.deepEqual(openTexts(), ['旧便笺', '新的一条'], 'ArrowDown moves the note down')
  assert.deepEqual(storedTexts(), ['旧便笺', '新的一条'], 'the new order is stored')
  assert.equal(document.activeElement, firstGrip, 'the moved grip keeps focus')
  await press(firstGrip, 'ArrowDown')
  assert.deepEqual(storedTexts(), ['旧便笺', '新的一条'], 'the last note cannot move further down')
  await press(firstGrip, 'ArrowUp')
  assert.deepEqual(storedTexts(), ['新的一条', '旧便笺'], 'ArrowUp moves it back')

  // 递入对话 needs a composer on screen; without one nothing changes.
  const composer = document.querySelector('[data-composer-input]')
  const insertButton = text => openRows()
    .find(node => node.querySelector('.dsh-an-text').textContent === text)
    .querySelector('.dsh-an-iconBtn[aria-label="递入对话"]')
  await act(async () => { insertButton('新的一条').click() })
  assert.equal(composer.value, '', 'a hidden composer receives nothing')
  assert.ok(storedTexts().length === 2 && JSON.parse(window.localStorage.getItem('dsh.aside-note'))
    .sessions['session-1'].items.every(item => item.done === false), 'a failed insert keeps the note open')

  // With the composer visible the note lands there and is archived in one step.
  composer.getBoundingClientRect = () => ({
    width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24, x: 0, y: 0, toJSON: () => ({}),
  })
  await act(async () => { insertButton('新的一条').click() })
  assert.equal(composer.value, '新的一条', 'the note goes into the chat composer as plain text')
  const inserted = JSON.parse(window.localStorage.getItem('dsh.aside-note')).sessions['session-1'].items
    .find(item => item.text === '新的一条')
  assert.equal(inserted.done, true, 'putting the note into the chat archives it')
  assert.ok(Number.isFinite(inserted.completedAt), 'the archive time is stamped')
  assert.equal(window.localStorage.getItem('dsh.aside-note.forwarded'), null, 'no forward marks are written')
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 40)) })
  assert.equal(document.querySelector('.dsh-an-headerCount').textContent, '1')
  assert.deepEqual(openTexts(), ['旧便笺'])

  // The archive is collapsed by default; an archived row has neither a grip nor an insert action.
  const archiveToggle = popover.querySelector('.dsh-an-doneHead .dsh-an-doneToggle')
  assert.match(archiveToggle.textContent, /归档/)
  await act(async () => { archiveToggle.click() })
  const archivedRow = popover.querySelector('.dsh-an-rowArchived')
  assert.ok(archivedRow, 'the archived note renders in the archive')
  assert.equal(archivedRow.querySelector('.dsh-an-grip'), null, 'archived rows sort by time, not by hand')
  assert.ok(archivedRow.querySelector('.dsh-an-gripSpacer'), 'the text keeps the shared edge')
  assert.equal(archivedRow.querySelector('.dsh-an-insert'), null, 'an archived note cannot be inserted again')
  assert.ok(archivedRow.querySelector('.dsh-an-iconBtn[aria-label="退回"]'), 'an archived note can still be taken back')
  const clearButton = popover.querySelector('.dsh-an-clear')
  assert.ok(clearButton, 'the archive must offer clear')
  assert.equal(clearButton.textContent, '清空归档')
  await act(async () => { clearButton.click() })
  assert.ok(popover.querySelector('.dsh-an-clearConfirm'), 'clearing asks for a second click')
  await act(async () => { popover.querySelector('.dsh-an-miniDanger').click() })
  const afterClear = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(afterClear.sessions['session-1'].items.length, 1)
  assert.equal(afterClear.sessions['session-1'].items[0].done, false)

  // 退回 is the only way back into the composer: it moves the remaining note
  // into the top input and clears the row. A non-empty draft is never replaced.
  const recallButton = popover.querySelector('.dsh-an-iconBtn[aria-label="退回"]')
  assert.ok(recallButton, 'the row must offer 退回')
  await act(async () => {
    valueSetter.call(addField, '未发送的草稿')
    addField.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { recallButton.click() })
  const blocked = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(blocked.sessions['session-1'].items.length, 1, 'a non-empty composer blocks 退回')
  assert.equal(addField.value, '未发送的草稿', 'the existing draft is left untouched')
  await act(async () => {
    valueSetter.call(addField, '')
    addField.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { recallButton.click() })
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 40)) })
  const afterRecall = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(afterRecall.sessions['session-1'].items.length, 0, '退回 removes the row')
  assert.equal(addField.value, '旧便笺', 'the note text lands in the top composer')
  assert.equal(popover.querySelector('.dsh-an-editInput'), null, 'there is no inline editor')
  const empty = popover.querySelector('.dsh-an-empty')
  assert.ok(empty, 'the list falls back to the empty state')
  assert.match(empty.textContent, /边记摸鱼中\.\./)
  assert.match(empty.textContent, /趁 agent 工作时，异步记下你的想法/)

  // Submitting the recalled text adds it back as a fresh open note.
  await act(async () => { popover.querySelector('.dsh-an-addBtn').click() })
  const afterReturn = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(afterReturn.sessions['session-1'].items[0].text, '旧便笺')
  assert.equal(afterReturn.sessions['session-1'].items[0].done, false)
  assert.equal(addField.value, '', 'the composer clears after adding the recalled note')

  // Enter behaves like the main composer: plain Enter adds, Shift+Enter only
  // breaks the line, and the stale shortcut preference does not change that.
  await act(async () => {
    valueSetter.call(addField, '回车提交')
    addField.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    addField.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const viaEnter = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(viaEnter.sessions['session-1'].items[0].text, '回车提交', 'Enter must add the note')
  assert.equal(addField.value, '', 'Enter clears the composer after adding')
  // The main composer also sends on the command chord; so does this one.
  await act(async () => {
    valueSetter.call(addField, '组合键提交')
    addField.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    addField.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
  })
  const viaChord = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(viaChord.sessions['session-1'].items[0].text, '组合键提交', 'the command chord submits like the main composer')
  await act(async () => {
    valueSetter.call(addField, '换行草稿')
    addField.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    addField.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
  })
  const afterShift = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(
    afterShift.sessions['session-1'].items.length,
    viaChord.sessions['session-1'].items.length,
    'Shift+Enter must not add a note',
  )
  assert.equal(addField.value, '换行草稿', 'Shift+Enter leaves the draft in the composer')
  // Clear the line-break draft so the original recall flow below still runs.
  await act(async () => {
    valueSetter.call(addField, '')
    addField.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { popover.querySelector('.dsh-an-iconBtn[aria-label="退回"]').click() })
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 40)) })

  const widthHandle = popover.querySelector('.dsh-an-resizeHandle')
  assert.ok(widthHandle, 'a right-side panel exposes the width handle')
  const widthBefore = Number(window.localStorage.getItem('dsh.aside-note.panel-width')) || 360
  await act(async () => { widthHandle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  assert.ok(Number(window.localStorage.getItem('dsh.aside-note.panel-width')) > widthBefore)

  // Section collapse is remembered.
  await act(async () => { popover.querySelector('.dsh-an-sectionHead .dsh-an-doneToggle').click() })
  const sections = JSON.parse(window.localStorage.getItem('dsh.aside-note.sections'))
  assert.equal(sections.open, false)

  // The probe caches its answer, so reopening the panel reads no registry again.
  await act(async () => { popover.querySelector('.dsh-an-popClose').click() })
  assert.equal(document.querySelector('.dsh-an-popover'), null, 'the close button removes the panel')
  await act(async () => { button.click() })
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 20)) })
  assert.equal(registryCalls().length, beforeCheck + REGISTRY_URLS.length, 'the cached answer must be reused by a reopened panel')
  assert.ok(document.querySelector('.dsh-an-popover').querySelector('.dsh-an-updateDot'))

  await act(async () => { reactRoot.unmount() })
  for (const dispose of disposers) dispose()
  assert.equal(document.querySelector('style[data-dsh-plugin="dsh-sideby-note"]'), null,
    'the stylesheet must be removed when the plugin is disposed')
  dom.window.close()
})

test('one workspace shares its notes and forwards into the visible session', async t => {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<div class="_headerUtilities"></div>' +
      '<div data-conversation-session="session-1"><textarea data-composer-input></textarea></div>' +
      '<div data-conversation-session="session-2"><textarea data-composer-input></textarea></div>' +
    '</body></html>',
    { url: 'https://example.test/', pretendToBeVisual: true, runScripts: 'outside-only' },
  )
  const { window } = dom
  t.after(() => window.close())
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  // jsdom returns a zero rect for every node; the composer and panel both treat
  // a zero-size node as invisible, so give them a layout box.
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24, x: 0, y: 0,
    toJSON: () => ({}),
  })

  // Two sessions in one workspace, each with a note written before the list
  // was shared. Both must be folded into the workspace list exactly once.
  window.localStorage.setItem('dsh.aside-note', JSON.stringify({
    version: 1,
    sessions: {
      'session-1': { items: [{ id: 'seed-1', text: '会话一的事项', done: false, createdAt: 1, updatedAt: 1 }] },
      'session-2': { items: [{ id: 'seed-2', text: '会话二的事项', done: false, createdAt: 2, updatedAt: 2 }] },
    },
  }))
  window.localStorage.setItem('dsh.aside-note.drafts', JSON.stringify({
    version: 1,
    sessions: {
      'session-1': { add: '会话一的旧草稿', edits: { 'seed-1': '旧编辑草稿' } },
      'session-2': { add: '会话二的旧草稿' },
    },
  }))
  window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })

  const React = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const { act } = React

  let loaded = null
  window.__ModuleLoader__ = { load: spec => { loaded = spec } }
  window.eval(bundle)

  const moduleTable = {
    react: React,
    'react-dom': await import('react-dom'),
    'react-dom/client': ReactDOMClient,
    '@deepseek-ai/dsh-client-ui-primitives': {},
  }
  const exported = loaded.factory(id => {
    if (!(id in moduleTable)) throw new Error(`module table cannot answer ${id}`)
    return moduleTable[id]
  })

  const disposers = []
  const registered = []
  const locale = {
    bind: () => key => key,
    register: () => {},
    getLocale: () => ({ active: 'zh' }),
  }
  const ctx = {
    get: name => (name === 'locale' ? locale : undefined),
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
  }
  await act(async () => { exported.apply(ctx) })

  const capture = registered.find(entry => entry.meta.name === 'conversation.composer.dock').component
  const workspace = {
    workspaceId: 'ws-1',
    path: '/repo',
    title: '共享工作区',
    sessionIds: ['session-1', 'session-2'],
    createdAt: '',
    updatedAt: '',
  }
  // Stand-in for the global standard prop ui-workspace publishes on every slot.
  const useWorkspaces = selector => selector({ items: [workspace], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const firstRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    firstRoot.render(React.createElement(capture, { sessionId: 'session-1', useWorkspaces }))
  })

  const sessionStore = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(sessionStore.version, 1, 'the session key keeps its original shape')
  assert.equal(sessionStore.workspaces, undefined, 'workspace data does not leak into the session key')
  const workspaceStore = JSON.parse(window.localStorage.getItem('dsh.aside-note.workspaces'))
  assert.equal(workspaceStore.version, 1)
  const shared = workspaceStore.workspaces['ws-1']
  assert.ok(shared, 'the workspace list must be created on first sight')
  assert.deepEqual(shared.items.map(item => item.text).sort(), ['会话二的事项', '会话一的事项'].sort())
  assert.deepEqual(shared.seededSessionIds.sort(), ['session-1', 'session-2'])
  assert.equal(window.localStorage.getItem('dsh.aside-note.migrated'), null,
    'the fold is recorded in the store, not with a second marker key')

  const header = document.querySelector('.dsh-an-headerBtn')
  await act(async () => { header.click() })
  const popover = document.querySelector('.dsh-an-popover')
  assert.ok(popover, 'the shared list opens from the header entry')
  const scopeButtons = () => [...popover.querySelectorAll('.dsh-an-scopeBtn')]
  assert.deepEqual(scopeButtons().map(node => node.textContent), ['工作区', '会话'])
  assert.equal(scopeButtons()[0].getAttribute('aria-pressed'), 'true',
    'the workspace list is the default scope')
  assert.match(popover.querySelector('.dsh-an-popFoot').textContent, /便笺数据仅保存在本地/)
  const inputOf = root => root.querySelector('.dsh-an-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  const typeInto = async (node, text) => {
    await act(async () => {
      setter.call(node, text)
      node.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  // The pre-workspace draft is folded under the shared workspace key on first
  // open; the per-session copies are retired so they cannot reappear later.
  const migrated = JSON.parse(window.localStorage.getItem('dsh.aside-note.drafts'))
  assert.equal(migrated.sessions['ws:ws-1'].add, '会话一的旧草稿')
  assert.equal(migrated.sessions['ws:ws-1'].edits, undefined,
    'inline edit drafts are retired instead of being carried into the composer store')
  assert.equal(migrated.sessions['session-1'], undefined, 'the legacy session draft is retired')
  assert.equal(migrated.sessions['session-2'], undefined, 'member-session copies are retired too')
  assert.equal(inputOf(popover).value, '会话一的旧草稿', 'the shared draft starts from the legacy text')

  // The header switch can drop to this session's own list without reopening.
  await act(async () => { popover.querySelector('[data-scope-mode="session"]').click() })
  assert.match(popover.querySelector('.dsh-an-popFoot').textContent, /便笺数据仅保存在本地/,
    'the footer stays the neutral storage line in either scope')
  assert.deepEqual(
    [...popover.querySelectorAll('.dsh-an-text')].map(node => node.textContent),
    ['会话一的事项'],
    'the session list holds only this session note',
  )
  assert.equal(window.localStorage.getItem('dsh.aside-note.scope-mode'), 'session')
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 40)) })
  assert.equal(header.querySelector('.dsh-an-headerCount').textContent, '1',
    'the header count follows the chosen scope')

  // Switching back restores the shared list and remembers the choice.
  await act(async () => { popover.querySelector('[data-scope-mode="workspace"]').click() })
  assert.equal(window.localStorage.getItem('dsh.aside-note.scope-mode'), 'workspace')
  assert.match(popover.querySelector('.dsh-an-popFoot').textContent, /便笺数据仅保存在本地/)
  assert.deepEqual(
    [...popover.querySelectorAll('.dsh-an-text')].map(node => node.textContent).sort(),
    ['会话二的事项', '会话一的事项'].sort(),
  )
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 40)) })
  assert.equal(header.querySelector('.dsh-an-headerCount').textContent, '2')

  // Drafts belong to the workspace, not to the tab: typing under one scope,
  // switching to the other and coming back must keep the text.
  await typeInto(inputOf(popover), '工作区草稿')
  const sharedDrafts = JSON.parse(window.localStorage.getItem('dsh.aside-note.drafts'))
  assert.equal(sharedDrafts.sessions['ws:ws-1'].add, '工作区草稿')
  assert.equal(sharedDrafts.sessions['session-1'], undefined,
    'the workspace draft never falls back to the session key')
  await act(async () => { popover.querySelector('[data-scope-mode="session"]').click() })
  assert.equal(inputOf(popover).value, '工作区草稿', 'the draft survives the scope switch')
  await act(async () => { popover.querySelector('[data-scope-mode="workspace"]').click() })
  assert.equal(inputOf(popover).value, '工作区草稿', 'and comes back with the workspace list')


  // A note added in session-1 lands in the workspace list, not the session list.
  await typeInto(inputOf(popover), '新增的共享事项')
  await act(async () => { popover.querySelector('.dsh-an-addBtn').click() })
  const afterAdd = JSON.parse(window.localStorage.getItem('dsh.aside-note.workspaces'))
  assert.equal(afterAdd.workspaces['ws-1'].items.length, 3)
  const sessionAfterAdd = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.equal(sessionAfterAdd.sessions['session-1'].items.length, 1,
    'the old per-session bucket stays as history and is not written again')
  assert.equal(JSON.parse(window.localStorage.getItem('dsh.aside-note.drafts')).sessions['ws:ws-1'], undefined,
    'submitting the shared draft consumes it')

  // Leave an unsaved draft behind before the conversation switch.
  await typeInto(inputOf(popover), '跨会话草稿')
  assert.equal(
    JSON.parse(window.localStorage.getItem('dsh.aside-note.drafts')).sessions['ws:ws-1'].add,
    '跨会话草稿',
    'the last typing lives in the workspace buffer',
  )

  await act(async () => { popover.querySelector('.dsh-an-popClose').click() })
  await act(async () => { firstRoot.unmount() })

  // Open the same workspace from session-2: it reads the same list.
  const secondHost = document.createElement('div')
  document.body.appendChild(secondHost)
  const secondRoot = ReactDOMClient.createRoot(secondHost)
  await act(async () => {
    secondRoot.render(React.createElement(capture, { sessionId: 'session-2', useWorkspaces }))
  })
  await act(async () => { document.querySelector('.dsh-an-headerBtn').click() })
  const secondPopover = document.querySelector('.dsh-an-popover')
  assert.ok(secondPopover, 'the panel opens in the second session')
  const texts = [...secondPopover.querySelectorAll('.dsh-an-text')].map(node => node.textContent).sort()
  assert.deepEqual(texts, ['会话二的事项', '会话一的事项', '新增的共享事项'].sort())

  // The draft typed in session-1 is visible from session-2 in both scopes: the
  // workspace owns the buffer, so switching conversations never strands it.
  assert.equal(inputOf(secondPopover).value, '跨会话草稿',
    'the unsaved draft stays visible after switching conversations')
  await act(async () => { secondPopover.querySelector('[data-scope-mode="session"]').click() })
  assert.equal(inputOf(secondPopover).value, '跨会话草稿',
    'the shared draft stays visible in the session scope too')
  assert.equal(window.localStorage.getItem('dsh.aside-note.scope-mode'), 'session')
  await act(async () => { secondPopover.querySelector('[data-scope-mode="workspace"]').click() })
  assert.match(secondPopover.querySelector('.dsh-an-popFoot').textContent, /便笺数据仅保存在本地/)

  // 递入对话 writes into session-2's composer only: session-1's stays empty,
  // proving the shared note follows the conversation currently on screen.
  const row = [...secondPopover.querySelectorAll('.dsh-an-row')]
    .find(node => node.querySelector('.dsh-an-text').textContent === '新增的共享事项')
  const insert = row.querySelector('.dsh-an-iconBtn[aria-label="递入对话"]')
  assert.ok(insert, 'the open note offers 递入对话')
  await act(async () => { insert.click() })
  const composers = [...window.document.querySelectorAll('[data-conversation-session]')]
  const valueOf = id => composers
    .find(node => node.getAttribute('data-conversation-session') === id)
    .querySelector('[data-composer-input]').value
  assert.equal(valueOf('session-2'), '新增的共享事项', 'the note lands in the visible composer as plain text')
  assert.equal(valueOf('session-1'), '', 'the hidden session composer is untouched')
  const workspaceItems = () => JSON.parse(window.localStorage.getItem('dsh.aside-note.workspaces')).workspaces['ws-1'].items
  assert.equal(workspaceItems().find(item => item.text === '新增的共享事项').done, true,
    'the shared note is archived for every conversation of the workspace')

  // Drag a grip: every row reports the same 24px box here, so a drop 60px
  // below the start lands the first open note at the end of the open list.
  const Pointer = window.PointerEvent || window.MouseEvent
  const pointer = (node, type, clientY) => node.dispatchEvent(new Pointer(type, {
    bubbles: true, cancelable: true, button: 0, pointerId: 1, clientY,
  }))
  const openList = () => secondPopover.querySelector('.dsh-an-listSection:first-child .dsh-an-rows')
  const openOrder = () => [...openList().querySelectorAll('.dsh-an-text')].map(node => node.textContent)
  const storedOpen = () => workspaceItems().filter(item => !item.done).map(item => item.text)
  const before = openOrder()
  assert.equal(before.length, 2)
  assert.deepEqual(storedOpen(), before)
  let grip = openList().querySelector('.dsh-an-grip')
  await act(async () => {
    pointer(grip, 'pointerdown', 0)
    pointer(grip, 'pointermove', 10)
    pointer(grip, 'pointermove', 60)
  })
  assert.equal(openList().dataset.dragging, 'true', 'the list marks the drag')
  assert.equal(grip.closest('.dsh-an-row').dataset.dragging, 'true', 'the held row lifts')
  await act(async () => { pointer(grip, 'pointerup', 60) })
  const after = [...before.slice(1), before[0]]
  assert.deepEqual(openOrder(), after, 'the drop reorders the rendered list')
  assert.deepEqual(storedOpen(), after, 'the drop is stored')
  assert.equal(openList().dataset.dragging, undefined, 'the drag mark is cleared')
  assert.equal(secondPopover.querySelector('.dsh-an-row[data-dragging]'), null)

  // Escape cancels a drag in flight without closing the panel or moving anything.
  grip = openList().querySelector('.dsh-an-grip')
  await act(async () => {
    pointer(grip, 'pointerdown', 0)
    pointer(grip, 'pointermove', 60)
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    pointer(grip, 'pointerup', 60)
  })
  assert.ok(document.querySelector('.dsh-an-popover'), 'Escape during a drag keeps the panel open')
  assert.deepEqual(storedOpen(), after, 'a cancelled drag stores nothing')
  assert.deepEqual([...openList().querySelectorAll('.dsh-an-row')].map(node => node.style.transform), ['', ''],
    'every row returns to its own slot')

  // One buffer is shared across the workspace's conversations, but the save
  // lands in the scope selected at that moment: submitted from the session
  // tab it must go into session-2's list, not the workspace list.
  const secondInput = secondPopover.querySelector('.dsh-an-input')
  await typeInto(secondInput, '第二个会话的草稿')
  const sharedAgain = JSON.parse(window.localStorage.getItem('dsh.aside-note.drafts'))
  assert.equal(sharedAgain.sessions['ws:ws-1'].add, '第二个会话的草稿',
    'session-2 types into the shared workspace draft')
  await act(async () => { secondPopover.querySelector('[data-scope-mode="session"]').click() })
  assert.equal(secondInput.value, '第二个会话的草稿', 'the draft follows the workspace across conversations')
  await act(async () => { secondPopover.querySelector('.dsh-an-addBtn').click() })
  const sessionAfterSave = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.deepEqual(
    sessionAfterSave.sessions['session-2'].items.map(item => item.text).sort(),
    ['会话二的事项', '第二个会话的草稿'].sort(),
    'the save lands in the session list',
  )
  const workspaceAfterSave = JSON.parse(window.localStorage.getItem('dsh.aside-note.workspaces'))
  assert.equal(workspaceAfterSave.workspaces['ws-1'].items.length, 3, 'the workspace list is untouched')
  assert.equal(JSON.parse(window.localStorage.getItem('dsh.aside-note.drafts')).sessions['ws:ws-1'], undefined,
    'the shared draft is consumed by the save')

  await act(async () => { secondRoot.unmount() })
  for (const dispose of disposers) dispose()
  dom.window.close()
})

test('a blank new session opens the workspace list from the header corner', async t => {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<div class="_headerCorner"><button type="button" id="host-rightbar">rightbar</button></div>' +
      '<div data-conversation-session="session-new"><textarea data-composer-input></textarea></div>' +
    '</body></html>',
    { url: 'https://example.test/', pretendToBeVisual: true, runScripts: 'outside-only' },
  )
  const { window } = dom
  t.after(() => window.close())
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24, x: 0, y: 0,
    toJSON: () => ({}),
  })
  // A note written before the workspace list existed is folded in when the
  // new session first captures the workspace.
  window.localStorage.setItem('dsh.aside-note', JSON.stringify({
    version: 1,
    sessions: {
      'session-new': { items: [{ id: 'seed-new', text: '新会话前的事项', done: false, createdAt: 1, updatedAt: 1 }] },
    },
  }))
  window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })

  const React = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const { act } = React

  let loaded = null
  window.__ModuleLoader__ = { load: spec => { loaded = spec } }
  window.eval(bundle)
  // The real host seeds the shared Tooltip; this clone keeps its label
  // inspectable without building the portal and hover machinery in jsdom.
  const Tooltip = ({ label, children }) => React.cloneElement(children, { 'data-tooltip': label })
  const moduleTable = {
    react: React,
    'react-dom': await import('react-dom'),
    'react-dom/client': ReactDOMClient,
    '@deepseek-ai/dsh-client-ui-primitives': { Tooltip },
  }
  const exported = loaded.factory(id => {
    if (!(id in moduleTable)) throw new Error(`module table cannot answer ${id}`)
    return moduleTable[id]
  })

  const disposers = []
  const registered = []
  const locale = {
    bind: () => key => key,
    register: () => {},
    getLocale: () => ({ active: 'zh' }),
  }
  const ctx = {
    get: name => (name === 'locale' ? locale : undefined),
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
  }
  await act(async () => { exported.apply(ctx) })

  const hero = registered.find(entry => entry.meta.name === 'conversation.hero.options').component
  const workspace = {
    workspaceId: 'ws-new',
    path: '/repo/new',
    title: '新会话工作区',
    sessionIds: ['session-new'],
    createdAt: '',
    updatedAt: '',
  }
  const useWorkspaces = selector => selector({
    items: [workspace], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  let sessionsSnapshot = { byId: { 'session-new': { id: 'session-new', blank: true } } }
  const sessionListeners = new Set()
  const useSessions = selector => React.useSyncExternalStore(
    callback => {
      sessionListeners.add(callback)
      return () => { sessionListeners.delete(callback) }
    },
    () => selector(sessionsSnapshot),
    () => selector(sessionsSnapshot),
  )

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  await act(async () => {
    root.render(React.createElement(hero, { sessionId: 'session-new', useWorkspaces, useSessions }))
  })

  assert.equal(host.innerHTML, '',
    'the hero seat only captures context; the visible entry stays the single header button')

  const button = document.querySelector('.dsh-an-headerBtn')
  assert.ok(button, 'the blank new session must show the notes entry')
  const corner = document.querySelector('[class*="_headerCorner"]')
  assert.equal(button.parentElement, corner, 'the entry uses the header corner when there are no utilities')
  assert.equal(corner.firstElementChild, button, 'the host right-sidebar button stays rightmost')
  assert.equal(button.dataset.anchor, 'corner')
  assert.equal(button.dataset.scope, 'workspace')
  assert.equal(button.querySelector('.dsh-an-headerCount').textContent, '1',
    'the corner entry counts the workspace notes')

  await act(async () => { button.click() })
  const popover = document.querySelector('.dsh-an-popover')
  assert.ok(popover, 'the corner entry opens the panel')
  const scopeButtons = () => [...popover.querySelectorAll('.dsh-an-scopeBtn')]
  assert.deepEqual(scopeButtons().map(node => node.textContent), ['工作区'],
    'a blank session shows the workspace option alone')
  assert.equal(scopeButtons()[0].getAttribute('aria-pressed'), 'true',
    'a blank session opens on the workspace list')
  assert.equal(scopeButtons()[0].getAttribute('data-tooltip'),
    '当前只能记到工作区，会话开始后可切换',
    'the lone workspace option explains why the session option is absent')

  const input = popover.querySelector('.dsh-an-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, '新会话里记一条')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { popover.querySelector('.dsh-an-addBtn').click() })
  const workspaceStore = JSON.parse(window.localStorage.getItem('dsh.aside-note.workspaces'))
  assert.ok(
    workspaceStore.workspaces['ws-new'].items.some(item => item.text === '新会话里记一条'),
    'a note written before the first turn lands in the workspace list',
  )

  // The first turn makes the session list meaningful. The panel stays open,
  // the header entry moves to the real utilities row and the switch wakes up.
  const utilities = document.createElement('div')
  utilities.className = '_headerUtilities'
  document.body.appendChild(utilities)
  await act(async () => {
    sessionsSnapshot = { byId: { 'session-new': { id: 'session-new', blank: false } } }
    for (const listener of [...sessionListeners]) listener()
    await new Promise(resolve => window.setTimeout(resolve, 80))
  })

  assert.ok(document.querySelector('.dsh-an-popover'), 'the open panel survives the first turn')
  assert.equal(document.querySelector('._headerUtilities > .dsh-an-headerBtn'), button,
    'the entry moves into the conversation utilities row once the session starts')
  assert.equal(button.dataset.anchor, 'utilities')
  assert.deepEqual(scopeButtons().map(node => node.textContent), ['工作区', '会话'],
    'the session option appears once the session starts')
  assert.equal(scopeButtons()[0].getAttribute('data-tooltip'), '切换到工作区清单，所有会话共享')
  assert.equal(scopeButtons()[1].getAttribute('data-tooltip'), '切换到会话清单，只属于当前会话')

  await act(async () => { popover.querySelector('[data-scope-mode="session"]').click() })
  assert.equal(scopeButtons()[1].getAttribute('aria-pressed'), 'true')
  await act(async () => {
    setter.call(input, '会话开始后的事项')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { popover.querySelector('.dsh-an-addBtn').click() })
  const sessionStore = JSON.parse(window.localStorage.getItem('dsh.aside-note'))
  assert.ok(
    sessionStore.sessions['session-new'].items.some(item => item.text === '会话开始后的事项'),
    'the session list is writable after the first turn',
  )

  await act(async () => { popover.querySelector('.dsh-an-popClose').click() })
  await act(async () => { root.unmount() })
  for (const dispose of disposers) dispose()
  dom.window.close()
})

test('handing notes to chat joins them on new lines, without a prefix or list marker', async t => {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<div class="_headerUtilities"></div>' +
      '<div data-conversation-session="session-1"><textarea data-composer-input></textarea></div>' +
    '</body></html>',
    { url: 'https://example.test/', pretendToBeVisual: true, runScripts: 'outside-only' },
  )
  const { window } = dom
  t.after(() => window.close())
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24, x: 0, y: 0,
    toJSON: () => ({}),
  })
  window.localStorage.setItem('dsh.aside-note', JSON.stringify({
    version: 1,
    sessions: {
      'session-1': {
        items: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((text, index) => ({
          id: `seed-${index}`, text, done: false, createdAt: index + 1, updatedAt: index + 1,
        })),
      },
    },
  }))
  window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })

  const React = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const { act } = React

  let loaded = null
  window.__ModuleLoader__ = { load: spec => { loaded = spec } }
  window.eval(bundle)

  const moduleTable = {
    react: React,
    'react-dom': await import('react-dom'),
    'react-dom/client': ReactDOMClient,
    '@deepseek-ai/dsh-client-ui-primitives': {},
  }
  const exported = loaded.factory(id => {
    if (!(id in moduleTable)) throw new Error(`module table cannot answer ${id}`)
    return moduleTable[id]
  })

  // A stand-in for the DSH locale service: `bind` defers to the plugin's own
  // bundle (the fallback in makeSay), while the subscription drives live switches.
  let active = 'zh'
  let revision = 0
  const listeners = new Set()
  const locale = {
    bind: () => key => key,
    register: () => {},
    getLocale: () => ({ id: active, revision }),
    getSnapshot: () => ({ active, revision }),
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setLocale: next => {
      active = next
      revision += 1
      for (const listener of [...listeners]) listener()
    },
  }

  const disposers = []
  const registered = []
  const ctx = {
    get: name => (name === 'locale' ? locale : undefined),
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
  }
  await act(async () => { exported.apply(ctx) })

  const capture = registered.find(entry => entry.meta.name === 'conversation.composer.dock').component
  const workspace = {
    workspaceId: 'ws-1',
    path: '/repo',
    title: '工作区',
    sessionIds: ['session-1'],
    createdAt: '',
    updatedAt: '',
  }
  const useWorkspaces = selector => selector({ items: [workspace], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null })

  const rootHost = document.createElement('div')
  document.body.appendChild(rootHost)
  const root = ReactDOMClient.createRoot(rootHost)
  await act(async () => {
    root.render(React.createElement(capture, { sessionId: 'session-1', useWorkspaces }))
  })
  const header = document.querySelector('.dsh-an-headerBtn')
  await act(async () => { header.click() })
  const popover = document.querySelector('.dsh-an-popover')
  assert.ok(popover, 'the notes panel must open')

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  const composer = document.querySelector('[data-composer-input]')
  const setComposer = async text => {
    await act(async () => {
      setter.call(composer, text)
      composer.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  const insert = async text => {
    const row = [...popover.querySelectorAll('.dsh-an-row')]
      .find(node => node.querySelector('.dsh-an-text')?.textContent === text)
    assert.ok(row, `missing note ${text}`)
    await act(async () => { row.querySelector('.dsh-an-insert').click() })
    return composer.value
  }

  // Each hand-over lands as plain text: no prompt, no list marker.
  assert.equal(await insert('Alpha'), 'Alpha')

  // A second note joins the existing draft on its own line.
  assert.equal(await insert('Beta'), 'Alpha\nBeta')

  // An existing message keeps its content and receives the note on a new line.
  await setComposer('已经写好的内容')
  assert.equal(await insert('Gamma'), '已经写好的内容\nGamma')

  // A draft already ending in a newline does not gain a blank line.
  await setComposer('上一行\n')
  assert.equal(await insert('Delta'), '上一行\nDelta')

  await act(async () => { popover.querySelector('.dsh-an-popClose').click() })
  await act(async () => { root.unmount() })
  for (const dispose of disposers) dispose()
  dom.window.close()
})
