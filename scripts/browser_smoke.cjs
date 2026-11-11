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
        { id: '2', title: '프로젝트 집중 작업', description: '설계 검토와 구현', starts_at: '2030-01-01T05:00:00Z', ends_at: '2030-01-01T06:00:00Z', remind_at: '2030-01-01T04:50:00Z', version: 1, notification_status: 'PENDING' },
        { id: '1', title: '아침 계획 정리', description: '오늘 꼭 해야 할 세 가지', starts_at: '2030-01-01T00:00:00Z', ends_at: '2030-01-01T01:00:00Z', remind_at: '2030-01-01T00:20:00Z', version: 1, notification_status: 'PENDING' }
      ];
      const writes = [];
      await page.route('**/api/**', async route => {
        const req = route.request(); const url = new URL(req.url());
        let json = [];
        if (url.pathname.endsWith('/csrf')) json = { headerName: 'X-CSRF-TOKEN', token: 'test' };
        else if (req.method() === 'POST' || req.method() === 'PUT') {
          assert.equal(req.headers()['x-csrf-token'], 'test');
          const body = req.postDataJSON(); writes.push(body);
          schedules = schedules.filter(item => new Date(new Date(item.startsAt || item.starts_at).getTime() + 9 * 3600000).toISOString().slice(0, 10) !== body.date);
          for (const { id, schedule: item } of body.items) schedules.push({ ...item, id: id || String(schedules.length + 1), startsAt: item.startsAt + '+09:00', endsAt: item.endsAt + '+09:00',
            remindAt: new Date(new Date(item.startsAt + '+09:00').getTime() - 600000).toISOString(), version: (item.version || 0) + 1, notificationStatus: 'PENDING' });
          json = null;
        } else if (url.pathname.endsWith('/schedules')) {
          json = schedules.filter(item => {
            const day = new Date(new Date(item.startsAt || item.starts_at).getTime() + 9 * 3600000).toISOString().slice(0, 10);
            return day >= url.searchParams.get('from') && day < url.searchParams.get('to');
          });
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
      await page.getByRole('textbox', { name: '00:00–01:00 할 일', exact: true }).fill('자정 작업');
      assert.equal(await page.locator('#plan-rows tr').count(), 24);
      assert.equal(await page.locator('input[type=time], #reminder-offset').count(), 0);
      assert.match(await page.locator('#reminder-preview').textContent(), /23:50/);
      await page.getByRole('textbox', { name: '02:00–03:00 할 일', exact: true }).fill('집중 작업');
      await page.getByRole('checkbox', { name: '02:00–03:00 시간 선택', exact: true }).check();
      await page.getByRole('checkbox', { name: '03:00–04:00 시간 선택', exact: true }).check();
      await page.locator('#merge-rows').click();
      assert.equal(await page.locator('#plan-rows tr').count(), 23);
      assert.equal(await page.getByRole('textbox', { name: '02:00–04:00 할 일', exact: true }).inputValue(), '집중 작업');
      await page.locator('#save').click();
      await page.waitForFunction(() => document.querySelector('#message').textContent.includes('2개의 일정을 시간표에 저장'));
      assert.equal(writes[0].items[0].schedule.startsAt, '2030-01-02T00:00:00');
      assert.equal(writes[0].items[1].schedule.endsAt, '2030-01-02T04:00:00');
      assert.deepEqual(await page.locator('.schedule-card h3').allTextContents(), ['자정 작업', '집중 작업']);
      await page.getByRole('button', { name: '집중 작업 일정 수정', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: '02:00–04:00 할 일', exact: true }).inputValue(), '집중 작업');
      await page.getByRole('button', { name: '나누기', exact: true }).click();
      assert.equal(await page.locator('#plan-rows tr').count(), 24);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `hour blocks overflow at ${width}`);
      // Keyboard tab navigation covers all three views.
      await page.locator('#schedule-tab').focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#calendar-panel').isVisible(), true);
      await page.keyboard.press('End'); assert.equal(await page.locator('#history-panel').isVisible(), true);
      assert.deepEqual(errors, []);
      console.log(`PASS browser ${width}px: Seoul date in LA timezone, daily order, month selection, hour blocks, merging, splitting, day save, midnight reminder, edit, keyboard tabs, no horizontal overflow`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
