'use strict';

(() => {
  const STORAGE_KEY = 'couples_calendar_v1';
  const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const MONTHS_RU_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

  // ───── Стейт ─────
  let state = loadState();
  let view = 'month';                          // month | year
  let cursor = startOfMonth(new Date());        // текущий период
  let pinMode = null;                           // 'setup' | 'verify' | 'change'
  let pinBuffer = '';
  let pinFirstAttempt = '';                     // для setup/change
  let pinChangeStep = 0;                        // 0 verify old, 1 new, 2 confirm
  let modalDate = null;
  let modalDraft = null;                        // {level, mood, note}

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { entries: {}, pinHash: null, createdAt: new Date().toISOString() };
      const data = JSON.parse(raw);
      if (!data.entries) data.entries = {};
      // Миграция: note → noteHusband
      let migrated = false;
      for (const k of Object.keys(data.entries)) {
        const e = data.entries[k];
        if (e && typeof e === 'object' && e.note !== undefined && e.noteHusband === undefined && e.noteWife === undefined) {
          e.noteHusband = e.note || '';
          e.noteWife = '';
          delete e.note;
          migrated = true;
        }
      }
      if (migrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return data;
    } catch { return { entries: {}, pinHash: null, createdAt: new Date().toISOString() }; }
  }
  function saveState() {
    // API-ключ хранится отдельно, не попадает в основной state
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function getApiKey() { return localStorage.getItem('couples_calendar_apikey') || ''; }
  function setApiKey(v) {
    if (v) localStorage.setItem('couples_calendar_apikey', v);
    else localStorage.removeItem('couples_calendar_apikey');
  }

  // ───── Утилиты дат ─────
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
  // понедельник = 0
  function weekdayMon(d) { const w = d.getDay(); return (w + 6) % 7; }

  // ───── Хэш PIN ─────
  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ───── Экраны ─────
  const screens = {
    lock: document.getElementById('screen-lock'),
    calendar: document.getElementById('screen-calendar'),
    stats: document.getElementById('screen-stats'),
    settings: document.getElementById('screen-settings'),
  };
  const bottomNav = document.getElementById('bottom-nav');

  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
    bottomNav.classList.toggle('hidden', name === 'lock');
    if (name === 'stats') renderStats();
    if (name === 'calendar') renderCalendar();
  }

  // ───── PIN ─────
  const lockTitle = document.getElementById('lock-title');
  const lockHint  = document.getElementById('lock-hint');
  const lockError = document.getElementById('lock-error');
  const pinDots   = document.getElementById('pin-dots').children;
  const pinReset  = document.getElementById('pin-reset');

  function startPinFlow() {
    pinBuffer = '';
    pinFirstAttempt = '';
    lockError.textContent = '';
    if (!state.pinHash) {
      pinMode = 'setup';
      lockTitle.textContent = 'Создайте PIN-код';
      lockHint.textContent = 'Придумайте 4 цифры';
    } else {
      pinMode = 'verify';
      lockTitle.textContent = 'Введите PIN-код';
      lockHint.textContent = '4 цифры';
    }
    pinReset.hidden = pinMode !== 'verify';
    updatePinDots();
  }

  function updatePinDots() {
    for (let i = 0; i < 4; i++) pinDots[i].classList.toggle('filled', i < pinBuffer.length);
  }

  async function handlePinComplete() {
    if (pinMode === 'setup') {
      if (!pinFirstAttempt) {
        pinFirstAttempt = pinBuffer;
        pinBuffer = '';
        lockTitle.textContent = 'Подтвердите PIN-код';
        lockHint.textContent = 'Введите ещё раз';
        updatePinDots();
        return;
      }
      if (pinBuffer === pinFirstAttempt) {
        state.pinHash = await sha256Hex(pinBuffer);
        saveState();
        unlock();
      } else {
        flashError('PIN не совпадает. Попробуйте снова.');
        pinFirstAttempt = '';
        pinBuffer = '';
        lockTitle.textContent = 'Создайте PIN-код';
        lockHint.textContent = 'Придумайте 4 цифры';
        updatePinDots();
      }
    } else if (pinMode === 'verify') {
      const h = await sha256Hex(pinBuffer);
      if (h === state.pinHash) {
        unlock();
      } else {
        flashError('Неверный PIN-код');
        pinBuffer = '';
        updatePinDots();
        shakeDots();
      }
    } else if (pinMode === 'change') {
      if (pinChangeStep === 0) {
        const h = await sha256Hex(pinBuffer);
        if (h !== state.pinHash) {
          flashError('Старый PIN неверен');
          pinBuffer = '';
          updatePinDots();
          shakeDots();
          return;
        }
        pinChangeStep = 1;
        pinBuffer = '';
        lockTitle.textContent = 'Новый PIN-код';
        lockHint.textContent = '4 цифры';
        updatePinDots();
      } else if (pinChangeStep === 1) {
        pinFirstAttempt = pinBuffer;
        pinBuffer = '';
        pinChangeStep = 2;
        lockTitle.textContent = 'Подтвердите новый PIN';
        lockHint.textContent = 'Введите ещё раз';
        updatePinDots();
      } else if (pinChangeStep === 2) {
        if (pinBuffer === pinFirstAttempt) {
          state.pinHash = await sha256Hex(pinBuffer);
          saveState();
          flashError('');
          unlock();
        } else {
          flashError('PIN не совпадает');
          pinBuffer = '';
          pinFirstAttempt = '';
          pinChangeStep = 1;
          lockTitle.textContent = 'Новый PIN-код';
          lockHint.textContent = '4 цифры';
          updatePinDots();
        }
      }
    }
  }

  function unlock() {
    pinBuffer = '';
    pinFirstAttempt = '';
    pinChangeStep = 0;
    pinMode = null;
    showScreen('calendar');
    setActiveTab('calendar');
  }

  function flashError(msg) {
    lockError.textContent = msg;
    if (msg) setTimeout(() => { if (lockError.textContent === msg) lockError.textContent = ''; }, 2200);
  }
  function shakeDots() {
    const el = document.getElementById('pin-dots');
    el.animate([
      { transform: 'translateX(0)' },
      { transform: 'translateX(-8px)' },
      { transform: 'translateX(8px)' },
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(0)' },
    ], { duration: 280, easing: 'ease-in-out' });
  }

  document.getElementById('pin-keypad').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    const k = btn.dataset.key;
    if (k === 'back') {
      pinBuffer = pinBuffer.slice(0, -1);
      updatePinDots();
    } else if (k === 'reset') {
      if (pinMode === 'verify' && confirm('Сбросить PIN и все данные? Это действие необратимо.')) {
        state = { entries: {}, pinHash: null, createdAt: new Date().toISOString() };
        saveState();
        startPinFlow();
      }
    } else if (/^\d$/.test(k)) {
      if (pinBuffer.length >= 4) return;
      pinBuffer += k;
      updatePinDots();
      if (pinBuffer.length === 4) setTimeout(handlePinComplete, 120);
    }
  });

  // ───── Топбар: переключатель ─────
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      view = btn.dataset.view;
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderCalendar();
    });
  });

  document.getElementById('nav-prev').addEventListener('click', () => navigate(-1));
  document.getElementById('nav-next').addEventListener('click', () => navigate(1));
  function navigate(delta) {
    if (view === 'month') {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
    } else {
      cursor = new Date(cursor.getFullYear() + delta, 0, 1);
    }
    renderCalendar();
    animateSlide(delta < 0 ? 'right' : 'left');
  }

  function animateSlide(from) {
    const el = view === 'month' ? document.getElementById('calendar-month') : document.getElementById('calendar-year');
    el.classList.remove('slide-from-left', 'slide-from-right');
    void el.offsetWidth;
    el.classList.add(from === 'left' ? 'slide-from-right' : 'slide-from-left');
  }

  // Свайпы по календарю
  function attachSwipe(el) {
    let sx = 0, sy = 0, st = 0, on = false;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now(); on = true;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (!on) return;
      on = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
      if (dt > 600) return;
      if (Math.abs(dx) < 60) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
      navigate(dx > 0 ? -1 : 1);
    }, { passive: true });
  }
  attachSwipe(document.getElementById('calendar-month'));
  attachSwipe(document.getElementById('calendar-year'));

  // ───── Рендер календаря ─────
  function emojiFor(level) { return level === 1 ? '🤍' : level === 2 ? '🩷' : level === 3 ? '❤️‍🔥' : ''; }
  function renderDayMark(level) {
    if (level === 4) return `<span class="emoji fail-mark"></span>`;
    return `<span class="emoji l${level}">${emojiFor(level)}</span>`;
  }

  function renderCalendar() {
    const monthEl = document.getElementById('calendar-month');
    const yearEl  = document.getElementById('calendar-year');
    const weekdaysEl = document.getElementById('weekdays');
    const title = document.getElementById('period-title');

    if (view === 'month') {
      monthEl.hidden = false;
      yearEl.hidden = true;
      weekdaysEl.style.display = 'grid';
      title.textContent = `${MONTHS_RU[cursor.getMonth()]} ${cursor.getFullYear()}`;
      renderMonth(monthEl, cursor.getFullYear(), cursor.getMonth());
    } else {
      monthEl.hidden = true;
      yearEl.hidden = false;
      weekdaysEl.style.display = 'none';
      title.textContent = `${cursor.getFullYear()}`;
      renderYear(yearEl, cursor.getFullYear());
    }
  }

  function renderMonth(container, year, month) {
    const today = new Date();
    const first = new Date(year, month, 1);
    const startOffset = weekdayMon(first);
    const total = daysInMonth(year, month);
    const prevTotal = daysInMonth(year, month - 1);
    container.innerHTML = '';

    // 6 рядов × 7 = 42
    for (let i = 0; i < 42; i++) {
      const dayIdx = i - startOffset + 1;
      let date, isOther = false;
      if (dayIdx < 1) {
        date = new Date(year, month - 1, prevTotal + dayIdx);
        isOther = true;
      } else if (dayIdx > total) {
        date = new Date(year, month + 1, dayIdx - total);
        isOther = true;
      } else {
        date = new Date(year, month, dayIdx);
      }
      const key = isoDate(date);
      const entry = state.entries[key];
      const isToday = isSameDay(date, today);

      const cell = document.createElement('div');
      cell.className = 'day';
      if (isOther) cell.classList.add('other');
      if (isToday) cell.classList.add('today');
      if (entry) cell.classList.add('has-entry');
      else cell.classList.add('empty');

      const inner = document.createElement('button');
      inner.type = 'button';
      inner.className = 'day-cell';
      inner.dataset.date = key;
      if (entry) {
        inner.innerHTML = renderDayMark(entry.level);
      } else {
        inner.textContent = String(date.getDate());
      }
      if (entry) {
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(date.getDate());
        inner.appendChild(num);
        const hasNote = (entry.noteHusband && entry.noteHusband.trim()) || (entry.noteWife && entry.noteWife.trim()) || (entry.note && entry.note.trim());
        if (hasNote) {
          const nd = document.createElement('span');
          nd.className = 'note-dot';
          inner.appendChild(nd);
        }
      }
      inner.addEventListener('click', () => openDayModal(date));
      cell.appendChild(inner);
      container.appendChild(cell);
    }
  }

  function renderYear(container, year) {
    container.innerHTML = '';
    const today = new Date();
    for (let m = 0; m < 12; m++) {
      const wrap = document.createElement('button');
      wrap.type = 'button';
      wrap.className = 'mini-month';
      wrap.innerHTML = `<div class="mini-month-title">${MONTHS_RU[m]}</div>`;
      const grid = document.createElement('div');
      grid.className = 'mini-grid';

      const first = new Date(year, m, 1);
      const offset = weekdayMon(first);
      const total = daysInMonth(year, m);
      // мини-заголовок дней недели
      const wd = document.createElement('div');
      wd.className = 'mini-weekdays';
      ['П','В','С','Ч','П','С','В'].forEach(c => {
        const s = document.createElement('span');
        s.textContent = c;
        wd.appendChild(s);
      });
      wrap.appendChild(wd);
      for (let i = 0; i < 42; i++) {
        const idx = i - offset + 1;
        const cell = document.createElement('div');
        cell.className = 'mini-day';
        if (idx >= 1 && idx <= total) {
          const date = new Date(year, m, idx);
          const key = isoDate(date);
          const entry = state.entries[key];
          cell.textContent = String(idx);
          if (entry) cell.classList.add('has', 'l' + entry.level);
          if (isSameDay(date, today)) cell.classList.add('today');
        } else {
          cell.classList.add('blank');
        }
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
      wrap.addEventListener('click', () => {
        cursor = new Date(year, m, 1);
        view = 'month';
        document.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'month'));
        renderCalendar();
      });
      container.appendChild(wrap);
    }
  }

  // ───── Модалка дня ─────
  const modal = document.getElementById('modal-day');
  const modalDateEl = document.getElementById('modal-date');
  const noteHusbandEl = document.getElementById('note-husband');
  const noteWifeEl = document.getElementById('note-wife');

  function openDayModal(date) {
    modalDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const key = isoDate(modalDate);
    const existing = state.entries[key];
    modalDraft = existing
      ? { ...existing, noteHusband: existing.noteHusband || '', noteWife: existing.noteWife || '' }
      : { level: 0, mood: 0, noteHusband: '', noteWife: '' };

    modalDateEl.textContent = `${modalDate.getDate()} ${MONTHS_RU_GEN[modalDate.getMonth()]} ${modalDate.getFullYear()}`;
    refreshModalUI();
    modal.querySelector('[data-action="delete"]').hidden = !existing;
    modal.hidden = false;
  }
  function closeModal() {
    modal.hidden = true;
    modalDate = null;
    modalDraft = null;
  }
  function refreshModalUI() {
    document.querySelectorAll('.level-btn').forEach(b => b.classList.toggle('selected', Number(b.dataset.level) === modalDraft.level));
    noteHusbandEl.value = modalDraft.noteHusband || '';
    noteWifeEl.value = modalDraft.noteWife || '';
  }

  document.querySelectorAll('.level-btn').forEach(b => {
    b.addEventListener('click', () => {
      const lvl = Number(b.dataset.level);
      modalDraft.level = (modalDraft.level === lvl) ? 0 : lvl;
      refreshModalUI();
    });
  });
  noteHusbandEl.addEventListener('input', () => { modalDraft.noteHusband = noteHusbandEl.value; });
  noteWifeEl.addEventListener('input', () => { modalDraft.noteWife = noteWifeEl.value; });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) { closeModal(); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    switch (action) {
      case 'cancel': closeModal(); break;
      case 'save': saveDayEntry(); break;
      case 'delete': deleteDayEntry(); break;
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  function saveDayEntry() {
    if (!modalDraft.level) { alert('Сначала выберите уровень.'); return; }
    const key = isoDate(modalDate);
    state.entries[key] = {
      level: modalDraft.level,
      noteHusband: (modalDraft.noteHusband || '').trim().slice(0, 400),
      noteWife: (modalDraft.noteWife || '').trim().slice(0, 400),
    };
    saveState();
    closeModal();
    renderCalendar();
  }
  function deleteDayEntry() {
    const key = isoDate(modalDate);
    delete state.entries[key];
    saveState();
    closeModal();
    renderCalendar();
  }

  // ───── Статистика ─────
  function renderStats() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();

    const inMonth = [];
    const inYear = [];
    for (const [key, entry] of Object.entries(state.entries)) {
      const [yy, mm] = key.split('-').map(Number);
      if (yy === y) {
        inYear.push({ key, entry });
        if (mm - 1 === m) inMonth.push({ key, entry });
      }
    }

    // Близости — только уровни 1..3 (провалы считаются отдельно)
    const inMonthClose = inMonth.filter(({entry}) => entry.level !== 4);
    const inYearClose  = inYear.filter(({entry}) => entry.level !== 4);

    document.getElementById('stat-month').textContent = inMonthClose.length;
    document.getElementById('stat-month-sub').textContent = inMonthClose.length ? `${MONTHS_RU[m]} ${y}` : '';
    document.getElementById('stat-year').textContent = inYearClose.length;
    document.getElementById('stat-year-sub').textContent = inYearClose.length ? `${y}` : '';

    const counts = {1:0, 2:0, 3:0, 4:0};
    inYear.forEach(({entry}) => {
      counts[entry.level] = (counts[entry.level] || 0) + 1;
    });
    document.getElementById('stat-l1').textContent = counts[1];
    document.getElementById('stat-l2').textContent = counts[2];
    document.getElementById('stat-l3').textContent = counts[3];
    document.getElementById('stat-l4').textContent = counts[4];

    // Средний интервал по году
    const calcInterval = (list) => {
      const dates = list.map(({key}) => new Date(key + 'T00:00:00')).sort((a, b) => a - b);
      if (dates.length < 2) return '—';
      let sum = 0;
      for (let i = 1; i < dates.length; i++) sum += (dates[i] - dates[i-1]) / 86400000;
      return (sum / (dates.length - 1)).toFixed(1).replace('.0', '');
    };
    document.getElementById('stat-interval').textContent = calcInterval(inYearClose);
    document.getElementById('stat-interval-alt').textContent = calcInterval(inYear);
  }

  // ───── Нижнее меню ─────
  document.querySelectorAll('.bottom-nav .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const t = tab.dataset.tab;
      setActiveTab(t);
      showScreen(t);
    });
  });
  function setActiveTab(name) {
    document.querySelectorAll('.bottom-nav .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  }

  // ───── Настройки ─────
  document.getElementById('btn-change-pin').addEventListener('click', () => {
    pinMode = 'change';
    pinBuffer = '';
    pinFirstAttempt = '';
    pinChangeStep = 0;
    lockTitle.textContent = 'Старый PIN-код';
    lockHint.textContent = '4 цифры';
    lockError.textContent = '';
    pinReset.hidden = true;
    updatePinDots();
    showScreen('lock');
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nash-calendar-${isoDate(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || !data.entries) throw new Error('bad');
      if (!confirm('Заменить текущие данные импортируемыми?')) { e.target.value = ''; return; }
      // сохраняем PIN, если в импорте его нет
      if (!data.pinHash) data.pinHash = state.pinHash;
      state = { entries: data.entries || {}, pinHash: data.pinHash, createdAt: data.createdAt || new Date().toISOString() };
      saveState();
      renderCalendar();
      alert('Импорт выполнен.');
    } catch {
      alert('Не удалось прочитать файл.');
    }
    e.target.value = '';
  });
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Удалить все записи? Это действие необратимо.')) return;
    state.entries = {};
    saveState();
    renderCalendar();
    renderStats();
  });

  // API-ключ
  const apiKeyInput = document.getElementById('api-key');
  const apiToggleBtn = document.getElementById('btn-api-toggle');
  apiKeyInput.value = getApiKey();
  apiKeyInput.addEventListener('change', () => setApiKey(apiKeyInput.value.trim()));
  apiKeyInput.addEventListener('blur', () => setApiKey(apiKeyInput.value.trim()));
  apiToggleBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      apiToggleBtn.textContent = 'Скрыть';
    } else {
      apiKeyInput.type = 'password';
      apiToggleBtn.textContent = 'Показать';
    }
  });

  // ───── ИИ-аналитика ─────
  const aiOutput = document.getElementById('ai-output');
  const aiPeriodEl = document.getElementById('ai-period');
  const aiLoader = document.getElementById('ai-loader');
  const aiText = document.getElementById('ai-text');
  const aiActions = document.getElementById('ai-actions');
  const aiHint = document.getElementById('ai-hint');

  function entriesInRange(from, to) {
    const out = [];
    for (const [key, entry] of Object.entries(state.entries)) {
      const d = new Date(key + 'T00:00:00');
      if (d >= from && d <= to) out.push({ date: key, ...entry });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  function levelLabel(l) {
    return l === 1 ? '🤍 была' : l === 2 ? '🩷 хорошая' : l === 3 ? '❤️‍🔥 восхитительная' : l === 4 ? '⚫ провал' : '—';
  }

  function formatEntriesForPrompt(list) {
    if (!list.length) return '(записей нет)';
    return list.map(e => {
      const parts = [`${e.date}: ${levelLabel(e.level)}`];
      if (e.noteHusband && e.noteHusband.trim()) parts.push(`супруг: «${e.noteHusband.trim()}»`);
      if (e.noteWife && e.noteWife.trim()) parts.push(`супруга: «${e.noteWife.trim()}»`);
      return '- ' + parts.join('; ');
    }).join('\n');
  }

  function periodRange(period) {
    const now = new Date();
    let from, to, label;
    if (period === 'week') {
      to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      from = new Date(to);
      from.setDate(from.getDate() - 6);
      label = 'Последние 7 дней';
    } else if (period === 'month') {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      label = `${MONTHS_RU[now.getMonth()]} ${now.getFullYear()}`;
    } else {
      from = new Date(now.getFullYear(), 0, 1);
      to = new Date(now.getFullYear(), 11, 31);
      label = `${now.getFullYear()} год`;
    }
    return { from, to, label };
  }

  async function runAiAnalysis(period) {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert('Введите Claude API ключ в Настройках.');
      return;
    }
    const { from, to, label } = periodRange(period);
    const list = entriesInRange(from, to);

    aiOutput.hidden = false;
    aiPeriodEl.textContent = label;
    aiActions.hidden = true;
    aiText.textContent = '';
    aiLoader.hidden = false;

    if (!list.length) {
      aiLoader.hidden = true;
      aiText.textContent = 'За выбранный период записей нет — добавьте отметки и попробуйте снова.';
      aiActions.hidden = false;
      return;
    }

    const close = list.filter(e => e.level !== 4);
    const fails = list.filter(e => e.level === 4);

    const prompt = `Ты — деликатный и тёплый аналитик отношений пары. Тебе передали личный календарь близости супружеской пары за период «${label}».
Числовая сводка:
- Всего записей: ${list.length}, из них близостей: ${close.length}, провалов: ${fails.length}

Записи:
${formatEntriesForPrompt(list)}

Сделай разбор на русском языке, тепло и без морализаторства. Структура:

**Картина периода**
2-3 предложения о том, как прошёл период, какие настроения и темы повторяются.

**Что работает (близости и тёплые моменты)**
3-5 конкретных наблюдений с упоминанием реальных деталей из заметок (если есть).

**Что мешало (если были провалы или плохое настроение)**
2-4 наблюдения. Без обвинений — описывай по-человечески.

**Совет супругу 💬**
2-3 коротких, конкретных, бережных совета — что попробовать сделать в следующий период именно с его стороны.

**Совет супруге 💖**
2-3 коротких, конкретных, бережных совета — именно с её стороны.

**Маленькая идея на этой неделе**
Одно конкретное действие, которое они могут попробовать вместе.

Пиши коротко, по делу, без воды. Заголовки выделяй жирным с помощью **текст**. Не используй обращение «вы» — обращайся к каждому отдельно. Не давай медицинских или психотерапевтических советов.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      aiLoader.hidden = true;
      if (!res.ok) {
        const msg = data?.error?.message || `Ошибка ${res.status}`;
        aiText.textContent = 'Не удалось получить разбор: ' + msg;
        aiActions.hidden = false;
        return;
      }
      const text = (data.content && data.content[0] && data.content[0].text) || '(пустой ответ)';
      aiText.innerHTML = mdToHtml(text);
      aiText.dataset.raw = text;
      aiActions.hidden = false;
    } catch (err) {
      aiLoader.hidden = true;
      aiText.textContent = 'Сбой запроса: ' + (err && err.message ? err.message : 'неизвестно');
      aiActions.hidden = false;
    }
  }

  function mdToHtml(s) {
    // Минимальный markdown → HTML: **bold**, заголовки и списки
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = esc(s);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.split(/\n\n+/).map(p => {
      const trimmed = p.trim();
      if (/^(- |• )/m.test(trimmed)) {
        const items = trimmed.split('\n').map(l => l.replace(/^(- |• )/, '').trim()).filter(Boolean);
        return '<ul>' + items.map(i => '<li>' + i + '</li>').join('') + '</ul>';
      }
      return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return html;
  }

  document.querySelectorAll('.ai-btn').forEach(b => {
    b.addEventListener('click', () => runAiAnalysis(b.dataset.period));
  });
  document.getElementById('btn-ai-close').addEventListener('click', () => { aiOutput.hidden = true; });
  document.getElementById('btn-ai-share').addEventListener('click', async () => {
    const text = aiText.dataset.raw || aiText.textContent;
    const title = `Наш календарь — ИИ-аналитика, ${aiPeriodEl.textContent}`;
    if (navigator.share) {
      try { await navigator.share({ title, text }); } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(text);
        alert('Скопировано в буфер обмена.');
      } catch {
        alert('Не удалось поделиться. Скопируйте текст вручную.');
      }
    }
  });

  // Обновление подсказки про API key
  function updateAiHint() {
    aiHint.hidden = !!getApiKey();
  }
  apiKeyInput.addEventListener('input', updateAiHint);
  updateAiHint();

  // ───── Service Worker ─────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              // новая версия установлена — перезагружаемся
              window.location.reload();
            }
          });
        });
        // периодически проверяем апдейты
        setInterval(() => reg.update().catch(() => {}), 60 * 1000);
      }).catch(() => {});
    });
  }

  // ───── Старт ─────
  startPinFlow();
})();
