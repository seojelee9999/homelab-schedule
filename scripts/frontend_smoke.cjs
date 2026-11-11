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
const schedule = { id: 'schedule-1', title: '<img src=x onerror=alert(1)>', description: '서울 일정', starts_at: '2030-01-01T03:00:00Z', ends_at: '2030-01-01T04:00:00Z', remind_at: '2030-01-01T02:50:00Z', version: 1, notification_status: 'PENDING' };
let schedules = [schedule, { ...schedule, id: 'earlier', title: '아침 준비', starts_at: '2030-01-01T00:00:00Z', ends_at: '2030-01-01T01:00:00Z' }, { ...schedule, id: 'tomorrow', title: '다음 날 일정', starts_at: '2030-01-01T15:00:00Z', ends_at: '2030-01-01T16:00:00Z' }];
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
    assert.match(url.searchParams.get('from'), /^\d{4}-\d{2}-\d{2}$/);
    body = schedules.filter(s => {
      const day = new Date(new Date(s.startsAt || s.starts_at).getTime() + 9 * 3600000).toISOString().slice(0, 10);
      return day >= url.searchParams.get('from') && day < url.searchParams.get('to');
    });
  } else if (path === '/api/notifications') body = [notification];
  else if (path === '/api/csrf') body = { headerName: 'X-CSRF-TOKEN', token: 'test' };
  else if (path === '/api/schedules/day' && options.method === 'PUT') {
    assert.equal(options.headers['X-CSRF-TOKEN'], 'test');
    if (failSave) return { ok: false, status: 409 };
    const payload = JSON.parse(options.body);
    schedules = schedules.filter(item => new Date(new Date(item.startsAt || item.starts_at).getTime() + 9 * 3600000).toISOString().slice(0, 10) !== payload.date);
    for (const { id, schedule: item } of payload.items) schedules.push({ ...item, startsAt: item.startsAt + '+09:00', endsAt: item.endsAt + '+09:00',
      remindAt: new Date(new Date(item.startsAt + '+09:00').getTime() - 600000).toISOString(), id: id || 'new-' + schedules.length, version: (item.version || 0) + 1 });
    body = null;
  } else throw new Error(`Unexpected request: ${path}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
const context = vm.createContext({ document, fetch, Intl, Date: FixedDate, URL, AbortController, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('src/main/resources/static/app.js', 'utf8'), context);
const tick = () => new Promise(resolve => setImmediate(resolve));
const titles = () => $('plan-rows').all().filter(n => n.tag === 'input' && n.type !== 'checkbox');
const checks = () => $('plan-rows').all().filter(n => n.type === 'checkbox');
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
  assert.ok(list.text().includes('00:00–01:00'));
  assert.ok(!list.text().includes(schedule.title));
  await $('go-today').events.click();
  await list.all().filter(n => n.textContent === '수정')[1].events.click();
  assert.equal(titles().length, 24);
  assert.equal(titles()[12].value, schedule.title);
  await submit();
  $('plan-date').value = '2030-01-03';
  await $('plan-date').events.change();
  assert.equal(titles().length, 24);
  titles()[2].value = '집중 작업'; titles()[2].events.input();
  checks()[2].checked = true; checks()[3].checked = true; checks()[2].events.change();
  $('merge-rows').events.click();
  assert.equal(titles().length, 23);
  assert.ok($('plan-rows').text().includes('02:00–04:00'));
  assert.ok($('plan-rows').text().includes('2시간'));
  assert.equal(titles()[2].value, '집중 작업');
  // Browsing preserves an unsaved merged block and its date.
  await $('next-day').events.click(); await $('next-day').events.click();
  assert.equal($('plan-date').value, '2030-01-03');
  failSave = true; await submit();
  assert.equal(titles()[2].value, '집중 작업');
  assert.equal(titles().length, 23);
  failSave = false; await submit();
  const day = JSON.parse(calls.filter(c => c.path.endsWith('/day') && c.options.method === 'PUT').at(-1).options.body);
  assert.equal(day.items.length, 1);
  assert.equal(day.items[0].schedule.startsAt, '2030-01-03T02:00:00');
  assert.equal(day.items[0].schedule.endsAt, '2030-01-03T04:00:00');
  assert.ok(!Object.hasOwn(day.items[0].schedule, 'remindAt'));
  assert.equal($('selected-date').value, '2030-01-03');
  $('plan-rows').all().find(n => n.textContent === '나누기').events.click();
  assert.equal(titles().length, 24);
  assert.equal(titles()[2].value, '집중 작업');
  assert.equal(titles()[3].value, '집중 작업');
  await submit();
  // Month boundary + leap year, and empty-day state.
  $('selected-date').value = '2032-02-29'; await $('selected-date').events.change(); await tick();
  assert.equal($('calendar-grid').all().filter(n => n.tag === 'button').length, 29);
  assert.ok(list.text().includes('비어 있는 하루'));
  await $('next-day').events.click();
  assert.equal($('selected-date').value, '2032-03-01');
  assert.ok(calls.some(call => call.url.search.includes('from=2032-03-01')));
  console.log(`PASS ${document.baseURI}: today default, chronological day view, calendar/leap month, date navigation, hourly slots, merged ranges, splitting, atomic day payload, fixed reminders, draft preservation, error recovery, CSRF and history`);
})().catch(error => { console.error(error); process.exitCode = 1; });
