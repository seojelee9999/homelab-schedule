'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const apiBase = new URL('./', document.baseURI);
  const state = { schedules: [], notifications: [], editing: null, csrf: null, busy: false, schedulesReady: false, notificationsReady: false, selectedDate: '', month: '', loadedMonth: '', draftRows: [], dirty: false };
  const labels = { PENDING: '알림 대기', SENDING: '발송 중', SENT: '발송 완료', FAILED: '발송 실패', UNKNOWN: '결과 확인 필요', CANCELLED: '취소됨', CANCELED: '취소됨', DISABLED: '알림 없음', RESOLVED: '확인 완료', RATE_LIMITED: '전송 제한으로 대기' };
  const dateFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });
  const timeFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const localFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const value = (row, camel, snake) => row[camel] ?? row[snake];
  const normalize = (row) => ({ ...row, startsAt: value(row, 'startsAt', 'starts_at'), remindAt: value(row, 'remindAt', 'remind_at'), scheduleId: value(row, 'scheduleId', 'schedule_id'), createdAt: value(row, 'createdAt', 'created_at'), sentAt: value(row, 'sentAt', 'sent_at'), notificationStatus: value(row, 'notificationStatus', 'notification_status'), scheduleTitle: value(row, 'scheduleTitle', 'schedule_title') });
  function instant(raw) {
    if (!raw) return new Date(NaN);
    const text = String(raw).replace(' ', 'T');
    return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+09:00`);
  }
  function localInput(raw) {
    if (!raw) return '';
    const date = instant(raw);
    return Number.isNaN(date.getTime()) ? '' : localFormatter.format(date).replace(' ', 'T');
  }
  function format(raw) {
    const date = instant(raw);
    return Number.isNaN(date.getTime()) ? '시각 정보 없음' : timeFormatter.format(date);
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function announce(text, error = false) {
    $('message').textContent = text;
    $('message').className = error ? 'message error' : 'message';
    $('message').setAttribute('role', error ? 'alert' : 'status');
    $('message').hidden = false;
  }
  function errorMessage(error) {
    if (error.status === 409) return '다른 작업으로 정보가 변경되었거나 현재 알림 상태에서는 처리할 수 없습니다. 최신 목록을 확인한 뒤 다시 시도해 주세요. 입력 내용은 유지됩니다.';
    if (error.status === 400 || error.status === 422) return '입력값을 확인해 주세요. 제목과 서울 기준 일정·알림 시각이 올바른지 확인하세요.';
    if (error.status === 401 || error.status === 403) return '접근 권한 또는 보안 세션을 확인할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.';
    if (error.status === 404) return '해당 항목이 더 이상 존재하지 않습니다. 목록을 새로고침해 주세요.';
    return '서버 응답을 확인하지 못했습니다. 변경이 반영되었을 수 있으니, 다시 시도하기 전에 목록을 새로고침해 확인해 주세요.';
  }
  async function request(path, options = {}) {
    const headers = { Accept: 'application/json' };
    const mutation = options.method && options.method !== 'GET';
    if (mutation) {
      if (!state.csrf) {
        state.csrf = await request('/api/csrf');
      }
      if (!state.csrf?.headerName || !state.csrf?.token) throw new Error('CSRF unavailable');
      headers[state.csrf.headerName] = state.csrf.token;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(new URL(path.replace(/^\/+/, ''), apiBase), { ...options, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      if (!response.ok) {
        if (response.status === 403) state.csrf = null;
        const error = new Error('Request failed');
        error.status = response.status;
        throw error;
      }
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }
  function rows(data) {
    const list = Array.isArray(data) ? data : data?.content ?? data?.items;
    if (!Array.isArray(list)) throw new Error('Unexpected list');
    return list.map(normalize);
  }
  function notificationRows(data) {
    const groups = new Map();
    for (const row of rows(data)) {
      const id = row.notificationId ?? row.notification_id ?? row.id;
      const key = String(id);
      if (!groups.has(key)) groups.set(key, { ...row, id, attempts: [], attemptKeys: new Set() });
      const notification = groups.get(key);
      const messageId = row.messageId ?? row.message_id ?? row.discordMessageId ?? row.discord_message_id;
      if (messageId) notification.messageId = messageId;
      const nested = Array.isArray(row.attempts) ? row.attempts : null;
      const flatId = row.attemptId ?? row.attempt_id;
      const flatStatus = row.attemptStatus ?? row.attempt_status ?? row.attemptOutcome ?? row.attempt_outcome;
      const sources = nested || (flatId != null || flatStatus != null ? [{
        id: flatId, status: flatStatus,
        startedAt: row.attemptStartedAt ?? row.attempt_started_at ?? row.attemptedAt ?? row.attempted_at ?? row.started_at,
        completedAt: row.attemptCompletedAt ?? row.attempt_completed_at ?? row.attemptFinishedAt ?? row.attempt_finished_at ?? row.completed_at ?? row.finished_at,
        httpStatus: row.httpStatus ?? row.http_status ?? row.httpCode ?? row.http_code,
        messageId
      }] : []);
      for (const attempt of sources) {
        const item = {
          id: attempt.id ?? attempt.attemptId ?? attempt.attempt_id,
          status: attempt.status ?? attempt.outcome ?? attempt.attempt_status,
          startedAt: attempt.startedAt ?? attempt.started_at ?? attempt.attemptedAt ?? attempt.attempted_at ?? attempt.createdAt ?? attempt.created_at,
          completedAt: attempt.completedAt ?? attempt.completed_at ?? attempt.finishedAt ?? attempt.finished_at,
          httpStatus: attempt.httpStatus ?? attempt.http_status ?? attempt.httpCode ?? attempt.http_code,
          messageId: attempt.messageId ?? attempt.message_id ?? attempt.discordMessageId ?? attempt.discord_message_id
        };
        const attemptKey = item.id == null ? JSON.stringify(item) : String(item.id);
        if (!notification.attemptKeys.has(attemptKey)) {
          notification.attemptKeys.add(attemptKey);
          notification.attempts.push(item);
        }
      }
    }
    return [...groups.values()].map((notification) => {
      delete notification.attemptKeys;
      notification.attempts.sort((a, b) => instant(a.startedAt) - instant(b.startedAt));
      const sent = notification.attempts.filter((attempt) => attempt.messageId).at(-1);
      if (sent) {
        notification.messageId = sent.messageId;
        notification.sentAt = sent.completedAt;
      }
      return notification;
    });
  }
  function statusOf(row) {
    return String(row.notificationStatus ?? row.status ?? 'PENDING').toUpperCase();
  }
  function badge(status) {
    const tone = status === 'UNKNOWN' ? ' warning' : status === 'FAILED' ? ' danger' : ['SENDING', 'CANCELLED', 'CANCELED', 'DISABLED'].includes(status) ? ' neutral' : '';
    return element('span', `badge${tone}`, labels[status] ?? '상태 확인 필요');
  }
  function button(label, className, action, disabled = false) {
    const node = element('button', className, label);
    node.type = 'button';
    node.disabled = state.busy || disabled;
    node.addEventListener('click', action);
    return node;
  }
  function empty(target, title, detail, symbol = '▦') {
    const box = element('div', 'empty');
    const icon = element('span', 'empty-icon', symbol);
    icon.setAttribute('aria-hidden', 'true');
    box.append(icon, element('strong', '', title), element('span', '', detail));
    target.append(box);
  }
  const todayKey = () => localInput(new Date().toISOString()).slice(0, 10);
  const dayLabel = (day) => dateFormatter.format(instant(`${day}T12:00`));
  function shiftDate(day, days) {
    const date = new Date(`${day}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function shiftMonth(month, offset) {
    const date = new Date(`${month}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    return date.toISOString().slice(0, 7);
  }
  const daySchedules = (day) => state.schedules.filter((s) => localInput(s.startsAt).slice(0, 10) === day)
    .sort((a, b) => instant(a.startsAt) - instant(b.startsAt));
  function renderStats() {
    $('today').textContent = dateFormatter.format(new Date());
    $('upcoming-count').textContent = state.schedulesReady ? state.schedules.length : '—';
    $('today-count').textContent = state.schedulesReady && state.selectedDate.startsWith(state.loadedMonth) ? daySchedules(state.selectedDate).length : '—';
    $('attention-count').textContent = state.notificationsReady ? state.notifications.filter((n) => ['UNKNOWN', 'FAILED'].includes(statusOf(n))).length : '—';
  }
  function renderSchedules() {
    $('selected-date').value = state.selectedDate;
    $('selected-day-label').textContent = `${state.selectedDate === todayKey() ? '오늘 · ' : ''}${dayLabel(state.selectedDate)}`;
    const list = $('schedule-list');
    list.replaceChildren();
    if (!state.schedulesReady || !state.selectedDate.startsWith(state.loadedMonth)) {
      $('list-summary').textContent = state.busy ? '일정을 불러오는 중입니다.' : '목록을 불러오지 못했습니다.';
      empty(list, state.busy ? '일정을 불러오고 있어요' : '연결을 확인해 주세요', '새로고침으로 이 날짜의 일정을 다시 불러올 수 있어요.', '↻');
      return;
    }
    const query = $('search').value.trim().toLocaleLowerCase('ko');
    const daily = daySchedules(state.selectedDate);
    const filtered = daily.filter((s) => `${s.title ?? ''} ${s.description ?? ''}`.toLocaleLowerCase('ko').includes(query));
    const next = state.selectedDate === todayKey() ? daily.find((s) => instant(s.startsAt) >= new Date()) : null;
    $('list-summary').textContent = `${dayLabel(state.selectedDate)} · ${filtered.length}개${query ? ` / 전체 ${daily.length}개` : ''} · 시작 시간순`;
    if (!filtered.length) {
      empty(list, query ? '검색 결과가 없어요' : '비어 있는 하루예요', query ? '다른 검색어로 찾아보세요.' : '아래 ‘이날 일정 작성’으로 시간표를 채워보세요.');
      return;
    }
    let previousHour = '';
    for (const schedule of filtered) {
      const date = localInput(schedule.startsAt);
      const hour = date.slice(11, 13);
      if (hour !== previousHour) {
        list.append(element('h3', 'hour-divider', `${hour}:00 시간대`));
        previousHour = hour;
      }
      const isNext = schedule === next;
      const card = element('article', `schedule-card${isNext ? ' next-schedule' : ''}`);
      const top = element('div', 'card-top');
      const tile = element('time', 'time-tile', date.slice(11, 16));
      tile.setAttribute('datetime', schedule.startsAt);
      if (isNext) tile.append(element('span', '', '다음 일정'));
      else if (instant(schedule.startsAt) < new Date()) tile.append(element('span', 'elapsed', '지난 시간'));
      const content = element('div', 'card-content');
      const header = element('div', 'card-header');
      const status = statusOf(schedule);
      header.append(element('h3', '', schedule.title || '제목 없는 일정'), badge(status));
      content.append(header);
      if (schedule.description) content.append(element('p', 'description', schedule.description));
      const reminder = localInput(schedule.remindAt);
      content.append(element('p', 'meta', `알림 · ${reminder.slice(0, 10) === state.selectedDate ? reminder.slice(11, 16) : format(schedule.remindAt)}`));
      const actions = element('div', 'card-actions');
      const locked = ['SENDING', 'UNKNOWN'].includes(status);
      const edit = button('수정', 'secondary', () => editSchedule(schedule), locked);
      const remove = button('삭제', 'secondary delete', () => deleteSchedule(schedule), locked);
      edit.setAttribute('aria-label', `${schedule.title} 일정 수정`);
      remove.setAttribute('aria-label', `${schedule.title} 일정 삭제`);
      actions.append(edit, remove);
      content.append(actions);
      if (locked) content.append(element('p', 'field-help', status === 'UNKNOWN' ? '알림 이력에서 발송 결과를 확인한 뒤 수정·삭제할 수 있어요.' : '알림 발송 중에는 수정·삭제가 잠시 제한됩니다.'));
      top.append(tile, content);
      card.append(top);
      list.append(card);
    }
  }
  function renderCalendar() {
    $('month-label').textContent = `${state.month.slice(0, 4)}년 ${Number(state.month.slice(5))}월`;
    const grid = $('calendar-grid');
    grid.replaceChildren();
    grid.setAttribute('aria-busy', String(state.busy));
    const ready = state.schedulesReady && state.loadedMonth === state.month;
    const first = `${state.month}-01`;
    const offset = new Date(`${first}T12:00:00Z`).getUTCDay();
    const last = shiftDate(`${shiftMonth(state.month, 1)}-01`, -1);
    const cells = Math.ceil((offset + Number(last.slice(8))) / 7) * 7;
    for (let i = 0; i < cells; i++) {
      const day = shiftDate(first, i - offset);
      const inMonth = day.startsWith(state.month);
      if (!inMonth) {
        const pad = element('span', 'calendar-pad', String(Number(day.slice(8))));
        pad.setAttribute('aria-hidden', 'true');
        grid.append(pad);
        continue;
      }
      const schedules = ready ? daySchedules(day) : [];
      const cell = button('', `calendar-day${day === todayKey() ? ' is-today' : ''}${day === state.selectedDate ? ' is-selected' : ''}`, () => selectDay(day));
      cell.setAttribute('aria-label', `${dayLabel(day)}${day === todayKey() ? ', 오늘' : ''}, ${ready ? `일정 ${schedules.length}개` : '일정 확인 중'}`);
      cell.setAttribute('aria-pressed', String(day === state.selectedDate));
      if (day === todayKey()) cell.setAttribute('aria-current', 'date');
      cell.append(element('span', 'day-number', `${day === todayKey() ? '● ' : ''}${Number(day.slice(8))}`));
      if (schedules.length) {
        cell.append(element('span', 'day-count', `${schedules.length}개`));
        for (const schedule of schedules.slice(0, 2)) cell.append(element('span', 'calendar-event', `${localInput(schedule.startsAt).slice(11, 16)} ${schedule.title}`));
        if (schedules.length > 2) cell.append(element('span', 'calendar-more', `+${schedules.length - 2}개`));
      }
      grid.append(cell);
    }
    $('calendar-summary').textContent = ready ? `이번 조회 월의 일정 ${state.schedules.length}개 · 날짜를 눌러 시간순으로 확인하세요.` : state.busy ? '달력의 일정을 불러오는 중입니다.' : '달력을 불러오지 못했습니다. 새로고침해 주세요.';
  }
  async function selectDay(day) {
    if (state.busy || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    state.selectedDate = day;
    state.month = day.slice(0, 7);
    $('search').value = '';
    if (!state.dirty && !state.editing) resetForm();
    activateTab($('schedule-tab'));
    renderSchedules(); renderStats(); renderCalendar();
    if (state.loadedMonth !== state.month || !state.schedulesReady) await refresh();
    $('selected-date').focus();
  }
  async function selectMonth(month) {
    if (state.busy) return;
    state.month = month;
    // Keep the selected day inside the displayed month.
    state.selectedDate = month === todayKey().slice(0, 7) ? todayKey() : `${month}-01`;
    if (!state.dirty && !state.editing) resetForm();
    await refresh();
  }
  function renderHistory() {
    const list = $('history-list');
    list.replaceChildren();
    if (!state.notificationsReady) { empty(list, state.busy ? '알림 이력을 불러오고 있어요' : '알림 이력을 불러오지 못했어요', '새로고침으로 최신 상태를 확인할 수 있어요.', '↻'); return; }
    if (!state.notifications.length) { empty(list, '알림 이력이 아직 없어요', '일정을 등록하면 알림 예약과 발송 결과를 여기서 확인할 수 있어요.', '◷'); return; }
    for (const notification of state.notifications) {
      const card = element('article', 'history-card');
      const header = element('div', 'card-header');
      const schedule = state.schedules.find((s) => String(s.id) === String(notification.scheduleId));
      const status = statusOf(notification);
      header.append(element('h3', '', notification.scheduleTitle || notification.title || schedule?.title || '일정 알림'), badge(status));
      card.append(header, element('p', 'meta', `알림 예약 · ${format(notification.dueAt || notification.due_at || notification.remindAt || notification.scheduledAt || notification.scheduled_at || schedule?.remindAt)}`));
      if (notification.sentAt) card.append(element('p', 'meta', `발송 · ${format(notification.sentAt)}`));
      const identifiers = element('div', 'notification-identifiers');
      identifiers.append(element('p', 'meta', `알림 ID · ${notification.id}`));
      identifiers.append(element('p', 'field-help', 'Discord에서 이 알림 ID로 검색해 발송 여부를 확인하세요.'));
      identifiers.append(element('p', 'meta', `Discord 메시지 ID · ${notification.messageId || '기록 없음'}`));
      card.append(identifiers);
      const attempts = notification.attemptCount ?? notification.attempt_count ?? notification.attempts.length;
      if (attempts !== undefined) card.append(element('p', 'meta', `발송 시도 ${attempts}회`));
      if (notification.attempts.length) {
        const details = element('details', 'attempt-details');
        details.append(element('summary', '', `발송 시도 상세 (${notification.attempts.length}건)`));
        const attemptList = element('ol', 'attempt-list');
        notification.attempts.forEach((attempt, index) => {
          const item = element('li', 'attempt-item');
          const status = String(attempt.status || 'UNKNOWN').toUpperCase();
          const knownStatus = Object.hasOwn(labels, status) ? `${labels[status]} (${status})` : '상태 확인 필요';
          item.append(element('strong', '', `${index + 1}차 시도 · ${knownStatus}`));
          item.append(element('p', 'meta', `시작 · ${format(attempt.startedAt)}\n종료 · ${attempt.completedAt ? format(attempt.completedAt) : '기록 없음'}`));
          const code = Number(attempt.httpStatus);
          item.append(element('p', 'meta', `HTTP 코드 · ${Number.isInteger(code) && code >= 100 && code <= 599 ? code : '응답 기록 없음'}`));
          if (attempt.messageId) item.append(element('p', 'meta', `Discord 메시지 ID · ${attempt.messageId}`));
          attemptList.append(item);
        });
        details.append(attemptList);
        card.append(details);
      }
      // Never render raw delivery errors or response bodies: they may contain webhook credentials.
      if (status === 'UNKNOWN') card.append(element('p', 'unknown-note', 'Discord에 이미 전달되었을 수 있습니다. 채널에서 해당 알림을 먼저 확인하세요. 재시도하면 같은 알림이 중복 발송될 수 있습니다.'));
      if (status === 'FAILED') card.append(element('p', 'field-help', '발송에 실패했습니다. 연결 설정을 확인한 뒤 재시도해 주세요.'));
      if (['UNKNOWN', 'FAILED'].includes(status)) {
        const actions = element('div', 'card-actions');
        if (status === 'UNKNOWN') actions.append(button('재전송 없이 종료', 'secondary', () => resolveNotification(notification, false)));
        actions.append(button('재시도', 'secondary', () => resolveNotification(notification, true)));
        card.append(actions);
      }
      list.append(card);
    }
  }
  function setBusy(busy) {
    state.busy = busy;
    $('form-fields').disabled = busy;
    $('refresh').disabled = busy;
    for (const id of ['previous-day', 'next-day', 'go-today', 'selected-date', 'previous-month', 'next-month', 'this-month', 'plan-day']) $(id).disabled = busy;
    $('refresh').textContent = busy ? '처리 중…' : '↻ 새로고침';
    for (const id of ['schedule-list', 'history-list']) $(id).setAttribute('aria-busy', String(busy));
    renderSchedules();
    renderCalendar();
    renderHistory();
  }
  async function reload() {
    const results = await Promise.allSettled([request(`/api/schedules?from=${state.month}-01&to=${shiftMonth(state.month, 1)}-01`), request('/api/notifications')]);
    const errors = [];
    for (const [index, result] of results.entries()) {
      const key = index === 0 ? 'schedules' : 'notifications';
      try {
        if (result.status === 'rejected') throw result.reason;
        state[key] = key === 'notifications' ? notificationRows(result.value) : rows(result.value);
        state[`${key}Ready`] = true;
        if (key === 'schedules') state.loadedMonth = state.month;
      } catch (error) {
        state[`${key}Ready`] = false;
        errors.push(error);
      }
    }
    renderStats();
    renderSchedules();
    renderCalendar();
    renderHistory();
    if (errors.length) announce('일부 정보를 불러오지 못했습니다. 연결을 확인한 뒤 새로고침해 주세요.', true);
    return errors.length === 0;
  }
  async function refresh() {
    if (state.busy) return;
    setBusy(true);
    try { if (await reload()) announce('최신 일정과 알림 이력을 불러왔습니다.'); }
    finally { setBusy(false); }
  }
  function reminderMinutes() {
    return Number($('reminder-offset').value === 'custom' ? $('custom-minutes').value : $('reminder-offset').value);
  }
  function rowTimes(row) {
    const start = `${$('plan-date').value}T${row.time.value}:00`;
    const date = instant(start);
    const minutes = reminderMinutes();
    const reminder = new Date(date.getTime() - minutes * 60000);
    return { startsAt: start, remindAt: Number.isNaN(reminder.getTime()) ? '' : `${localInput(reminder.toISOString())}:00` };
  }
  function updatePreview() {
    const custom = $('reminder-offset').value === 'custom';
    $('custom-reminder').hidden = !custom;
    $('custom-minutes').disabled = !custom;
    $('custom-minutes').required = custom;
    const row = state.draftRows[0];
    if (!row) return;
    const times = rowTimes(row);
    const valid = !Number.isNaN(instant(times.startsAt).getTime()) && times.remindAt;
    $('reminder-preview').textContent = valid ? `첫 일정 ${row.time.value} → 알림 ${format(times.remindAt)}${instant(times.remindAt) <= new Date() ? ' · 이미 지난 알림 시각이에요' : ''}` : '날짜와 시간을 입력하면 알림 시각을 미리 볼 수 있어요.';
    $('discord-preview-title').textContent = `${row.time.value || '09:00'} · ${row.title.value || '해야 할 일'}`;
    $('discord-preview-date').textContent = valid ? `${dayLabel($('plan-date').value)} · 서울 (KST)` : '서울 시간 기준';
    $('save').textContent = state.editing ? '변경 내용 저장' : `시간표 저장 · ${state.draftRows.length}개`;
  }
  function defaultTime() {
    if ($('plan-date').value !== todayKey()) return '09:00';
    const later = localInput(new Date(Date.now() + 60 * 60000).toISOString());
    return later.slice(0, 10) === todayKey() ? later.slice(11, 16) : '23:59';
  }
  function addRow(data = {}, focus = false) {
    if (state.draftRows.length >= 48) return;
    const row = element('tr', 'plan-row');
    const timeCell = element('td');
    const contentCell = element('td');
    const actionCell = element('td');
    const time = element('input'); time.type = 'time'; time.required = true;
    time.setAttribute('aria-label', '일정 시작 시간');
    const previous = state.draftRows.at(-1)?.time.value;
    time.value = data.time || (previous ? `${String(Math.min(23, Number(previous.slice(0, 2)) + 1)).padStart(2, '0')}:${previous.slice(3)}` : defaultTime());
    const title = element('input'); title.required = true; title.maxLength = 200;
    title.placeholder = '무엇을 할까요?'; title.value = data.title || ''; title.setAttribute('aria-label', '할 일');
    const description = element('textarea'); description.rows = 1; description.maxLength = 2000;
    description.placeholder = '메모 · 장소 (선택)'; description.value = data.description || ''; description.setAttribute('aria-label', '메모 또는 장소');
    const item = { node: row, time, title, description };
    const remove = button('×', 'remove-row', () => {
      if (state.draftRows.length === 1) return;
      const index = state.draftRows.indexOf(item);
      state.draftRows = state.draftRows.filter((r) => r !== item);
      row.remove(); state.dirty = true;
      syncRows(); updatePreview();
      state.draftRows[Math.min(index, state.draftRows.length - 1)].title.focus();
    });
    item.remove = remove;
    remove.setAttribute('aria-label', '입력 행 삭제');
    for (const input of [time, title, description]) input.addEventListener('input', () => {
      state.dirty = true; input.setCustomValidity(''); updatePreview();
    });
    timeCell.append(time); contentCell.append(title, description); actionCell.append(remove);
    row.append(timeCell, contentCell, actionCell); $('plan-rows').append(row);
    state.draftRows.push(item); syncRows(); updatePreview();
    if (focus) title.focus();
  }
  function syncRows() {
    for (const row of state.draftRows) row.remove.disabled = state.draftRows.length === 1;
    $('add-row').hidden = !!state.editing;
    $('add-row').disabled = state.draftRows.length >= 48;
  }
  function resetForm() {
    state.editing = null; state.dirty = false; state.draftRows = [];
    $('schedule-form').reset(); $('plan-rows').replaceChildren();
    $('plan-date').value = state.selectedDate;
    $('reminder-offset').value = '10';
    $('form-title').textContent = '하루 시간표 작성';
    $('cancel-edit').hidden = true; $('edit-note').hidden = true;
    addRow();
  }
  async function mayReplaceDraft() {
    return !state.dirty || await confirmAction('작성 중인 내용을 바꿀까요?', '아직 저장하지 않은 입력 내용이 사라집니다.', '입력 내용 바꾸기');
  }
  async function editSchedule(schedule) {
    if (state.busy || !await mayReplaceDraft()) return;
    resetForm();
    state.editing = { id: schedule.id, version: schedule.version };
    $('plan-date').value = localInput(schedule.startsAt).slice(0, 10);
    $('plan-rows').replaceChildren(); state.draftRows = [];
    const minutes = Math.round((instant(schedule.startsAt) - instant(schedule.remindAt)) / 60000);
    $('reminder-offset').value = [0, 10, 30, 60, 1440].includes(minutes) ? String(minutes) : 'custom';
    $('custom-minutes').value = String(minutes);
    addRow({ time: localInput(schedule.startsAt).slice(11, 16), title: schedule.title, description: schedule.description });
    $('form-title').textContent = '일정 수정';
    $('cancel-edit').hidden = false; $('edit-note').hidden = false;
    state.dirty = true;
    state.draftRows[0].title.focus();
    $('schedule-form').scrollIntoView({ block: 'center', behavior: 'auto' });
  }
  function confirmAction(title, description, label, risk = false) {
    const dialog = $('confirm-dialog');
    if (dialog.open) return Promise.resolve(false);
    $('confirm-title').textContent = title;
    $('confirm-description').textContent = description;
    $('confirm-action').textContent = label;
    $('risk-label').hidden = !risk;
    $('risk-check').checked = false;
    $('confirm-action').disabled = risk;
    $('risk-check').onchange = () => { $('confirm-action').disabled = risk && !$('risk-check').checked; };
    dialog.returnValue = 'cancel';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' && (!risk || $('risk-check').checked)), { once: true });
      dialog.showModal();
    });
  }
  async function mutate(action, success, afterSuccess) {
    if (state.busy) return;
    setBusy(true);
    try {
      await action();
      if (afterSuccess) afterSuccess();
      const refreshed = await reload();
      announce(refreshed ? success : `${success} 최신 목록을 불러오지 못했으니 새로고침해 주세요.`, !refreshed);
    } catch (error) {
      if (error.status === 409 || error.status === 404) await reload();
      announce(errorMessage(error), true);
    } finally { setBusy(false); }
  }
  async function deleteSchedule(schedule) {
    const accepted = await confirmAction('일정을 삭제할까요?', `‘${schedule.title}’ 일정을 삭제합니다. 삭제한 일정은 복구할 수 없습니다.`, '일정 삭제');
    if (!accepted) return;
    await mutate(() => request(`/api/schedules/${encodeURIComponent(schedule.id)}?version=${encodeURIComponent(schedule.version)}`, { method: 'DELETE' }), '일정을 삭제했습니다.', () => {
      if (state.editing?.id === schedule.id) resetForm();
    });
  }
  async function resolveNotification(notification, retry) {
    const unknown = statusOf(notification) === 'UNKNOWN';
    const accepted = await confirmAction(retry ? '알림을 다시 보낼까요?' : '재전송 없이 종료할까요?', retry ? (unknown ? '발송 결과가 불확실합니다. 먼저 Discord 채널에서 알림을 확인하세요. 재시도는 중복 알림을 보낼 수 있습니다.' : '해당 일정의 알림을 다시 발송하도록 예약합니다.') : 'Discord 채널을 먼저 확인해 주세요. 이 알림을 다시 보내지 않고 종료합니다. 이 처리는 실제 발송 성공을 의미하지 않습니다.', retry ? '재시도 예약' : '재전송 없이 종료', retry && unknown);
    if (!accepted) return;
    await mutate(() => request(`/api/notifications/${encodeURIComponent(notification.id)}/resolve`, { method: 'POST', body: { retry, acceptDuplicateRisk: retry && unknown } }), retry ? '재시도를 요청했습니다. 알림 이력에서 결과를 확인해 주세요.' : '알림을 재전송 없이 종료했습니다.');
  }
  $('schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    for (const row of state.draftRows) {
      row.title.setCustomValidity(row.title.value.trim() ? '' : '할 일을 입력해 주세요.');
      row.time.setCustomValidity('');
    }
    if (!$('schedule-form').reportValidity()) return;
    const items = state.draftRows.map((row) => ({ title: row.title.value.trim(), description: row.description.value.trim(), ...rowTimes(row) }));
    for (const [index, item] of items.entries()) {
      if (!item.remindAt || instant(item.remindAt) <= new Date() || instant(item.remindAt) > instant(item.startsAt)) {
        state.draftRows[index].time.setCustomValidity('알림 시각이 현재 이후여야 합니다. 시작 시간을 늦추거나 알림을 시작 시각으로 바꿔주세요.');
        $('schedule-form').reportValidity(); return;
      }
    }
    const editing = state.editing;
    const savedDate = $('plan-date').value;
    if (editing) items[0].version = editing.version;
    await mutate(() => request(editing ? `/api/schedules/${encodeURIComponent(editing.id)}` : '/api/schedules/batch', {
      method: editing ? 'PUT' : 'POST', body: editing ? items[0] : { items }
    }), editing ? '일정을 수정했습니다.' : `${items.length}개의 일정을 시간표에 저장했습니다.`, () => {
      state.selectedDate = savedDate; state.month = savedDate.slice(0, 7); $('search').value = '';
      resetForm(); activateTab($('schedule-tab'));
    });
  });
  for (const id of ['plan-date', 'reminder-offset', 'custom-minutes']) $(id).addEventListener('input', () => {
    state.dirty = true;
    for (const row of state.draftRows) row.time.setCustomValidity('');
    updatePreview();
  });
  $('add-row').addEventListener('click', () => { state.dirty = true; addRow({}, true); });
  $('cancel-edit').addEventListener('click', async () => { if (await mayReplaceDraft()) resetForm(); });
  $('plan-day').addEventListener('click', async () => {
    if (!await mayReplaceDraft()) return;
    resetForm(); state.draftRows[0].title.focus();
    $('schedule-form').scrollIntoView({ block: 'center', behavior: 'auto' });
  });
  $('refresh').addEventListener('click', refresh);
  $('search').addEventListener('input', renderSchedules);
  $('selected-date').addEventListener('change', () => { if ($('selected-date').value) selectDay($('selected-date').value); });
  $('previous-day').addEventListener('click', () => selectDay(shiftDate(state.selectedDate, -1)));
  $('next-day').addEventListener('click', () => selectDay(shiftDate(state.selectedDate, 1)));
  $('go-today').addEventListener('click', () => selectDay(todayKey()));
  $('previous-month').addEventListener('click', () => selectMonth(shiftMonth(state.month, -1)));
  $('next-month').addEventListener('click', () => selectMonth(shiftMonth(state.month, 1)));
  $('this-month').addEventListener('click', () => selectMonth(todayKey().slice(0, 7)));
  const tabs = [$('schedule-tab'), $('calendar-tab'), $('history-tab')];
  function activateTab(selected) {
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !active;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      activateTab(next); next.focus();
    });
  });
  state.selectedDate = todayKey(); state.month = state.selectedDate.slice(0, 7);
  resetForm(); renderStats(); refresh();
})();
