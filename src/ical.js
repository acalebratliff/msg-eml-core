// iCalendar (RFC 5545) for Outlook calendar items and meeting messages,
// built from the appointment properties msgreader exposes (MS-OXOCAL).

const MIN_1601_TO_1970 = 194074560; // minutes between 1601-01-01 and 1970-01-01

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * Remove every control character (CR, LF, NUL, ...) from a value that goes
 * into a property parameter or a non-TEXT value (CN, TZID, UID), where no
 * escaping exists; a CR/LF there would start a new content line (review M4).
 */
export function icalSafe(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}

/** Escape a TEXT value (RFC 5545 3.3.11); other control characters are removed. */
export function icalText(s) {
  return String(s ?? '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets (RFC 5545 3.1), never splitting a character. */
export function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
      limit = 75;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

const utcStamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
// "naive" dates hold local wall-clock time in their UTC fields
const localStamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const dateStamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

const minutesToNaive = (min) => new Date((min - MIN_1601_TO_1970) * 60000);

/** Nth (1-4, 5 = last) weekday of a month, as a naive Date at hh:mm. */
function nthWeekday(year, month, dayOfWeek, n, hour = 0, minute = 0) {
  if (n >= 5) {
    const last = new Date(Date.UTC(year, month, 0));
    const diff = (last.getUTCDay() - dayOfWeek + 7) % 7;
    return new Date(Date.UTC(year, month - 1, last.getUTCDate() - diff, hour, minute));
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const diff = (dayOfWeek - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + diff + (n - 1) * 7, hour, minute));
}

/** Pick the TZDEFINITION rule in force for a year. */
function ruleFor(tzdef, year) {
  if (!tzdef || !tzdef.rules || !tzdef.rules.length) return null;
  let best = null;
  for (const r of tzdef.rules) {
    const y = r.start ? new Date(r.start).getUTCFullYear() : 0;
    if (y <= year && (!best || y >= best._y)) best = { ...r, _y: y };
  }
  return best || tzdef.rules.find((r) => r.flags & 2) || tzdef.rules[0];
}

/** Timezone helper from a TZDEFINITION (msgreader shape). */
export function makeZone(tzdef, year) {
  const rule = ruleFor(tzdef, year);
  if (!rule) return null;
  const std = -(rule.bias + rule.standardBias); // minutes east of UTC
  const dst = -(rule.bias + rule.daylightBias);
  const hasDst = !!(rule.standardDate && rule.standardDate.month && rule.daylightDate && rule.daylightDate.month);
  const id = icalSafe(tzdef.keyName || 'Custom').replace(/[";:,]/g, ' ').trim().slice(0, 200) || 'Custom';
  function transitions(y) {
    const sd = rule.standardDate;
    const dd = rule.daylightDate;
    const dstStartLocal = nthWeekday(y, dd.month, dd.dayOfWeek, dd.day, dd.hour, dd.minute);
    const stdStartLocal = nthWeekday(y, sd.month, sd.dayOfWeek, sd.day, sd.hour, sd.minute);
    // local wall time -> UTC: the clock before each transition applies
    return { dstStart: dstStartLocal.getTime() - std * 60000, stdStart: stdStartLocal.getTime() - dst * 60000 };
  }
  function offsetAt(utcMs) {
    if (!hasDst) return std;
    const y = new Date(utcMs + std * 60000).getUTCFullYear();
    const t = transitions(y);
    const inDst = t.dstStart < t.stdStart ? utcMs >= t.dstStart && utcMs < t.stdStart : utcMs >= t.dstStart || utcMs < t.stdStart;
    return inDst ? dst : std;
  }
  const toLocal = (utc) => new Date(utc.getTime() + offsetAt(utc.getTime()) * 60000);
  const toUtc = (naive) => {
    // two-step: guess with standard offset, then correct
    let t = naive.getTime() - std * 60000;
    t = naive.getTime() - offsetAt(t) * 60000;
    return new Date(t);
  };
  const fmtOff = (m) => `${m < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(m) / 60))}${pad(Math.abs(m) % 60)}`;
  function vtimezone() {
    const L = ['BEGIN:VTIMEZONE', `TZID:${id}`];
    if (!hasDst) {
      L.push('BEGIN:STANDARD', 'DTSTART:16010101T000000', `TZOFFSETFROM:${fmtOff(std)}`, `TZOFFSETTO:${fmtOff(std)}`, 'END:STANDARD');
    } else {
      const sd = rule.standardDate;
      const dd = rule.daylightDate;
      const byday = (s) => `${s.day >= 5 ? -1 : s.day}${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][s.dayOfWeek]}`;
      const s0 = nthWeekday(1970, sd.month, sd.dayOfWeek, sd.day, sd.hour, sd.minute);
      const d0 = nthWeekday(1970, dd.month, dd.dayOfWeek, dd.day, dd.hour, dd.minute);
      L.push('BEGIN:STANDARD', `DTSTART:${localStamp(s0)}`, `RRULE:FREQ=YEARLY;BYMONTH=${sd.month};BYDAY=${byday(sd)}`,
        `TZOFFSETFROM:${fmtOff(dst)}`, `TZOFFSETTO:${fmtOff(std)}`, 'END:STANDARD');
      L.push('BEGIN:DAYLIGHT', `DTSTART:${localStamp(d0)}`, `RRULE:FREQ=YEARLY;BYMONTH=${dd.month};BYDAY=${byday(dd)}`,
        `TZOFFSETFROM:${fmtOff(std)}`, `TZOFFSETTO:${fmtOff(dst)}`, 'END:DAYLIGHT');
    }
    L.push('END:VTIMEZONE');
    return L;
  }
  return { id, toLocal, toUtc, vtimezone };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const bitsToDays = (bits) => DAYS.filter((_, i) => bits & (1 << i)).join(',');

/** RRULE value from an AppointmentRecur pattern, or null if not expressible. */
export function rrule(recur, zone, warnings) {
  const p = recur && recur.recurrencePattern;
  if (!p) return null;
  if (p.calendarType && p.calendarType !== 1 && p.calendarType !== 2 && p.calendarType !== 0) {
    warnings.push('recurrence uses a non-Gregorian calendar; repeat rule not written');
    return null;
  }
  const parts = [];
  const yearly = p.recurFrequency === 8205;
  switch (p.patternType) {
    case 0: // Day
      parts.push('FREQ=DAILY', `INTERVAL=${Math.max(1, Math.round(p.period / 1440))}`);
      break;
    case 1: // Week
      parts.push('FREQ=WEEKLY', `INTERVAL=${Math.max(1, p.period)}`);
      if (p.patternTypeWeek) parts.push(`BYDAY=${bitsToDays(p.patternTypeWeek.dayOfWeekBits)}`);
      parts.push(`WKST=${DAYS[p.firstDOW] || 'SU'}`);
      break;
    case 2: // Month
    case 4: { // MonthEnd
      const day = p.patternType === 4 ? -1 : (p.patternTypeMonth ? p.patternTypeMonth.day : 1);
      if (yearly) {
        parts.push('FREQ=YEARLY', `INTERVAL=${Math.max(1, Math.round(p.period / 12))}`);
        parts.push(`BYMONTH=${minutesToNaive(p.startDate).getUTCMonth() + 1}`);
      } else parts.push('FREQ=MONTHLY', `INTERVAL=${Math.max(1, p.period)}`);
      parts.push(`BYMONTHDAY=${day === 31 ? -1 : day}`);
      break;
    }
    case 3: { // MonthNth
      const nth = p.patternTypeMonthNth || { dayOfWeekBits: 0, n: 1 };
      if (yearly) {
        parts.push('FREQ=YEARLY', `INTERVAL=${Math.max(1, Math.round(p.period / 12))}`);
        parts.push(`BYMONTH=${minutesToNaive(p.startDate).getUTCMonth() + 1}`);
      } else parts.push('FREQ=MONTHLY', `INTERVAL=${Math.max(1, p.period)}`);
      parts.push(`BYDAY=${bitsToDays(nth.dayOfWeekBits)}`, `BYSETPOS=${nth.n >= 5 ? -1 : nth.n}`);
      break;
    }
    default:
      warnings.push(`recurrence pattern type ${p.patternType} is not supported; repeat rule not written`);
      return null;
  }
  if (p.endType === 8226 && p.occurrenceCount > 0) parts.push(`COUNT=${p.occurrenceCount}`);
  else if (p.endType === 8225 && p.endDate) {
    const lastLocal = minutesToNaive(p.endDate + (recur.startTimeOffset || 0));
    const until = zone ? zone.toUtc(lastLocal) : lastLocal;
    parts.push(`UNTIL=${utcStamp(until)}`);
  }
  return parts.join(';');
}

/**
 * Build a VCALENDAR for a calendar item or meeting message.
 * @param {object} m model
 * @param {{organizer:{name,email}|null, attendees:Array<{name,email,type}>, body:string}} people
 * @returns {{ics:string, method:string}|null}
 */
export function buildCalendar(m, people, warnings) {
  const a = m.appointment;
  if (!a || !a.start) return null;
  const cls = m.messageClass || '';
  let method = 'PUBLISH';
  let status = null;
  let partstat = null;
  if (/^IPM\.Schedule\.Meeting\.Request/i.test(cls)) method = 'REQUEST';
  else if (/^IPM\.Schedule\.Meeting\.Canceled/i.test(cls)) { method = 'CANCEL'; status = 'CANCELLED'; }
  else if (/^IPM\.Schedule\.Meeting\.Resp\.Pos/i.test(cls)) { method = 'REPLY'; partstat = 'ACCEPTED'; }
  else if (/^IPM\.Schedule\.Meeting\.Resp\.Neg/i.test(cls)) { method = 'REPLY'; partstat = 'DECLINED'; }
  else if (/^IPM\.Schedule\.Meeting\.Resp\.Tent/i.test(cls)) { method = 'REPLY'; partstat = 'TENTATIVE'; }

  const start = a.start;
  const end = a.end && a.end >= a.start ? a.end : a.start;
  const tzdef = a.recur ? (a.tzRecur || a.tzStart) : a.tzStart;
  const zone = tzdef ? makeZone(tzdef, start.getUTCFullYear()) : null;

  const L = ['BEGIN:VCALENDAR', 'PRODID:-//msg-eml-core//EN', 'VERSION:2.0', `METHOD:${method}`];
  if (zone) L.push(...zone.vtimezone());

  const allDay = zone && (() => {
    const ls = zone.toLocal(start);
    const le = zone.toLocal(end);
    const midnight = (d) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
    return midnight(ls) && midnight(le) && end > start && (le - ls) % 86400000 === 0;
  })();
  const dt = (name, d) => {
    if (allDay) return `${name};VALUE=DATE:${dateStamp(zone.toLocal(d))}`;
    if (zone) return `${name};TZID=${zone.id}:${localStamp(zone.toLocal(d))}`;
    return `${name}:${utcStamp(d)}`;
  };
  const stamp = m.dates.submit || m.dates.creation || m.dates.modification || start;
  const uidSrc = icalSafe(a.globalId || (m.messageId ? String(m.messageId).replace(/[<>]/g, '') : '')).replace(/\s+/g, '');
  const uid = uidSrc || `${utcStamp(start)}-${(m.subject || '').length}@msg-eml-core`;

  const event = (extra) => {
    const E = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(stamp)}`];
    E.push(...extra);
    return E;
  };
  const main = [dt('DTSTART', start), dt('DTEND', end)];
  if (m.subject) main.push(`SUMMARY:${icalText(m.subject)}`);
  if (a.location) main.push(`LOCATION:${icalText(a.location)}`);
  if (people.body && people.body.trim()) main.push(`DESCRIPTION:${icalText(people.body)}`);
  if (status) main.push(`STATUS:${status}`);
  const cn = (p) => {
    const n = icalSafe(p.name).replace(/"/g, "'");
    return n ? `;CN="${n}"` : '';
  };
  const mailto = (p) => `mailto:${icalSafe(p.email).replace(/\s+/g, '')}`;
  if (method === 'REPLY') {
    // In a reply the sender is the attendee answering, and the meeting
    // organizer is the person it is sent to; RFC 5546 3.2.3 requires
    // ORGANIZER in a REPLY, so it is written when known (review minor 10).
    const org = people.attendees.find((at) => at.email && at.type !== 'cc' && at.type !== 'bcc');
    if (org) main.push(`ORGANIZER${cn(org)}:${mailto(org)}`);
    else warnings.push('meeting response: the organizer is not known; ORGANIZER not written');
    if (people.organizer && people.organizer.email) {
      main.push(`ATTENDEE${cn(people.organizer)};PARTSTAT=${partstat}:${mailto(people.organizer)}`);
    }
  } else {
    if (people.organizer && people.organizer.email) main.push(`ORGANIZER${cn(people.organizer)}:${mailto(people.organizer)}`);
    for (const at of people.attendees) {
      if (!at.email) continue;
      const role = at.type === 'cc' ? 'OPT-PARTICIPANT' : at.type === 'bcc' ? 'NON-PARTICIPANT' : 'REQ-PARTICIPANT';
      const rsvp = method === 'REQUEST' ? ';RSVP=TRUE' : '';
      main.push(`ATTENDEE${cn(at)};ROLE=${role};PARTSTAT=NEEDS-ACTION${rsvp}:${mailto(at)}`);
    }
  }
  if (a.recur) {
    const r = rrule(a.recur, zone, warnings);
    if (r) {
      main.push(`RRULE:${r}`);
      const p = a.recur.recurrencePattern;
      const modified = new Set(p.modifiedInstanceDates || []);
      for (const dmin of p.deletedInstanceDates || []) {
        if (modified.has(dmin)) continue;
        const local = minutesToNaive(dmin + (a.recur.startTimeOffset || 0));
        main.push(allDay ? `EXDATE;VALUE=DATE:${dateStamp(local)}` : zone ? `EXDATE;TZID=${zone.id}:${localStamp(local)}` : `EXDATE:${utcStamp(local)}`);
      }
    }
  }
  L.push(...event(main), 'END:VEVENT');

  // Modified occurrences (exceptions) as separate VEVENTs with RECURRENCE-ID.
  if (a.recur && a.recur.exceptionInfo && zone && !allDay) {
    for (const ex of a.recur.exceptionInfo) {
      const s = minutesToNaive(ex.startDateTime);
      const e = minutesToNaive(ex.endDateTime);
      const o = minutesToNaive(ex.originalStartTime);
      const X = [`RECURRENCE-ID;TZID=${zone.id}:${localStamp(o)}`, `DTSTART;TZID=${zone.id}:${localStamp(s)}`, `DTEND;TZID=${zone.id}:${localStamp(e)}`];
      X.push(`SUMMARY:${icalText(ex.subject != null ? ex.subject : m.subject || '')}`);
      if (ex.location != null || a.location) X.push(`LOCATION:${icalText(ex.location != null ? ex.location : a.location)}`);
      L.push(...event(X), 'END:VEVENT');
    }
  }
  L.push('END:VCALENDAR');
  return { ics: L.map(foldLine).join('\r\n') + '\r\n', method };
}
