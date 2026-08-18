import { api } from '../api.js';
import { formatDate } from '../i18n.js';

const IDLE_MS = Math.max(30, Number.parseInt(document.documentElement.dataset.screensaverIdle || '300', 10)) * 1000;
const SLIDE_MS = 20_000;

let idleTimer;
let slideTimer;
let clockTimer;
let overlay;
let run = 0;

function stop() {
  run += 1;
  clearInterval(slideTimer);
  slideTimer = undefined;
  clearInterval(clockTimer);
  clockTimer = undefined;
  overlay?.remove();
  overlay = undefined;
}

function resetIdle(event) {
  const wasVisible = Boolean(overlay);
  stop();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(start, IDLE_MS);
  // A dismissing gesture belongs to the overlay and must not activate the
  // dashboard control underneath it (particularly important on wall tablets).
  if (wasVisible && event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function caption(photo) {
  const place = [photo.city, photo.country].filter(Boolean).join(', ');
  if (!photo.takenAt) return place;
  const date = new Date(photo.takenAt);
  // Follows the date-format preference like every other date in the app.
  const formatted = Number.isNaN(date.getTime()) ? '' : formatDate(date);
  return [formatted, place].filter(Boolean).join(' · ');
}

async function start() {
  const currentRun = ++run;
  try {
    const payload = await api.get('/screensaver/photos');
    if (currentRun !== run) return false;
    const photos = payload?.data?.photos || [];
    // No Immich photos available (module off or empty album) → fall back to a
    // dependency-free clock, so idle wall tablets/kiosks still show something.
    if (!payload?.data?.enabled || !photos.length) return startClock(currentRun);

    overlay = document.createElement('div');
    overlay.className = 'photo-screensaver';
    overlay.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.alt = '';
    const label = document.createElement('p');
    overlay.append(image, label);
    document.body.append(overlay);

    let index = Math.floor(Math.random() * photos.length);
    const show = () => {
      if (!overlay) return;
      const photo = photos[index++ % photos.length];
      image.classList.remove('photo-screensaver__visible');
      image.onload = () => image.classList.add('photo-screensaver__visible');
      image.src = `/api/v1/screensaver/photos/${encodeURIComponent(photo.id)}`;
      label.textContent = caption(photo);
      // Move the only persistent text so the screensaver itself has no fixed
      // bright pixels that could cause burn-in.
      label.dataset.position = String(index % 4);
    };
    show();
    slideTimer = setInterval(show, SLIDE_MS);
    return true;
  } catch {
    // Screensaver is optional; retry after the next period of inactivity.
    return false;
  }
}

/**
 * Fallback screensaver: a 12-hour digital clock. Shown when the photo
 * screensaver has nothing to display (Immich not configured / empty album).
 * Reuses the same idle timer and activity listeners as the photo mode, so
 * there is only ever one screensaver system running.
 */
function startClock(currentRun) {
  if (currentRun !== run) return false;
  overlay = document.createElement('div');
  overlay.className = 'photo-screensaver photo-screensaver--clock';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="photo-screensaver__clock">
      <div class="photo-screensaver__time"></div>
      <div class="photo-screensaver__sub">
        <span class="photo-screensaver__seconds"></span>
        <span class="photo-screensaver__period"></span>
      </div>
      <div class="photo-screensaver__date"></div>
    </div>
  `;
  document.body.append(overlay);

  const timeEl = overlay.querySelector('.photo-screensaver__time');
  const secondsEl = overlay.querySelector('.photo-screensaver__seconds');
  const periodEl = overlay.querySelector('.photo-screensaver__period');
  const dateEl = overlay.querySelector('.photo-screensaver__date');
  const tick = () => {
    if (!overlay) return;
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    periodEl.textContent = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    timeEl.textContent = `${hours}:${String(minutes).padStart(2, '0')}`;
    secondsEl.textContent = `:${String(seconds).padStart(2, '0')}`;
    dateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  };
  tick();
  clockTimer = setInterval(tick, 1000);
  return true;
}

/** Opens the real screensaver immediately for the admin configuration preview. */
export async function preview() {
  stop();
  clearTimeout(idleTimer);
  const opened = await start();
  if (!opened) resetIdle();
  return opened;
}

let lastMove = 0;
for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
  window.addEventListener(eventName, resetIdle, { passive: false, capture: true });
}
window.addEventListener('pointermove', () => {
  const now = Date.now();
  if (now - lastMove > 1000) { lastMove = now; resetIdle(); }
}, { passive: true, capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop(); else resetIdle();
});
resetIdle();
