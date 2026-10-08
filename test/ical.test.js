import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, makeZone, rrule, foldLine, icalText } from '../src/ical.js';

const EASTERN = {
  keyName: 'Eastern Standard Time',
  rules: [{ flags: 2, start: 'Mon, 01 Jan 2007 00:00:00 GMT', bias: 300, standardBias: 0, daylightBias: -60,
    standardDate: { year: 0, month: 11, dayOfWeek: 0, day: 1, hour: 2, minute: 0 },
    daylightDate: { year: 0, month: 3, dayOfWeek: 0, day: 2, hour: 2, minute: 0 } }],
};
const TOKYO = { keyName: 'Tokyo Standard Time', rules: [{ flags: 2, start: null, bias: -540, standardBias: 0, daylightBias: 0,
  standardDate: { year: 0, month: 0, dayOfWeek: 0, day: 0, hour: 0, minute: 0 }, daylightDate: { year: 0, month: 0, dayOfWeek: 0, day: 0, hour: 0, minute: 0 } }] };

test('time zone offsets follow the TZDEFINITION rule (DST in summer)', () => {
  const z = makeZone(EASTERN, 2024);
  assert.equal(z.toLocal(new Date('2024-01-15T15:00:00Z')).toISOString(), '2024-01-15T10:00:00.000Z');
  assert.equal(z.toLocal(new Date('2024-07-15T15:00:00Z')).toISOString(), '2024-07-15T11:00:00.000Z');
  assert.equal(z.toUtc(new Date('2024-07-15T11:00:00Z')).toISOString(), '2024-07-15T15:00:00.000Z');
  const vt = z.vtimezone().join('\n');
  assert.match(vt, /RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/);
  assert.match(vt, /RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU/);
  assert.match(vt, /TZOFFSETTO:-0400/);
});

test('recurrence patterns to RRULE', () => {
  const w = [];
  const base = { calendarType: 0, firstDOW: 1, deletedInstanceDates: [], modifiedInstanceDates: [], startDate: 221957280, endDate: 222474240 };
  assert.equal(rrule({ recurrencePattern: { ...base, recurFrequency: 8203, patternType: 1, period: 2, patternTypeWeek: { dayOfWeekBits: 0x22 }, endType: 8226, occurrenceCount: 10 } }, null, w),
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;WKST=MO;COUNT=10');
  assert.equal(rrule({ recurrencePattern: { ...base, recurFrequency: 8202, patternType: 0, period: 2880, endType: 8227 } }, null, w), 'FREQ=DAILY;INTERVAL=2');
  assert.equal(rrule({ recurrencePattern: { ...base, recurFrequency: 8204, patternType: 3, period: 1, patternTypeMonthNth: { dayOfWeekBits: 0x10, n: 5 }, endType: 8227 } }, null, w),
    'FREQ=MONTHLY;INTERVAL=1;BYDAY=TH;BYSETPOS=-1');
  assert.equal(rrule({ recurrencePattern: { ...base, recurFrequency: 8205, patternType: 2, period: 12, patternTypeMonth: { day: 6 }, endType: 8227 } }, null, w),
    'FREQ=YEARLY;INTERVAL=1;BYMONTH=1;BYMONTHDAY=6');
  const until = rrule({ recurrencePattern: { ...base, recurFrequency: 8203, patternType: 1, period: 1, patternTypeWeek: { dayOfWeekBits: 32 }, endType: 8225 }, startTimeOffset: 720 }, makeZone(TOKYO, 2023), w);
  assert.match(until, /UNTIL=20231231T030000Z$/);
  assert.equal(rrule({ recurrencePattern: { ...base, calendarType: 6, patternType: 10 } }, null, w), null);
  assert.ok(w.length === 1);
});

const model = (cls, extra = {}) => ({
  messageClass: cls, subject: 'Plan; review, now', messageId: null,
  dates: { submit: new Date('2024-03-01T09:00:00Z'), creation: null, modification: null },
  appointment: { start: new Date('2024-07-15T15:00:00Z'), end: new Date('2024-07-15T16:00:00Z'), location: 'Room 1', globalId: 'ABCDEF', recur: null, tzStart: EASTERN, ...extra },
});

test('meeting request gives METHOD:REQUEST with organizer and attendees', () => {
  const w = [];
  const { ics, method } = buildCalendar(model('IPM.Schedule.Meeting.Request'), {
    organizer: { name: 'Org', email: 'org@x.test' },
    attendees: [{ name: 'A', email: 'a@x.test', type: 'to' }, { name: 'B', email: 'b@x.test', type: 'cc' }, { name: 'NoMail', email: null, type: 'to' }],
    body: 'Agenda\nline',
  }, w);
  assert.equal(method, 'REQUEST');
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;TZID=Eastern Standard Time:20240715T110000/);
  assert.ok(ics.includes('SUMMARY:Plan\\; review\\, now'), ics);
  assert.match(ics, /ORGANIZER;CN="Org":mailto:org@x.test/);
  assert.match(unfolded, /ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:b@x.test/);
  assert.ok(!ics.includes('NoMail'));
  assert.ok(ics.includes('DESCRIPTION:Agenda\\nline'));
  assert.match(ics, /UID:ABCDEF/);
});

test('cancel, reply and all-day', () => {
  assert.equal(buildCalendar(model('IPM.Schedule.Meeting.Canceled'), { organizer: null, attendees: [], body: '' }, []).method, 'CANCEL');
  const r = buildCalendar(model('IPM.Schedule.Meeting.Resp.Pos'), { organizer: { name: 'Me', email: 'me@x.test' }, attendees: [], body: '' }, []);
  assert.match(r.ics, /ATTENDEE;CN="Me";PARTSTAT=ACCEPTED:mailto:me@x.test/);
  const allDay = buildCalendar(model('IPM.Appointment', { start: new Date('2024-01-10T05:00:00Z'), end: new Date('2024-01-11T05:00:00Z') }), { organizer: null, attendees: [], body: '' }, []);
  assert.match(allDay.ics, /DTSTART;VALUE=DATE:20240110/);
  assert.match(allDay.ics, /DTEND;VALUE=DATE:20240111/);
  assert.equal(buildCalendar(model('IPM.Appointment', { start: null }), { attendees: [] }, []), null);
});

test('content lines fold at 75 octets without splitting characters', () => {
  const line = 'DESCRIPTION:' + icalText('日本語'.repeat(40));
  const folded = foldLine(line);
  for (const l of folded.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), line);
});
