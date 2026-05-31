/**
 * Module: Screensaver
 * Purpose: Show a 12h digital clock after configurable idle time
 * Dependencies: none
 */

const TIMEOUT_KEY = 'oikos-screensaver-timeout';

let idleTimer = null;
let clockInterval = null;
let overlay = null;

const CSS = `
.screensaver {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: none;
  user-select: none;
  touch-action: none;
}
.screensaver__clock {
  text-align: center;
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
}
.screensaver__time {
  font-size: clamp(5rem, 22vw, 16rem);
  font-weight: 200;
  color: #fff;
  letter-spacing: -0.02em;
  line-height: 1;
}
.screensaver__sub {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 0.4em;
  margin-top: 0.15em;
}
.screensaver__seconds {
  font-size: clamp(1.5rem, 5vw, 3.5rem);
  font-weight: 300;
  color: rgba(255,255,255,0.35);
}
.screensaver__period {
  font-size: clamp(1rem, 3vw, 2rem);
  font-weight: 400;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.12em;
}
.screensaver__date {
  font-size: clamp(0.9rem, 2.5vw, 1.3rem);
  font-weight: 300;
  color: rgba(255,255,255,0.25);
  letter-spacing: 0.06em;
  margin-top: 1.8em;
}
`;

function getTimeoutMs() {
  const val = parseInt(localStorage.getItem(TIMEOUT_KEY) ?? '0', 10);
  return val > 0 ? val * 60 * 1000 : 0;
}

function formatClock(date) {
  let h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return {
    time: `${h}:${String(m).padStart(2, '0')}`,
    seconds: `:${String(s).padStart(2, '0')}`,
    period,
  };
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function show() {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.className = 'screensaver';
  overlay.setAttribute('aria-label', 'Screensaver');
  overlay.innerHTML = `
    <div class="screensaver__clock">
      <div class="screensaver__time" id="ss-time"></div>
      <div class="screensaver__sub">
        <span class="screensaver__seconds" id="ss-seconds"></span>
        <span class="screensaver__period" id="ss-period"></span>
      </div>
      <div class="screensaver__date" id="ss-date"></div>
    </div>
  `;

  function tick() {
    const now = new Date();
    const { time, seconds, period } = formatClock(now);
    overlay.querySelector('#ss-time').textContent = time;
    overlay.querySelector('#ss-seconds').textContent = seconds;
    overlay.querySelector('#ss-period').textContent = period;
    overlay.querySelector('#ss-date').textContent = formatDate(now);
  }

  tick();
  clockInterval = setInterval(tick, 1000);
  document.body.appendChild(overlay);

  ['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
    overlay.addEventListener(evt, hide, { once: true, passive: true });
  });
}

function hide() {
  if (!overlay) return;
  clearInterval(clockInterval);
  clockInterval = null;
  overlay.remove();
  overlay = null;
  resetTimer();
}

function resetTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const ms = getTimeoutMs();
  if (ms > 0) idleTimer = setTimeout(show, ms);
}

function onActivity() {
  if (overlay) hide();
  else resetTimer();
}

export function updateTimeout(minutes) {
  clearTimeout(idleTimer);
  idleTimer = null;
  const ms = parseInt(minutes, 10) * 60 * 1000;
  if (ms > 0) idleTimer = setTimeout(show, ms);
}

export function init() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel', 'pointerdown'];
  EVENTS.forEach((evt) => document.addEventListener(evt, onActivity, { passive: true }));

  resetTimer();
}
