#!/usr/bin/env node
'use strict';
// Real app.js + API fixtures; browser interaction is verified separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.value = ''; this.textContent = ''; this.hidden = false; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(type, callback) { this.events[type] = callback; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return ![...nodes.values()].flatMap(node => node.all()).some(node => node.validationMessage); }
  reset() {}
  focus() {}
  scrollIntoView() {}
  text() { return [this.textContent, ...this.children.map(child => child.text())].join('\n'); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
const nodes = new Map();
const document = {
  baseURI: process.env.SMOKE_BASE_URL || 'https://akibaha.shop/plan/',
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
  createElement(tag) { return new Element(tag); }
};
const $ = document.getElementById;
for (const tab of ['schedule', 'calendar', 'history']) $(`${tab}-tab`).setAttribute('aria-controls', `${tab}-panel`);
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2030-01-01T00:00:00Z'])); }
  static now() { return new Date('2030-01-01T00:00:00Z').getTime(); }
}
const schedule = { id: 'schedule-1', title: '<img src=x onerror=alert(1)>', description: '서울 일정', starts_at: '2030-01-01T03:00:00Z', remind_at: '2030-01-01T02:00:00Z', version: 1, notification_status: 'PENDING' };
let schedules = [schedule, { ...schedule, id: 'earlier', title: '아침 준비', starts_at: '2030-01-01T00:30:00Z' }, { ...schedule, id: 'tomorrow', title: '다음 날 일정', starts_at: '2030-01-01T15:30:00Z' }];
const notification = { id: 'notification-1', schedule_id: 'deleted-schedule', title: '삭제된 일정의 과거 이력', due_at: '2030-01-01T02:00:00Z', status: 'SENT', attempts: [
  { id: 'attempt-1', status: 'RATE_LIMITED', started_at: '2030-01-01T02:00:00Z', finished_at: '2030-01-01T02:00:01Z', http_status: 429 },
  { id: 'attempt-2', status: 'SENT', started_at: '2030-01-01T02:00:05Z', finished_at: '2030-01-01T02:00:06Z', http_status: 200, message_id: '123456789' }
] };
const calls = [];
let failSave = false;
async function fetch(url, options) {
  assert.equal(url.origin, new URL(document.baseURI).origin);
  const prefix = new URL(document.baseURI).pathname;
  assert.ok(url.pathname.startsWith(prefix + 'api/'), `API escaped prefix: ${url}`);
  const path = '/' + url.pathname.slice(prefix.length);
  calls.push({ path, url, options });
  let body;
  if (path === '/api/schedules') {
    assert.match(url.searchParams.get('from'), /^\d{4}-\d{2}-01$/);
    body = schedules.filter(s => {
      const day = new Date(new Date(s.startsAt || s.starts_at).getTime() + 9 * 3600000).toISOString().slice(0, 10);
      return day >= url.searchParams.get('from') && day < url.searchParams.get('to');
    });
  } else if (path === '/api/notifications') body = [notification];
  else if (path === '/api/csrf') body = { headerName: 'X-CSRF-TOKEN', token: 'test' };
  else if (path === '/api/schedules/batch' || options.method === 'PUT') {
    assert.equal(options.headers['X-CSRF-TOKEN'], 'test');
    if (failSave) return { ok: false, status: 409 };
    const payload = JSON.parse(options.body);
    for (const item of payload.items || [payload]) schedules.push({ ...item, startsAt: item.startsAt + '+09:00', remindAt: item.remindAt + '+09:00', id: 'new-' + schedules.length });
    body = { ids: ['new'] };
  } else throw new Error(`Unexpected request: ${path}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
const context = vm.createContext({ document, fetch, Intl, Date: FixedDate, URL, AbortController, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('src/main/resources/static/app.js', 'utf8'), context);
const tick = () => new Promise(resolve => setImmediate(resolve));
const inputs = () => $('plan-rows').all().filter(n => n.tag === 'input');
const submit = () => $('schedule-form').events.submit({ preventDefault() {} });
(async () => {
  await tick();
  assert.equal($('selected-date').value, '2030-01-01');
  assert.equal($('plan-date').value, '2030-01-01');
  const list = $('schedule-list');
  assert.ok(list.text().indexOf('아침 준비') < list.text().indexOf(schedule.title));
  assert.ok(list.text().includes('12:00'));
  assert.ok(!list.text().includes('다음 날 일정'));
  assert.ok(!list.all().some(node => Object.hasOwn(node, 'innerHTML')));
  const history = $('history-list').text();
  assert.ok(history.includes('알림 ID · notification-1'));
  assert.ok(history.includes('Discord 메시지 ID · 123456789'));
  assert.ok(history.includes('전송 제한으로 대기 (RATE_LIMITED)'));
  assert.match(history, /알림 예약 · .*11:00/);
  $('calendar-tab').events.click();
  assert.equal($('calendar-panel').hidden, false);
  assert.equal($('calendar-grid').children.length, 35);
  assert.equal($('calendar-grid').all().filter(n => n.tag === 'button').length, 31);
  const jan2 = $('calendar-grid').all().find(n => n.attributes['aria-label']?.includes('1월 2일'));
  await jan2.events.click();
  assert.equal($('selected-date').value, '2030-01-02');
  assert.equal($('schedule-panel').hidden, false);
  assert.ok(list.text().includes('00:30'));
  assert.ok(!list.text().includes(schedule.title));
  $('go-today').events.click();
  await list.all().filter(n => n.textContent === '수정')[1].events.click();
  assert.equal(inputs()[0].value, '12:00');
  assert.equal(inputs()[1].value, schedule.title);
  assert.equal($('reminder-offset').value, '60');
  assert.ok($('reminder-preview').textContent.includes('11:00'));
  // Save edit, then build a two-row overnight-reminder table.
  await submit();
  $('plan-date').value = '2030-01-02';
  $('plan-date').events.input();
  inputs()[0].value = '00:30'; inputs()[1].value = '자정 일정';
  $('reminder-offset').value = '60'; $('reminder-offset').events.input();
  $('add-row').events.click();
  inputs()[3].value = '두 번째 일정';
  // Browsing must preserve an unsaved table and its date.
  await $('next-day').events.click();
  await $('next-day').events.click();
  assert.equal($('plan-date').value, '2030-01-02');
  assert.equal(inputs()[1].value, '자정 일정');
  failSave = true;
  await submit();
  assert.equal(inputs()[1].value, '자정 일정');
  assert.equal(inputs().length, 4);
  failSave = false;
  await submit();
  const batch = JSON.parse(calls.filter(c => c.path.endsWith('/batch')).at(-1).options.body);
  assert.equal(batch.items.length, 2);
  assert.equal(batch.items[0].startsAt, '2030-01-02T00:30:00');
  assert.equal(batch.items[0].remindAt, '2030-01-01T23:30:00');
  assert.equal($('selected-date').value, '2030-01-02');
  // Month boundary + leap year, and empty-day state.
  $('selected-date').value = '2032-02-29'; await $('selected-date').events.change(); await tick();
  assert.equal($('calendar-grid').all().filter(n => n.tag === 'button').length, 29);
  assert.ok(list.text().includes('비어 있는 하루'));
  await $('next-day').events.click();
  assert.equal($('selected-date').value, '2032-03-01');
  assert.ok(calls.at(-2).url.search.includes('from=2032-03-01'));
  console.log(`PASS ${document.baseURI}: today default, chronological day view, calendar/leap month, date navigation, editing, atomic batch payload, midnight reminder, draft preservation, error recovery, CSRF and history`);
})().catch(error => { console.error(error); process.exitCode = 1; });
