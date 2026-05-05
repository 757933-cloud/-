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
      return data;
    } catch { return { entries: {}, pinHash: null, createdAt: new Date().toISOString() }; }
  }
  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
        if (entry.note && entry.note.trim()) {
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
  const noteEl = document.getElementById('note');
  const btnSave = document.getElementById('btn-save');
  const btnDelete = document.getElementById('btn-delete');
  const btnCancel = document.getElementById('btn-cancel');

  function openDayModal(date) {
    modalDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const key = isoDate(modalDate);
    const existing = state.entries[key];
    modalDraft = existing ? { ...existing } : { level: 0, mood: 0, note: '' };

    modalDateEl.textContent = `${modalDate.getDate()} ${MONTHS_RU_GEN[modalDate.getMonth()]} ${modalDate.getFullYear()}`;
    refreshModalUI();
    btnDelete.hidden = !existing;
    modal.hidden = false;
  }
  function closeModal() {
    modal.hidden = true;
    modalDate = null;
    modalDraft = null;
  }
  function refreshModalUI() {
    document.querySelectorAll('.level-btn').forEach(b => b.classList.toggle('selected', Number(b.dataset.level) === modalDraft.level));
    document.querySelectorAll('.star').forEach(s => s.classList.toggle('filled', Number(s.dataset.mood) <= modalDraft.mood));
    noteEl.value = modalDraft.note || '';
  }

  document.querySelectorAll('.level-btn').forEach(b => {
    b.addEventListener('click', () => {
      const lvl = Number(b.dataset.level);
      modalDraft.level = (modalDraft.level === lvl) ? 0 : lvl;
      refreshModalUI();
    });
  });
  document.querySelectorAll('.star').forEach(s => {
    s.addEventListener('click', () => {
      const m = Number(s.dataset.mood);
      modalDraft.mood = (modalDraft.mood === m) ? 0 : m;
      refreshModalUI();
    });
  });
  noteEl.addEventListener('input', () => { modalDraft.note = noteEl.value; });

  btnCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  btnSave.addEventListener('click', () => {
    if (!modalDraft.level) {
      alert('Выберите уровень или нажмите «Удалить».');
      return;
    }
    const key = isoDate(modalDate);
    state.entries[key] = {
      level: modalDraft.level,
      mood: modalDraft.mood || 0,
      note: (modalDraft.note || '').trim().slice(0, 200),
    };
    saveState();
    closeModal();
    renderCalendar();
  });
  btnDelete.addEventListener('click', () => {
    const key = isoDate(modalDate);
    delete state.entries[key];
    saveState();
    closeModal();
    renderCalendar();
  });

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
    let moodSum = 0, moodCount = 0;
    inYearClose.forEach(({entry}) => {
      if (entry.mood) { moodSum += entry.mood; moodCount++; }
    });
    inYear.forEach(({entry}) => {
      counts[entry.level] = (counts[entry.level] || 0) + 1;
    });
    document.getElementById('stat-l1').textContent = counts[1];
    document.getElementById('stat-l2').textContent = counts[2];
    document.getElementById('stat-l3').textContent = counts[3];
    document.getElementById('stat-l4').textContent = counts[4];

    // Средний интервал по году — только между близостями
    const dates = inYearClose.map(({key}) => new Date(key + 'T00:00:00')).sort((a, b) => a - b);
    let interval = '—';
    if (dates.length >= 2) {
      let sum = 0;
      for (let i = 1; i < dates.length; i++) sum += (dates[i] - dates[i-1]) / 86400000;
      interval = (sum / (dates.length - 1)).toFixed(1).replace('.0', '');
    }
    document.getElementById('stat-interval').textContent = interval;

    if (moodCount) {
      const avg = moodSum / moodCount;
      document.getElementById('stat-mood').textContent = avg.toFixed(1);
      const stars = '★'.repeat(Math.round(avg)) + '☆'.repeat(5 - Math.round(avg));
      document.getElementById('stat-mood-stars').textContent = stars;
    } else {
      document.getElementById('stat-mood').textContent = '—';
      document.getElementById('stat-mood-stars').textContent = '';
    }
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
