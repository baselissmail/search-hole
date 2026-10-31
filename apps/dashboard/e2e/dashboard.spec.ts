// SPDX-License-Identifier: Apache-2.0
// P4 acceptance against the real server: sign-in, hostile text, axe on every page in both themes,
// the keyboard path, the live tail, and no CSP violations. P6: the Lists view, offline.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { loginCode } from './env.ts'

const SCREENS = join(import.meta.dirname, '..', 'test-results', 'screens')

/** Records CSP violations and console errors from the first script on. */
async function watch(page: Page): Promise<{ csp: string[]; errors: string[]; dialogs: string[] }> {
  const seen = { csp: [] as string[], errors: [] as string[], dialogs: [] as string[] }
  await page.exposeFunction('__reportCsp', (v: string) => seen.csp.push(v))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      ;(window as unknown as { __reportCsp: (v: string) => void }).__reportCsp(
        `${e.violatedDirective} ${e.blockedURI}`,
      )
    })
  })
  page.on('console', (m) => {
    if (m.type() === 'error') seen.errors.push(m.text())
  })
  page.on('dialog', (d) => {
    seen.dialogs.push(d.message())
    void d.dismiss()
  })
  return seen
}

async function signIn(page: Page, path = '/'): Promise<void> {
  await page.goto(`${path}#c=${await loginCode()}`)
  await expect(page.getByRole('main')).toBeVisible()
}

test('signs in with a one-time code, drops it from the URL, and refuses a reused code', async ({
  page,
  browser,
}) => {
  const seen = await watch(page)
  const code = await loginCode()
  await page.goto(`/#c=${code}`)
  await expect(page.getByRole('table', { name: 'Search log' })).toBeVisible()
  expect(new URL(page.url()).hash).toBe('')
  await expect(page.getByRole('button', { name: 'react compiler' })).toBeVisible()

  const other = await browser.newPage()
  await other.goto(`/#c=${code}`)
  await expect(other.getByText('searchhole ui --open').first()).toBeVisible()
  await other.close()
  expect(seen.csp).toEqual([])
})

test('hostile web text renders as text: no script runs, javascript: URLs are not links', async ({ page }) => {
  const seen = await watch(page)
  await signIn(page)
  await page.getByRole('button', { name: 'hostile query' }).click()
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible()
  await expect(page.getByText('كيف أستخدم React')).toBeVisible()
  expect(await page.locator('img[src="x"]').count()).toBe(0)
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0)
  expect(await page.locator('script:not([src])').count()).toBe(0)
  await page.waitForTimeout(300)
  expect(seen.dialogs).toEqual([])
  expect(seen.csp).toEqual([])
})

async function expectNoSeriousAxeIssues(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(
    bad.map((v) => `${v.id}: ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`),
    label,
  ).toEqual([])
}

for (const theme of ['light', 'dark'] as const) {
  test(`axe finds no serious or critical issue on any page (${theme})`, async ({ page }) => {
    const seen = await watch(page)
    await page.emulateMedia({ colorScheme: theme })
    await signIn(page)
    await page.getByRole('button', { name: 'react compiler' }).click()
    const pages = [
      ['log', 'Live log', page.getByRole('table', { name: 'Search log' })],
      ['rules', 'Rules & lists', page.getByRole('table', { name: 'Your rules' })],
      ['engines', 'Engines', page.getByRole('region', { name: 'Engines' })],
      ['settings', 'Settings', page.getByLabel('Searches per turn')],
    ] as const
    for (const [name, link, ready] of pages) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link }).click()
      await expect(ready).toBeVisible()
      await page.waitForTimeout(250) // let queries settle (the live stream keeps the network busy)
      await expectNoSeriousAxeIssues(page, `${name} ${theme}`)
      await page.screenshot({ path: join(SCREENS, `${name}-${theme}.png`) })
    }

    // Lists: the view (one row expanded, the error row showing), then the catalog dialog.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Rules & lists' }).click()
    await page
      .getByRole('navigation', { name: 'Rules and lists' })
      .getByRole('link', { name: 'Lists' })
      .click()
    const lists = page.getByRole('table', { name: 'Your lists' })
    await expect(lists).toBeVisible()
    await lists.getByRole('button', { name: 'uBlacklist Stack Overflow Translation', exact: true }).click()
    await expect(lists.getByText('Rules in force')).toBeVisible()
    await page.waitForTimeout(250)
    await expectNoSeriousAxeIssues(page, `lists ${theme}`)
    // Tall enough for every row: the import, the refused subscription and its error.
    await page.setViewportSize({ width: 1360, height: 1900 })
    await page.screenshot({ path: join(SCREENS, `lists-${theme}.png`) })
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.getByRole('button', { name: 'Browse catalog' }).click()
    const catalog = page.getByRole('dialog', { name: 'List catalog' })
    await expect(catalog.getByRole('list', { name: 'Catalog lists' })).toBeVisible()
    await expect(page).toHaveURL(/catalog=/)
    await page.waitForTimeout(250)
    await expectNoSeriousAxeIssues(page, `list catalog ${theme}`)
    await page.screenshot({ path: join(SCREENS, `lists-catalog-${theme}.png`) })
    await page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)

    expect(seen.csp).toEqual([])
    expect(seen.errors).toEqual([])
  })
}

test('keyboard: move, expand, block a site with Undo, palette, shortcuts', async ({ page }) => {
  await signIn(page)
  const log = page.getByRole('table', { name: 'Search log' })
  await expect(log).toBeVisible()
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('j')
  await page.keyboard.press('Enter')
  await expect(log.locator('button[aria-expanded="true"]')).toHaveCount(1)

  // Block a result's site from the expanded row, then Undo.
  const block = page.getByRole('button', { name: /^Block / }).first()
  const site = ((await block.getAttribute('aria-label')) ?? (await block.textContent()) ?? '').replace(
    /^Block /,
    '',
  )
  await block.click()
  const undo = page.getByRole('button', { name: 'Undo' })
  await expect(undo).toBeVisible()
  const rulesAfterBlock = await (await page.request.get('/api/rules', { headers: await auth(page) })).json()
  expect(JSON.stringify(rulesAfterBlock)).toContain(site)
  await undo.click()
  await expect
    .poll(async () =>
      JSON.stringify(await (await page.request.get('/api/rules', { headers: await auth(page) })).json()),
    )
    .not.toContain(`"match":"${site}"`)

  // Command palette, then the shortcuts sheet.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await expect(page.getByPlaceholder('Go to a page or run a command…')).toBeFocused()
  await page.keyboard.type('rules')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/rules/)
  await expect(page.getByRole('table', { name: 'Your rules' })).toBeVisible()
  // `?` is ignored while a dialog is open, and the menu takes 150 ms to close.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Shift+?')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a theme chosen in the dashboard wins over the OS preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('search-hole.theme', 'dark'))
  await signIn(page)
  const color = await page.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)
  const [r = 255] = (color.match(/\d+/g) ?? []).map(Number)
  expect(r, `body background ${color}`).toBeLessThan(60)
})

test('a suggestion can be approved from the Rules page', async ({ page }) => {
  await signIn(page, '/rules')
  await page.getByRole('button', { name: /Approve the suggestion for w3schools\.com/ }).click()
  await expect(page.getByRole('table', { name: 'Your rules' }).getByText('w3schools.com')).toBeVisible()
})

test('live tail: a new search appears without a reload', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: 'react compiler' })).toBeVisible()
  const seed = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, 'seed.ts'), 'add', 'streamed in live'],
    {
      env: { ...process.env, SEARCHHOLE_HOME: process.env.E2E_HOME, SEARCHHOLE_LOG: 'silent' },
      encoding: 'utf8',
    },
  )
  expect(seed.status, seed.stderr).toBe(0)
  await expect(page.getByRole('button', { name: 'streamed in live' })).toBeVisible({ timeout: 5_000 })
})

interface ListRow {
  id: string
  name: string
  mode: string
  source: string
  copy: string
  lastError: { code: string } | null
  contribution: { hidden7d: number; wouldHide7d: number }
}

async function listsNow(page: Page): Promise<ListRow[]> {
  return (await (await page.request.get('/api/lists', { headers: await auth(page) })).json()) as ListRow[]
}

const PINTEREST = 'ublacklist-pinterest (basic)'
const HUGE_AI = 'uBlockOrigin & uBlacklist Huge AI Blocklist (uBlacklist format)'

test('lists: the starter lists work offline, each with its mode, source and week', async ({ page }) => {
  const seen = await watch(page)
  await signIn(page, '/rules/lists')
  const table = page.getByRole('table', { name: 'Your lists' })
  await expect(table).toBeVisible()
  const pressed = (name: string) =>
    table.getByRole('group', { name: `Mode of ${name}` }).locator('[aria-pressed="true"]')

  // The ADR-0017 starter set, from the shipped copies: four enforced, the AI list in audit.
  for (const name of [
    'uBlock-Origin-dev-filter (dev: Stack Overflow, GitHub, npm copycats)',
    'uBlacklist Stack Overflow Translation',
    'uBlacklist GitHub Translation',
    PINTEREST,
  ]) {
    await expect(pressed(name)).toHaveText('Enforce')
  }
  await expect(pressed(HUGE_AI)).toHaveText('Audit')
  const row = (name: string) =>
    table.locator('tbody').filter({ has: page.getByRole('button', { name, exact: true }) })
  await expect(row(PINTEREST).getByText('Starter', { exact: true })).toBeVisible()
  await expect(row(PINTEREST).getByText(/^Shipped copy,/)).toBeVisible()
  await expect(row('search-hole github-clones').getByText('Built-in', { exact: true })).toBeVisible()

  // The seeded searches: what a list hid, and what the audit list would have hidden.
  await expect(row('uBlacklist Stack Overflow Translation').getByText('Hid 1 result this week')).toBeVisible()
  await expect(row(HUGE_AI).getByText('Would hide 1 result this week')).toBeVisible()

  // The import (one skipped line) and the refused subscription with its error and fix.
  await expect(row('team-blocklist').getByText('Imported', { exact: true })).toBeVisible()
  await expect(row('team-blocklist').getByText('1 skipped')).toBeVisible()
  const refused = row('private-address')
  await expect(refused.getByText('Blocked address')).toBeVisible()
  await expect(refused.getByText(/private or local network/)).toBeVisible()
  await expect(refused.getByText('Not downloaded yet')).toBeVisible()
  await expect(page.getByText('1 list needs attention:')).toBeVisible()

  // Every row explains itself: the details say where the list comes from.
  await row(PINTEREST).getByRole('button', { name: PINTEREST, exact: true }).click()
  await expect(row(PINTEREST).getByText(/ships with search-hole so it works offline/)).toBeVisible()
  expect(seen.csp).toEqual([])
  expect(seen.errors).toEqual([])
})

test('lists: switch a list to Audit from the keyboard, then Undo', async ({ page }) => {
  await signIn(page, '/rules/lists')
  const group = page.getByRole('group', { name: `Mode of ${PINTEREST}` })
  const mode = async () => (await listsNow(page)).find((l) => l.id === 'rjaus-pinterest')?.mode
  expect(await mode()).toBe('enforce')

  await group.getByRole('button', { name: 'Enforce' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(group.getByRole('button', { name: 'Audit' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(group.getByRole('button', { name: 'Audit' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(mode).toBe('audit')

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(mode).toBe('enforce')
  await expect(group.getByRole('button', { name: 'Enforce' })).toHaveAttribute('aria-pressed', 'true')
})

test('lists: removing an import waits for its Undo window, and Undo keeps it', async ({ page }) => {
  await signIn(page, '/rules/lists')
  const table = page.getByRole('table', { name: 'Your lists' })
  await table.getByRole('button', { name: 'Remove team-blocklist' }).click()
  const name = table.getByRole('button', { name: 'team-blocklist', exact: true })
  await expect(name).toHaveCount(0)
  expect((await listsNow(page)).some((l) => l.id === 'team-blocklist')).toBe(true)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(name).toBeVisible()
  await page.waitForTimeout(500)
  expect((await listsNow(page)).some((l) => l.id === 'team-blocklist')).toBe(true)
})

test('command menu: Browse list catalog opens it from anywhere', async ({ page }) => {
  await signIn(page)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.keyboard.type('list catalog')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/rules\/lists\?catalog=/)
  const catalog = page.getByRole('dialog', { name: 'List catalog' })
  await expect(catalog.getByRole('heading', { name: 'Super SEO Spam Suppressor' })).toBeVisible()
  await expect(catalog.getByText(/Adding one downloads it from its address/)).toBeVisible()
})

async function auth(page: Page): Promise<Record<string, string>> {
  const token = await page.evaluate(() => sessionStorage.getItem('search-hole.token'))
  return { authorization: `Bearer ${token ?? ''}` }
}
