#!/usr/bin/env node
'use strict';
// Requires Playwright in NODE_PATH and its Chromium runtime. Uses a local HTTP fixture, never Discord.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve('src/main/resources/static');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = { '/plan/': 'index.html', '/plan/app.js': 'app.js', '/plan/style.css': 'style.css' }[pathname];
  if (!file) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(path.join(root, file)));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'America/Los_Angeles' });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
      let schedules = [
        { id: '2', title: '프로젝트 집중 작업', description: '설계 검토와 구현', starts_at: '2030-01-01T05:00:00Z', remind_at: '2030-01-01T04:50:00Z', version: 1, notification_status: 'PENDING' },
        { id: '1', title: '아침 계획 정리', description: '오늘 꼭 해야 할 세 가지', starts_at: '2030-01-01T00:30:00Z', remind_at: '2030-01-01T00:20:00Z', version: 1, notification_status: 'PENDING' }
      ];
      const writes = [];
      await page.route('**/api/**', async route => {
        const req = route.request(); const url = new URL(req.url());
        let json = [];
        if (url.pathname.endsWith('/csrf')) json = { headerName: 'X-CSRF-TOKEN', token: 'test' };
        else if (req.method() === 'POST' || req.method() === 'PUT') {
          assert.equal(req.headers()['x-csrf-token'], 'test');
          const body = req.postDataJSON(); writes.push(body);
          for (const item of body.items || [body]) schedules.push({ ...item, id: String(schedules.length + 1), startsAt: item.startsAt + '+09:00', remindAt: item.remindAt + '+09:00', notificationStatus: 'PENDING' });
          json = { ids: ['3', '4'] };
        } else if (url.pathname.endsWith('/schedules')) {
          json = schedules.filter(s => (s.startsAt || s.starts_at).startsWith(url.searchParams.get('from').slice(0, 7)));
        }
        await route.fulfill({ json });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/plan/`);
      await page.waitForFunction(() => document.querySelector('#refresh').disabled === false);
      assert.equal(await page.locator('#selected-date').inputValue(), '2030-01-01');
      assert.deepEqual(await page.locator('.schedule-card h3').allTextContents(), ['아침 계획 정리', '프로젝트 집중 작업']);
      assert.equal(await page.locator('#schedule-panel').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
      if (process.env.QA_SCREENSHOTS) await page.screenshot({ path: `${process.env.QA_SCREENSHOTS}/day-${width}.png`, fullPage: true });
      await page.getByRole('tab', { name: '월간 달력' }).click();
      assert.equal(await page.locator('.calendar-day').count(), 31);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.QA_SCREENSHOTS) await page.screenshot({ path: `${process.env.QA_SCREENSHOTS}/calendar-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: '1월 2일 (수), 일정 0개', exact: true }).click();
      assert.equal(await page.locator('#selected-date').inputValue(), '2030-01-02');
      assert.ok((await page.locator('#schedule-list').textContent()).includes('비어 있는 하루'));
      await page.getByRole('button', { name: '＋ 이날 일정 작성', exact: true }).click();
      await page.getByRole('textbox', { name: '할 일', exact: true }).fill('자정 작업');
      await page.getByLabel('일정 시작 시간', { exact: true }).fill('00:30');
      await page.locator('#reminder-offset').selectOption('60');
      assert.match(await page.locator('#reminder-preview').textContent(), /23:30/);
      await page.getByRole('button', { name: '＋ 시간 추가', exact: true }).click();
      await page.getByRole('textbox', { name: '할 일', exact: true }).nth(1).fill('오전 회의');
      await page.getByLabel('일정 시작 시간', { exact: true }).nth(1).fill('09:00');
      await page.locator('#save').click();
      await page.waitForFunction(() => document.querySelector('#message').textContent.includes('2개의 일정을 시간표에 저장'));
      assert.equal(writes[0].items[0].remindAt, '2030-01-01T23:30:00');
      assert.deepEqual(await page.locator('.schedule-card h3').allTextContents(), ['자정 작업', '오전 회의']);
      await page.getByRole('button', { name: '자정 작업 일정 수정', exact: true }).click();
      assert.equal(await page.getByLabel('일정 시작 시간', { exact: true }).inputValue(), '00:30');
      assert.equal(await page.locator('#reminder-offset').inputValue(), '60');
      // Keyboard tab navigation covers all three views.
      await page.locator('#schedule-tab').focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#calendar-panel').isVisible(), true);
      await page.keyboard.press('End'); assert.equal(await page.locator('#history-panel').isVisible(), true);
      assert.deepEqual(errors, []);
      console.log(`PASS browser ${width}px: Seoul date in LA timezone, daily order, month selection, batch save, midnight reminder, edit, keyboard tabs, no horizontal overflow`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
