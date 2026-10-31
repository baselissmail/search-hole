// SPDX-License-Identifier: Apache-2.0
// The receipt panel in a real MCP Apps host bridge (ADR-0021): card, fullscreen, token-gated
// actions, fallback commands, hostile text, axe, and light/dark screenshots.
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

const SCREENS = join(import.meta.dirname, '..', 'test-results', 'screens')

async function load(page: Page, query = '') {
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  await page.goto(`/${query}`)
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  const frame = page.frameLocator('#app')
  await expect(frame.getByRole('region', { name: 'search-hole receipt' })).toBeVisible()
  return { frame, dialogs }
}

for (const theme of ['light', 'dark'] as const) {
  test(`the card: data points, two actions, axe clean (${theme})`, async ({ page }) => {
    const { frame } = await load(page, `?theme=${theme}`)
    const card = frame.getByRole('region', { name: 'search-hole receipt' })
    await expect(card.getByText('Searches')).toBeVisible()
    await expect(card.getByText('1 built-in')).toBeVisible()
    await expect(card.getByText('Stale')).toBeVisible()
    await expect(card.getByRole('button')).toHaveCount(2)
    // The host theme wins over the OS preference (Playwright's OS is light).
    const color = await card.getByRole('heading').evaluate((h) => getComputedStyle(h).color)
    const [r = 0] = (color.match(/\d+/g) ?? []).map(Number)
    expect(theme === 'dark' ? r > 180 : r < 80, `${theme} heading color ${color}`).toBe(true)
    const results = await new AxeBuilder({ page })
      .include('#app')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
    ).toEqual([])
    await page.screenshot({ path: join(SCREENS, `card-${theme}.png`) })
  })
}

test('Block a site: fullscreen list, one-time token sent to apply_rule, model told, hostile text inert', async ({
  page,
}) => {
  const { frame, dialogs } = await load(page)
  await frame.getByRole('button', { name: 'Block a site…' }).click()
  await expect(frame.getByRole('region', { name: 'Full search-hole receipt' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { modes: string[] }).modes)).toEqual(['fullscreen'])
  await expect(frame.getByText('<img src=x onerror=alert(1)>')).toBeVisible()
  await expect(frame.getByText('<script>alert("q")</script>')).toBeVisible()
  await expect(frame.locator('img')).toHaveCount(0)
  await expect(frame.locator('a[href^="javascript:"]')).toHaveCount(0)
  await page.screenshot({ path: join(SCREENS, 'full-light.png') })

  await frame.getByRole('button', { name: 'Block w3schools.com' }).click()
  await expect(frame.getByRole('status').filter({ hasText: 'Blocked w3schools.com' })).toBeVisible()
  const calls = await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    name: 'apply_rule',
    arguments: { kind: 'block', value: 'w3schools.com', token: 'tok-w3' },
  })
  const contexts = await page.evaluate(() =>
    JSON.stringify((window as unknown as { contexts: unknown[] }).contexts),
  )
  expect(contexts).toContain('blocked: w3schools.com')

  await frame.getByRole('button', { name: 'Approve 7' }).click()
  await expect
    .poll(async () => (await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls)).length)
    .toBe(2)
  const results = await new AxeBuilder({ page })
    .include('#app')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
  ).toEqual([])
  expect(dialogs).toEqual([])
})

test('without serverTools the buttons become the command to type', async ({ page }) => {
  const { frame } = await load(page, '?tools=0')
  await frame.getByRole('button', { name: 'Full receipt' }).click()
  await expect(frame.getByText('searchhole block w3schools.com')).toBeVisible()
  await expect(frame.getByText('searchhole approve 7')).toBeVisible()
  await expect(frame.getByRole('button', { name: /^Block / })).toHaveCount(0)
})
