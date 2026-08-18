/**
 * Modul: Login-Seite
 * Zweck: Anmeldeformular mit Username/Passwort, Fehlerbehandlung, Session-Start
 * Abhängigkeiten: /api.js
 */

import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const VERSION_URL = '/api/v1/version';
const DEFAULT_APP_NAME = 'Duck Board';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';

function getStoredAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || DEFAULT_APP_NAME;
}

function setAppBranding(appName) {
  const name = String(appName || '').trim() || DEFAULT_APP_NAME;
  document.title = name;
  const titleEl = document.querySelector('.auth-hero__title');
  if (titleEl) titleEl.textContent = name;
}

/**
 * Rendert die Login-Seite in den gegebenen Container.
 * @param {HTMLElement} container
 */
export async function render(container) {
  const storedAppName = getStoredAppName();

  // SSO-Kapabilität VOR dem ersten Paint ermitteln, damit der SSO-Block nicht
  // nachträglich einspringt und das zentrierte Formular verschiebt (Layout-Shift).
  // Gebändigt per Timeout, sodass ein langsamer/nicht erreichbarer Server das
  // Passwort-Login nie blockiert – dann wird ohne SSO gerendert.
  const oidc = await fetchOidcConfig();
  const ssoEnabled = oidc?.enabled === true;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      <div class="auth-hero">
        <span class="auth-hero__mark" aria-hidden="true">
          <svg viewBox="0 0 160 160" fill="currentColor">
            <g fill-opacity="0.82">
              <circle cx="64" cy="72" r="27" />
              <circle cx="100" cy="78" r="25" />
              <circle cx="80" cy="106" r="24" />
            </g>
          </svg>
        </span>
        <h1 class="auth-hero__title">${esc(storedAppName)}</h1>
        <p class="auth-hero__tagline">${esc(t('login.tagline'))}</p>
      </div>
      <div class="auth-card card card--padded">

        <form class="auth-form" id="auth-form" novalidate>
          <div class="form-group">
            <label class="label" for="username">${esc(t('login.usernameLabel'))}</label>
            <input
              class="input"
              type="text"
              id="username"
              name="username"
              autocomplete="username"
              autocapitalize="none"
              autocorrect="off"
              required
            />
          </div>

          <div class="form-group">
            <label class="label" for="password">${esc(t('login.passwordLabel'))}</label>
            <input
              class="input"
              type="password"
              id="password"
              name="password"
              autocomplete="current-password"
              required
            />
            <p class="auth-capslock" id="auth-capslock" role="status" hidden>
              <i data-lucide="arrow-up" aria-hidden="true"></i>
              <span>${esc(t('login.capsLockWarning'))}</span>
            </p>
          </div>

          <div class="form-error" id="form-error" role="alert" tabindex="-1" hidden></div>

          <button type="submit" class="btn btn--primary auth-form__submit" id="auth-btn">
            <span class="auth-btn__label">${esc(t('login.loginButton'))}</span>
          </button>
          ${ssoEnabled ? `
          <div class="auth-divider">${esc(t('login.orDivider'))}</div>
          <a href="/api/v1/auth/oidc/start" class="btn btn--secondary auth-form__submit">${esc(t('login.loginWithSso'))}</a>
          ` : ''}
          <p class="auth-form__forgot" hidden>
            <a href="/forgot-password" data-link>${esc(t('login.forgotPassword'))}</a>
          </p>
        </form>
      </div>
      <p class="auth-version" id="auth-version"></p>
    </main>
  `);

  const form = container.querySelector('#auth-form');
  const errorEl = container.querySelector('#form-error');
  const submitBtn = container.querySelector('#auth-btn');
  const versionEl = container.querySelector('#auth-version');

  container.querySelectorAll('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.yuvomi.navigate(a.getAttribute('href')); }));

  // OIDC-Fehlermeldung aus URL-Parameter anzeigen (z.B. ?error=oidc_failed nach gescheitertem Callback)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('error')?.startsWith('oidc_')) {
    showError(errorEl, t('login.ssoError'));
  }

  // K3: Passwort-Sichtbarkeits-Toggle
  const passwordInput = form.querySelector('#password');
  const passwordWrapper = document.createElement('div');
  passwordWrapper.className = 'input-password-wrapper';
  passwordInput.parentNode.insertBefore(passwordWrapper, passwordInput);
  passwordWrapper.appendChild(passwordInput);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'password-toggle';
  toggleBtn.setAttribute('aria-label', t('login.showPassword'));
  const toggleIcon = document.createElement('i');
  toggleIcon.setAttribute('data-lucide', 'eye');
  toggleIcon.setAttribute('aria-hidden', 'true');
  toggleBtn.appendChild(toggleIcon);
  passwordWrapper.appendChild(toggleBtn);
  if (window.lucide) lucide.createIcons({ el: toggleBtn });

  toggleBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    toggleIcon.setAttribute('data-lucide', isPassword ? 'eye-off' : 'eye');
    toggleBtn.setAttribute('aria-label', t(isPassword ? 'login.hidePassword' : 'login.showPassword'));
    if (window.lucide) lucide.createIcons({ el: toggleBtn });
  });

  // Caps-Lock-Hinweis: eine aktive Feststelltaste ist die häufigste Ursache für
  // vermeintlich falsche Passwörter. Nur am Passwortfeld, nur solange aktiv.
  const capslockEl = container.querySelector('#auth-capslock');
  if (window.lucide) lucide.createIcons({ el: capslockEl });
  const updateCapsLock = (e) => {
    if (typeof e.getModifierState !== 'function') return;
    capslockEl.hidden = !e.getModifierState('CapsLock');
  };
  passwordInput.addEventListener('keydown', updateCapsLock);
  passwordInput.addEventListener('keyup', updateCapsLock);
  passwordInput.addEventListener('blur', () => { capslockEl.hidden = true; });

  setAppBranding(storedAppName);

  // Autofocus nur auf Zeigegeräten (Desktop): spart Rückkehrern den Klick, ohne
  // auf Touch sofort die virtuelle Tastatur hochzureißen und Hero/Branding zu
  // verdecken, bevor der Nutzer sich orientiert hat.
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    container.querySelector('#username').focus();
  }

  fetch(VERSION_URL, { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      if (d?.app_name) {
        try { localStorage.setItem(APP_NAME_STORAGE_KEY, d.app_name); } catch (_) {}
        // Nur neu anwenden, wenn sich der Name tatsächlich geändert hat –
        // verhindert ein sichtbares Titel-Flackern bei jedem Aufruf.
        if (d.app_name !== storedAppName) setAppBranding(d.app_name);
      }
      // „Passwort vergessen?" wie SSO gaten: nur anbieten, wenn der Server eine
      // Reset-Mail tatsächlich zustellen kann (SMTP + BASE_URL). Sonst Sackgasse.
      if (d?.password_reset_enabled) {
        const forgot = container.querySelector('.auth-form__forgot');
        if (forgot) forgot.hidden = false;
      }
      versionEl.textContent = d?.version ? t('login.version', { version: d.version }) : '';
    })
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const username = form.username.value.trim();
    const password = form.password.value;

    const usernameInput = form.querySelector('#username');
    const usernameGroup = usernameInput.closest('.form-group');
    const passwordGroup = passwordInput.closest('.form-group');

    usernameGroup.classList.toggle('form-group--error', !username);
    passwordGroup.classList.toggle('form-group--error', !password);
    usernameInput.setAttribute('aria-invalid', String(!username));
    passwordInput.setAttribute('aria-invalid', String(!password));

    if (!username || !password) {
      // Nicht nur rote Rahmen: einen angesagten Grund nennen (auch für SR).
      showError(errorEl, t('login.fillAllFields'));
      if (!username) usernameInput.focus();
      else passwordInput.focus();
      return;
    }

    const labelEl = submitBtn.querySelector('.auth-btn__label');

    submitBtn.disabled = true;
    usernameInput.disabled = true;
    passwordInput.disabled = true;
    labelEl.textContent = t('login.loggingIn');
    const spinner = document.createElement('span');
    spinner.className = 'auth-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    submitBtn.insertBefore(spinner, labelEl);

    try {
      const result = await auth.login(username, password);
      window.yuvomi.navigate('/', result.user);
    } catch (err) {
      // Fehler-Ehrlichkeit: nur 401 heißt „falsche Zugangsdaten". 429 ist die
      // Sperre; alles andere (Status 0 = offline, 5xx = Serverfehler) ist ein
      // Verbindungsproblem – der Nutzer darf nicht fälschlich an sich zweifeln.
      let message;
      if (err.status === 429) message = t('login.tooManyAttempts');
      else if (err.status === 401) message = t('login.invalidCredentials');
      else message = t('login.networkError');
      showError(errorEl, message);

      if (err.status === 401) {
        // Beide Felder markieren (welches falsch ist, verrät der Server aus
        // Sicherheitsgründen nicht) und den Recovery-Weg sichtbar betonen.
        usernameGroup.classList.add('form-group--error');
        passwordGroup.classList.add('form-group--error');
        usernameInput.setAttribute('aria-invalid', 'true');
        passwordInput.setAttribute('aria-invalid', 'true');
        const forgot = container.querySelector('.auth-form__forgot');
        if (forgot && !forgot.hidden) forgot.classList.add('auth-form__forgot--emphasis');
      }

      // Fokus auf die Fehlermeldung, damit auch sehende Tastaturnutzer sie
      // bemerken (nicht nur Screenreader über role="alert").
      errorEl.focus();
    } finally {
      submitBtn.disabled = false;
      usernameInput.disabled = false;
      passwordInput.disabled = false;
      labelEl.textContent = t('login.loginButton');
      spinner.remove();
    }
  });

  form.querySelector('#username').addEventListener('input', (e) => {
    e.currentTarget.closest('.form-group').classList.remove('form-group--error');
    e.currentTarget.removeAttribute('aria-invalid');
  });
  form.querySelector('#password').addEventListener('input', (e) => {
    e.currentTarget.closest('.form-group').classList.remove('form-group--error');
    e.currentTarget.removeAttribute('aria-invalid');
  });
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

/**
 * Holt die OIDC/SSO-Kapabilität, bevor das Formular gerendert wird, damit der
 * SSO-Block bereits beim ersten Paint an Ort und Stelle ist (kein Layout-Shift).
 * Per AbortController-Timeout gebändigt: schlägt der Request fehl oder hängt er,
 * wird ohne SSO gerendert – das Passwort-Login darf nie am OIDC-Endpunkt hängen.
 * @param {number} timeoutMs
 * @returns {Promise<{enabled?: boolean}|null>}
 */
function fetchOidcConfig(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    fetch('/api/v1/auth/oidc/config', { cache: 'no-store', signal: controller.signal })
      .then((r) => r.json())
      .then((data) => { clearTimeout(timer); resolve(data); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}
