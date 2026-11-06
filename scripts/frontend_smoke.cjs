#!/usr/bin/env node
'use strict';

// Exercise the real app.js with API-shaped fixtures. This is not a browser/E2E test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.attributes = {};
    this.events = {};
    this.value = '';
    this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(type, callback) { this.events[type] = callback; }
  focus() {}
  scrollIntoView() {}
  text() { return [this.textContent, ...this.children.map(child => child.text())].join('\n'); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

const nodes = new Map();
const document = {
  baseURI: process.env.SMOKE_BASE_URL || 'https://akibaha.shop/plan/',
  getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  },
  createElement() { return new Element(); }
};
document.getElementById('period').value = 'all';
const schedule = {
  id: 'schedule-1', title: '<img src=x onerror=alert(1)>', description: '서울 일정',
  starts_at: '2030-01-01T03:00:00Z', remind_at: '2030-01-01T02:00:00Z', version: 1,
  notification_status: 'PENDING'
};
const notification = {
  id: 'notification-1', schedule_id: 'deleted-schedule', title: '삭제된 일정의 과거 이력',
  due_at: '2030-01-01T02:00:00Z', status: 'SENT', attempt_count: 2,
  attempts: [
    { id: 'attempt-1', status: 'RATE_LIMITED', started_at: '2030-01-01T02:00:00Z', finished_at: '2030-01-01T02:00:01Z', http_status: 429 },
    { id: 'attempt-2', status: 'SENT', started_at: '2030-01-01T02:00:05Z', finished_at: '2030-01-01T02:00:06Z', http_status: 200, message_id: '123456789' }
  ]
};
const calls = [];
async function fetch(url) {
  assert.equal(url.origin, new URL(document.baseURI).origin);
  const prefix = new URL(document.baseURI).pathname;
  assert.ok(url.pathname.startsWith(prefix + 'api/'), `API escaped the app prefix: ${url}`);
  const path = '/' + url.pathname.slice(prefix.length);
  calls.push(path);
  const body = path === '/api/schedules' ? [schedule] : path === '/api/notifications' ? [notification] : null;
  assert.ok(body, `Unexpected API request: ${path}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
const context = vm.createContext({ document, fetch, Intl, Date, URL, AbortController, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('src/main/resources/static/app.js', 'utf8'), context);

setImmediate(() => {
  assert.deepEqual(calls.sort(), ['/api/notifications', '/api/schedules']);
  const history = nodes.get('history-list').text();
  assert.ok(history.includes('알림 ID · notification-1'));
  assert.ok(history.includes('Discord 메시지 ID · 123456789'));
  assert.ok(history.includes('전송 제한으로 대기 (RATE_LIMITED)'));
  assert.ok(!history.includes('시각 정보 없음'), history);
  assert.match(history, /알림 예약 · .*11:00/);
  const list = nodes.get('schedule-list');
  assert.ok(list.text().includes(schedule.title));
  assert.ok(!list.all().some(node => Object.hasOwn(node, 'innerHTML')));
  list.all().find(node => node.textContent === '수정').events.click();
  assert.equal(nodes.get('startsAt').value, '2030-01-01T12:00');
  assert.equal(nodes.get('remindAt').value, '2030-01-01T11:00');
  assert.equal(nodes.get('title').value, schedule.title);
  console.log(`PASS: ${document.baseURI} API prefix, Seoul edit times, detached history due_at, nested message ID, rate-limit label and text-only titles`);
});
