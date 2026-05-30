function pad2(n) {
  return String(n).padStart(2, '0');
}

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizedMonthDay(birthDate, year) {
  const [, monthStr, dayStr] = String(birthDate).split('-');
  const month = parseInt(monthStr, 10);
  let day = parseInt(dayStr, 10);
  if (month === 2 && day === 29 && !leapYear(year)) day = 28;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function nextBirthdayDate(birthDate, from = new Date()) {
  const now = from instanceof Date ? from : new Date(from);
  const thisYear = normalizedMonthDay(birthDate, now.getFullYear());
  const today = now.toISOString().slice(0, 10);
  return thisYear >= today
    ? thisYear
    : normalizedMonthDay(birthDate, now.getFullYear() + 1);
}

function nextBirthdayAge(birthDate, from = new Date()) {
  const next = nextBirthdayDate(birthDate, from);
  return parseInt(next.slice(0, 4), 10) - parseInt(String(birthDate).slice(0, 4), 10);
}

function daysUntilBirthday(birthDate, from = new Date()) {
  const now = from instanceof Date ? from : new Date(from);
  const next = nextBirthdayDate(birthDate, now);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nextUtc = Date.UTC(
    parseInt(next.slice(0, 4), 10),
    parseInt(next.slice(5, 7), 10) - 1,
    parseInt(next.slice(8, 10), 10),
  );
  return Math.round((nextUtc - todayUtc) / 86400000);
}

function getOffsetMinutes(birthday) {
  if (birthday.reminder_offset === 'custom') {
    const amount = parseInt(birthday.reminder_custom_amount, 10) || 1;
    const unit = birthday.reminder_custom_unit || 'days';
    if (unit === 'weeks') return amount * 10080;
    if (unit === 'days') return amount * 1440;
    if (unit === 'hours') return amount * 60;
    return amount;
  }
  return parseInt(birthday.reminder_offset, 10) || 0;
}

function birthdayReminderAt(birthDate, offsetMin = 0, from = new Date()) {
  const next = nextBirthdayDate(birthDate, from);
  const baseTime = new Date(`${next}T12:00:00Z`).getTime();
  return new Date(baseTime - (offsetMin || 0) * 60000).toISOString();
}

function syncBirthdayReminder(database, birthday, from = new Date()) {
  if (birthday.reminder_offset === '') {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'birthday' AND entity_id = ? AND created_by = ?
    `).run(birthday.id, birthday.created_by);
    return null;
  }

  const offsetMin = getOffsetMinutes(birthday);
  const desired = birthdayReminderAt(birthday.birth_date, offsetMin, from);
  const existing = database.prepare(`
    SELECT * FROM reminders
    WHERE entity_type = 'birthday' AND entity_id = ? AND created_by = ?
    ORDER BY created_at DESC
  `).all(birthday.id, birthday.created_by);

  const active = existing.find((row) => row.dismissed === 0);
  if (active && active.remind_at === desired) return active.id;

  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'birthday' AND entity_id = ? AND created_by = ?
  `).run(birthday.id, birthday.created_by);

  const result = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('birthday', ?, ?, ?)
  `).run(birthday.id, desired, birthday.created_by);

  return result.lastInsertRowid;
}

function syncBirthdayArtifacts(database, birthday, from = new Date()) {
  if (birthday.calendar_event_id) {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(birthday.calendar_event_id, birthday.created_by);
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(birthday.calendar_event_id);
    database.prepare('UPDATE birthdays SET calendar_event_id = NULL WHERE id = ?').run(birthday.id);
  }
  syncBirthdayReminder(database, birthday, from);
  return { ...birthday, calendar_event_id: null };
}

function deleteBirthdayArtifacts(database, birthday) {
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'birthday' AND entity_id = ? AND created_by = ?
  `).run(birthday.id, birthday.created_by);
  if (birthday.calendar_event_id) {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(birthday.calendar_event_id, birthday.created_by);
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(birthday.calendar_event_id);
  }
}

function hydrateBirthday(row, from = new Date()) {
  const next_birthday = nextBirthdayDate(row.birth_date, from);
  return {
    ...row,
    next_birthday,
    next_age: nextBirthdayAge(row.birth_date, from),
    days_until: daysUntilBirthday(row.birth_date, from),
  };
}

function syncAllBirthdayReminders(database, userId, from = new Date()) {
  const birthdays = database.prepare(`
    SELECT * FROM birthdays WHERE created_by = ? ORDER BY birth_date ASC
  `).all(userId);
  birthdays.forEach((birthday) => {
    if (birthday.calendar_event_id) {
      database.prepare(`
        DELETE FROM reminders
        WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      `).run(birthday.calendar_event_id, birthday.created_by);
      database.prepare('DELETE FROM calendar_events WHERE id = ?').run(birthday.calendar_event_id);
      database.prepare('UPDATE birthdays SET calendar_event_id = NULL WHERE id = ?').run(birthday.id);
    }
    syncBirthdayReminder(database, birthday, from);
  });
}

export {
  birthdayReminderAt,
  daysUntilBirthday,
  deleteBirthdayArtifacts,
  hydrateBirthday,
  nextBirthdayAge,
  nextBirthdayDate,
  syncAllBirthdayReminders,
  syncBirthdayArtifacts,
};
