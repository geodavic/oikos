/**
 * Modul: Wiederholungsregeln (Recurrence)
 * Zweck: RRULE-Subset-Parser (FREQ=DAILY/WEEKLY/MONTHLY, BYDAY, INTERVAL, UNTIL)
 *        + Berechnung des nächsten Fälligkeitsdatums für wiederkehrende Aufgaben
 * Abhängigkeiten: keine
 */

const DAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

/**
 * Parsed einen RRULE-String in ein Objekt.
 * Beispiel: "FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=1"
 * @param {string} rule
 * @returns {{ freq, interval, byday, until }|null}
 */
function parseRRule(rule) {
  if (!rule) return null;
  // Strip "RRULE:" prefix if present (ICS stores rules as "RRULE:FREQ=...")
  const raw = rule.startsWith('RRULE:') ? rule.slice(6) : rule;
  const parts = {};
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    parts[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
  }

  const freq     = parts.FREQ ?? null;
  const interval = parseInt(parts.INTERVAL ?? '1', 10) || 1;
  const byday    = (parts.BYDAY ?? '').split(',')
    .map((d) => DAY_MAP[d.trim().toUpperCase()])
    .filter((d) => d !== undefined);
  const until    = parts.UNTIL ? parseUntilDate(parts.UNTIL) : null;

  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

  return { freq, interval, byday, until };
}

function parseUntilDate(str) {
  // Akzeptiert YYYYMMDD oder YYYYMMDDTHHmmssZ
  const clean = str.replace(/[TZ]/g, '');
  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10) - 1;
  const d = parseInt(clean.slice(6, 8), 10);
  return new Date(Date.UTC(y, m, d));
}

/**
 * Berechnet das nächste Fälligkeitsdatum nach dem gegebenen Basisdatum.
 * @param {string} baseDateStr - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule       - RRULE-String
 * @returns {string|null}      - Nächstes Datum als YYYY-MM-DD oder null (Ende der Serie)
 */
function nextOccurrence(baseDateStr, rrule) {
  const parsed = parseRRule(rrule);
  if (!parsed || !baseDateStr) return null;

  const base = new Date(baseDateStr + 'T00:00:00Z');
  if (isNaN(base.getTime())) return null;

  const { freq, interval, byday, until } = parsed;
  const next = new Date(base);

  if (freq === 'DAILY') {
    next.setUTCDate(next.getUTCDate() + interval);

  } else if (freq === 'WEEKLY') {
    if (byday.length === 0) {
      // Kein BYDAY → selber Wochentag, nächste Woche
      next.setUTCDate(next.getUTCDate() + 7 * interval);
    } else {
      // Finde den nächsten passenden Wochentag (nach heute)
      const currentDay = base.getUTCDay();
      const sorted = [...byday].sort((a, b) => {
        const da = (a - currentDay + 7) % 7 || 7;
        const db = (b - currentDay + 7) % 7 || 7;
        return da - db;
      });
      // Tage bis zum nächsten Vorkommen (mind. 1, damit nicht derselbe Tag)
      let daysUntil = (sorted[0] - currentDay + 7) % 7;
      if (daysUntil === 0) {
        // Selber Wochentag → ganzes Intervall überspringen
        daysUntil = 7 * interval;
      } else if ((sorted[0] + 6) % 7 < (currentDay + 6) % 7) {
        // Wochengrenze überschritten (ISO-Woche MO–SO) → interval-1 Wochen extra überspringen
        daysUntil += 7 * (interval - 1);
      }
      next.setUTCDate(next.getUTCDate() + daysUntil);
    }

  } else if (freq === 'MONTHLY') {
    const targetDay = base.getUTCDate();
    next.setUTCMonth(next.getUTCMonth() + interval);
    // Monatsüberlauf korrigieren (z.B. 31. März + 1 Monat → 30. April)
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));

  } else if (freq === 'YEARLY') {
    const targetMonth = base.getUTCMonth();
    const targetDay   = base.getUTCDate();
    next.setUTCFullYear(next.getUTCFullYear() + interval);
    // Feb 29 in non-leap year → Feb 28
    next.setUTCMonth(targetMonth);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));
  }

  // UNTIL-Grenze prüfen
  if (until && next > until) return null;

  return next.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Addiert genau ein Wiederholungsintervall auf ein Datum (ohne BYDAY-Anker-Logik).
 * Dient als "Mindestabstand"-Maß für nextOccurrenceAfterCompletion - z.B. WEEKLY
 * interval=1 → +7 Tage, unabhängig vom BYDAY-Muster.
 * @param {string} dateStr - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule   - RRULE-String
 * @returns {string} - Datum + ein Intervall, als YYYY-MM-DD
 */
function addOneInterval(dateStr, rrule) {
  const parsed = parseRRule(rrule);
  const d = new Date(dateStr + 'T00:00:00Z');
  if (!parsed || isNaN(d.getTime())) return dateStr;

  const { freq, interval } = parsed;
  if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + interval);
  else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * interval);
  else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + interval);
  else if (freq === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + interval);

  return d.toISOString().slice(0, 10);
}

/**
 * Berechnet das nächste Fälligkeitsdatum nach Abschluss einer (ggf. überfälligen)
 * Aufgabe. Bei rechtzeitigem oder vorzeitigem Abschluss (completedAtStr <= dueDateStr)
 * entspricht das Ergebnis exakt nextOccurrence() - unverändertes Verhalten.
 * Bei verspätetem Abschluss wird so lange im Muster vorgerückt, bis mindestens ein
 * volles Intervall Abstand zum tatsächlichen Abschlussdatum besteht - so entsteht
 * nach dem Nachholen einer überfälligen Aufgabe nicht sofort die nächste Fälligkeit.
 * @param {string} dueDateStr    - ursprüngliches Fälligkeitsdatum (Anker der Serie)
 * @param {string} rrule         - RRULE-String
 * @param {string} completedAtStr - tatsächliches Abschlussdatum (YYYY-MM-DD)
 * @returns {string|null}
 */
function nextOccurrenceAfterCompletion(dueDateStr, rrule, completedAtStr) {
  const naive = nextOccurrence(dueDateStr, rrule);
  if (!naive || !completedAtStr || completedAtStr <= dueDateStr) return naive;

  const minDate = addOneInterval(completedAtStr, rrule);
  let candidate = naive;
  let iterations = 0;
  while (candidate && candidate < minDate && iterations < 1000) {
    candidate = nextOccurrence(candidate, rrule);
    iterations++;
  }
  return candidate;
}

/**
 * Expandiert eine Wiederholungsregel zu allen Vorkommen innerhalb eines Zeitfensters.
 * Gleiches Vorgehen wie expandRRULE in ics-parser.js (wiederholtes Vorrücken via
 * nextOccurrence, MAX_ITER-Schutz), aber ohne ICS-spezifische Zeit-/Dauer-Logik -
 * dient hier der Projektion künftiger Aufgaben-Vorkommen (noch nicht erzeugte Zeilen).
 * @param {string} anchorDateStr - Ankerdatum der Serie (z.B. tasks.due_date)
 * @param {string} rrule         - RRULE-String
 * @param {string} windowStart   - Fensterstart, inklusiv (YYYY-MM-DD)
 * @param {string} windowEnd     - Fensterende, exklusiv (YYYY-MM-DD)
 * @returns {string[]} - Vorkommen im Fenster als YYYY-MM-DD, aufsteigend sortiert
 */
function expandOccurrences(anchorDateStr, rrule, windowStart, windowEnd) {
  if (!anchorDateStr || !parseRRule(rrule)) return [];

  const results = [];
  let current = anchorDateStr;
  let iterations = 0;
  const MAX_ITER = 1500;

  while (current && current < windowEnd && iterations < MAX_ITER) {
    iterations++;
    if (current >= windowStart) results.push(current);
    const next = nextOccurrence(current, rrule);
    if (!next || next <= current) break;
    current = next;
  }

  return results;
}

export { parseRRule, nextOccurrence, addOneInterval, nextOccurrenceAfterCompletion, expandOccurrences };
