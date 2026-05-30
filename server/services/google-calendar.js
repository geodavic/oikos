/**
 * Modul: Google Calendar Sync
 * Zweck: OAuth 2.0 + bidirektionaler Sync mit Google Calendar API v3
 * Abhängigkeiten: googleapis, server/db.js
 *
 * sync_config-Schlüssel:
 *   google_access_token   - OAuth Access Token
 *   google_refresh_token  - OAuth Refresh Token (langlebig)
 *   google_token_expiry   - ISO-8601-Timestamp bis wann Access Token gültig ist
 *   google_sync_token     - Inkrementeller Sync-Token von Google (events.list)
 *   google_last_sync      - ISO-8601-Timestamp des letzten erfolgreichen Syncs
 */

import { createLogger } from '../logger.js';
const log = createLogger('Google');

import { google } from 'googleapis';
import crypto from 'node:crypto';
import * as db from '../db.js';

const GOOGLE_COLOR = '#4285F4';

function upsertExternalCalendar(source, externalId, name, color) {
  const row = db.get().prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      name  = excluded.name,
      color = excluded.color
    RETURNING id
  `).get(source, externalId, name, color);
  return row.id;
}

// --------------------------------------------------------
// OAuth2-Client (lazy initialisiert)
// --------------------------------------------------------

function createClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('[Google] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// --------------------------------------------------------
// sync_config Helfer
// --------------------------------------------------------

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDel(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

// --------------------------------------------------------
// Client mit gespeicherten Tokens laden
// --------------------------------------------------------

function loadAuthorizedClient() {
  const accessToken  = cfgGet('google_access_token');
  const refreshToken = cfgGet('google_refresh_token');

  if (!accessToken || !refreshToken) {
    throw new Error('[Google] Not configured - complete OAuth first.');
  }

  const client = createClient();
  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   cfgGet('google_token_expiry') ? parseInt(cfgGet('google_token_expiry'), 10) : undefined,
  });

  // Token-Refresh automatisch speichern
  client.on('tokens', (tokens) => {
    if (tokens.access_token) cfgSet('google_access_token', tokens.access_token);
    if (tokens.expiry_date)  cfgSet('google_token_expiry', String(tokens.expiry_date));
  });

  return client;
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Generiert die Google OAuth2-URL zum Weiterleiten des Admins.
 * @returns {string} Auth-URL
 */
/**
 * Generiert die Google OAuth2-URL zum Weiterleiten des Admins.
 * Enthalt einen CSRF-sicheren state-Parameter.
 * @param {object} session - Express-Session-Objekt (state wird dort gespeichert)
 * @returns {string} Auth-URL
 */
function getAuthUrl(session) {
  const client = createClient();
  const state = crypto.randomBytes(32).toString('hex');
  if (session) session.googleOAuthState = state;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/calendar'],
    state,
  });
}

/**
 * OAuth-Callback: tauscht Code gegen Tokens, speichert in sync_config.
 * @param {string} code - Code aus dem OAuth-Callback-Query-Parameter
 */
async function handleCallback(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('[Google] No refresh token received. Revoke access in your Google account and connect again.');
  }

  cfgSet('google_access_token',  tokens.access_token);
  cfgSet('google_refresh_token', tokens.refresh_token);
  if (tokens.expiry_date) cfgSet('google_token_expiry', String(tokens.expiry_date));

  log.info('OAuth successful - tokens saved.');

  try {
    await fetchCalendars();
    if (!cfgGet('google_enabled_calendars')) {
      cfgSet('google_enabled_calendars', JSON.stringify(['primary']));
    }
  } catch (err) {
    log.warn('Could not fetch calendar list after OAuth:', err.message);
  }
}

/**
 * Verbindungsstatus zurückgeben.
 * @returns {{ configured: boolean, connected: boolean, lastSync: string|null }}
 */
function getStatus() {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
  const connected  = !!(cfgGet('google_access_token') && cfgGet('google_refresh_token'));
  const lastSync   = cfgGet('google_last_sync');
  return { configured, connected, lastSync };
}

/**
 * Tokens und Sync-State löschen (Verbindung trennen).
 */
function disconnect() {
  ['google_access_token', 'google_refresh_token', 'google_token_expiry',
   'google_last_sync', 'google_enabled_calendars'].forEach(cfgDel);
  db.get().prepare("DELETE FROM sync_config WHERE key LIKE 'google_sync_token%'").run();
  log.info('Disconnected.');
}

/**
 * Ruft die Kalender-Liste von Google ab und speichert sie in external_calendars.
 * @returns {Array<{id, name, color, primary}>}
 */
async function fetchCalendars() {
  const client = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.calendarList.list({ minAccessRole: 'reader' });
  const items = res.data.items || [];
  for (const cal of items) {
    upsertExternalCalendar('google', cal.id, cal.summary || cal.id, cal.backgroundColor || GOOGLE_COLOR);
  }
  return items.map(cal => ({
    id: cal.id,
    name: cal.summary || cal.id,
    color: cal.backgroundColor || GOOGLE_COLOR,
    primary: !!cal.primary,
  }));
}

/**
 * Gibt die gespeicherten Google-Kalender mit enabled-Flag zurück.
 * @returns {Array<{id, name, color, enabled}>}
 */
function getCalendars() {
  const enabledIds = getEnabledCalendarIds();
  const rows = db.get().prepare("SELECT * FROM external_calendars WHERE source = 'google' ORDER BY name").all();
  return rows.map(row => ({
    id: row.external_id,
    name: row.name,
    color: row.color || GOOGLE_COLOR,
    enabled: enabledIds.includes(row.external_id),
  }));
}

/**
 * Aktualisiert, welche Google-Kalender synchronisiert werden.
 * @param {string[]} ids - Array von Kalender-IDs
 */
function setEnabledCalendars(ids) {
  cfgSet('google_enabled_calendars', JSON.stringify(ids));
}

function getEnabledCalendarIds() {
  const raw = cfgGet('google_enabled_calendars');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  return ['primary'];
}

/**
 * Bidirektionaler Sync über alle aktivierten Google-Kalender.
 * Inbound:  Google → lokale DB (Upsert via external_calendar_id)
 * Outbound: lokale Termine (external_source='local', external_calendar_id IS NULL) → primary
 */
async function sync() {
  const client   = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });

  const enabledIds = getEnabledCalendarIds();

  // --------------------------------------------------------
  // Inbound: Google → lokal (alle aktivierten Kalender)
  // --------------------------------------------------------
  for (const calId of enabledIds) {
    let calRefId = null;
    let calColor = GOOGLE_COLOR;
    try {
      const meta = await calendar.calendarList.get({ calendarId: calId });
      calColor = meta.data.backgroundColor || GOOGLE_COLOR;
      const calName = meta.data.summary || (calId === 'primary' ? 'Google Calendar' : calId);
      calRefId = upsertExternalCalendar('google', calId, calName, calColor);
    } catch (err) {
      log.warn(`Calendar metadata for ${calId} not accessible:`, err.message);
    }

    const tokenKey = `google_sync_token_${calId}`;
    // Migration: adopt old single-calendar token for primary
    let syncToken = cfgGet(tokenKey);
    if (calId === 'primary' && !syncToken) {
      const legacy = cfgGet('google_sync_token');
      if (legacy) { syncToken = legacy; cfgDel('google_sync_token'); }
    }

    let pageToken = undefined;
    let newSyncToken = null;

    do {
      const listParams = { calendarId: calId, singleEvents: true, pageToken };
      if (syncToken) {
        listParams.syncToken = syncToken;
      } else {
        listParams.timeMin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        listParams.timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      }

      let response;
      try {
        response = await calendar.events.list(listParams);
      } catch (err) {
        if (err.code === 410) {
          log.warn(`syncToken for ${calId} invalid - full resync.`);
          cfgDel(tokenKey);
          syncToken = null;
          continue;
        }
        throw err;
      }

      upsertGoogleEvents(response.data.items || [], calRefId, calColor);
      pageToken    = response.data.nextPageToken;
      newSyncToken = response.data.nextSyncToken || newSyncToken;
    } while (pageToken);

    if (newSyncToken) cfgSet(tokenKey, newSyncToken);
  }

  // --------------------------------------------------------
  // Outbound: lokal → Google (primary, oder erster aktivierter Kalender)
  // --------------------------------------------------------
  const outboundCalId = enabledIds.includes('primary') ? 'primary' : enabledIds[0];
  if (outboundCalId) {
    const localEvents = db.get().prepare(`
      SELECT * FROM calendar_events
      WHERE external_source = 'local' AND external_calendar_id IS NULL
    `).all();

    for (const event of localEvents) {
      try {
        const created = await calendar.events.insert({
          calendarId:  outboundCalId,
          requestBody: localEventToGoogle(event),
        });
        db.get().prepare(
          'UPDATE calendar_events SET external_calendar_id = ?, external_source = ? WHERE id = ?'
        ).run(created.data.id, 'google', event.id);
      } catch (err) {
        log.error(`Outbound error for event ${event.id}:`, err.message);
      }
    }
    log.info(`Sync completed - ${localEvents.length} local → Google (${outboundCalId}), inbound: ${enabledIds.join(', ')}.`);
  }

  cfgSet('google_last_sync', new Date().toISOString());
}

// --------------------------------------------------------
// Helfer: Google-Event in lokale DB upserten
// --------------------------------------------------------

function upsertGoogleEvents(items, calRefId = null, calColor = GOOGLE_COLOR) {
  const del = db.get().prepare(`
    DELETE FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'google'
  `);

  const insertOrUpdate = db.get().transaction((item) => {
    if (item.status === 'cancelled') {
      del.run(item.id);
      return;
    }

    const allDay      = !!(item.start?.date && !item.start?.dateTime);
    const startDt     = allDay ? item.start.date : (item.start?.dateTime || item.start?.date);
    const endDt       = allDay ? (item.end?.date || null) : (item.end?.dateTime || item.end?.date || null);
    const title       = item.summary || '(kein Titel)';
    const description = item.description || null;
    const location    = item.location    || null;
    const rrule       = item.recurrence  ? item.recurrence[0] : null;

    const existing = db.get().prepare(
      'SELECT id FROM calendar_events WHERE external_calendar_id = ? AND external_source = ?'
    ).get(item.id, 'google');

    if (existing) {
      db.get().prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
            all_day = ?, location = ?, recurrence_rule = ?, color = ?, calendar_ref_id = ?
        WHERE id = ?
      `).run(title, description, startDt, endDt, allDay ? 1 : 0, location, rrule, calColor, calRefId, existing.id);
    } else {
      db.get().prepare(`
        INSERT INTO calendar_events
          (title, description, start_datetime, end_datetime, all_day,
           location, color, external_calendar_id, external_source, recurrence_rule, calendar_ref_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'google', ?, ?, 1)
      `).run(title, description, startDt, endDt, allDay ? 1 : 0, location, calColor, item.id, rrule, calRefId);
    }
  });

  for (const item of items) {
    if (!item) continue;
    try {
      insertOrUpdate(item);
    } catch (err) {
      log.error(`Upsert error for event ${item?.id}:`, err.message);
    }
  }
}

// --------------------------------------------------------
// Helfer: lokales Event → Google Calendar Event Format
// --------------------------------------------------------

function localEventToGoogle(event) {
  const allDay = !!event.all_day;
  const gEvent = {
    summary:     event.title,
    description: event.description || undefined,
    location:    event.location    || undefined,
  };

  if (allDay) {
    gEvent.start = { date: event.start_datetime.slice(0, 10) };
    gEvent.end   = { date: event.end_datetime ? event.end_datetime.slice(0, 10) : event.start_datetime.slice(0, 10) };
  } else {
    gEvent.start = { dateTime: event.start_datetime, timeZone: 'Europe/Berlin' };
    gEvent.end   = { dateTime: event.end_datetime   || event.start_datetime, timeZone: 'Europe/Berlin' };
  }

  if (event.recurrence_rule) {
    gEvent.recurrence = [event.recurrence_rule];
  }

  return gEvent;
}

export { getAuthUrl, handleCallback, getStatus, disconnect, sync, fetchCalendars, getCalendars, setEnabledCalendars };
