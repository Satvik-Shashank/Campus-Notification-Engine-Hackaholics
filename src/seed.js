'use strict';

const fs = require('node:fs');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createEngine } = require('./engine');

/**
 * Campus seed: departments, courses, clubs, residences, ~180 students, the university's workflows,
 * and three days of history. History is produced by replaying events through the REAL engine on a
 * controlled clock (fan-out, digests, preferences, delivery), never by inserting finished rows.
 * Safe to run repeatedly: history is only replayed into an empty campus.
 */

const FIRST = ['Aditi', 'Rohan', 'Meera', 'Arjun', 'Sana', 'Kabir', 'Priya', 'Vikram', 'Ananya', 'Ishaan', 'Neha', 'Dev', 'Zara', 'Aarav',
  'Tara', 'Nikhil', 'Riya', 'Omar', 'Kavya', 'Siddharth', 'Leah', 'Farhan', 'Isha', 'Manav', 'Diya', 'Rahul', 'Sneha', 'Yash', 'Aisha', 'Karan'];
const LAST = ['Rao', 'Mehta', 'Iyer', 'Khan', 'Sharma', 'Das', 'Nair', 'Gupta', 'Fernandes', 'Reddy', 'Joshi', 'Menon', 'Bose', 'Kapoor', 'Pillai', 'Singh'];
const DEPTS = [
  ['CSE', 'Computer Science & Engineering'], ['ECE', 'Electronics & Communication'], ['ME', 'Mechanical Engineering'],
  ['CE', 'Civil Engineering'], ['BBA', 'Business Administration'],
];
const COURSES = [
  ['CS301', 'Database Management Systems', 'CSE', 3], ['CS302', 'Operating Systems', 'CSE', 3], ['CS204', 'Data Structures', 'CSE', 2],
  ['EC301', 'Signals & Systems', 'ECE', 3], ['ME210', 'Thermodynamics', 'ME', 2], ['MA201', 'Discrete Mathematics', 'CSE', 2],
  ['CE305', 'Structural Analysis', 'CE', 3], ['BB220', 'Financial Accounting', 'BBA', 2],
];
const CLUBS = [
  ['coding', 'Coding Club', 'Contests, hack nights and interview prep sessions.'],
  ['robotics', 'Robotics Society', 'Builds, workshops and competition updates.'],
  ['basketball', 'Basketball Team', 'Practice schedules, matches and tryouts.'],
  ['music', 'Music Circle', 'Jam sessions, open mics and the annual concert.'],
];
const RESIDENCES = [['H1', 'Hostel 1 (Aravali)'], ['H2', 'Hostel 2 (Nilgiri)'], ['H3', 'Hostel 3 (Shivalik)'], ['H4', 'Hostel 4 (Vindhya)']];

const both = (subject, body) => [{ type: 'in-app', subject, body }, { type: 'email', subject, body }];

const WORKFLOWS = {
  'exam-schedule-change': {
    name: 'Exam schedule change', category: 'academic', priority: 'high', correlationKey: 'course',
    description: 'Room, time or date changes for examinations. Related changes within 5 minutes are combined.',
    criticalRules: [{ field: 'minutesUntilExam', op: 'lt', value: 60 }],
    primaryAction: { label: 'View updated timetable', url: '/timetable/{{course}}' },
    secondaryAction: { label: 'Add to calendar', url: '/calendar/{{course}}' },
    steps: [{ type: 'digest', windowMs: 5 * 60 * 1000, digestKey: 'course' }, ...both('{{title}}', '{{summary}}')],
  },
  'class-cancellation': {
    name: 'Class cancellation', category: 'academic', priority: 'normal', correlationKey: 'course',
    description: 'A scheduled lecture, lab or tutorial will not take place.',
    primaryAction: { label: 'View course page', url: '/courses/{{course}}' },
    steps: both('{{title}}', '{{summary}}'),
  },
  'assignment-deadline': {
    name: 'Assignment deadline', category: 'academic', priority: 'normal', correlationKey: 'course',
    description: 'Upcoming submission deadlines and extensions.',
    primaryAction: { label: 'Open assignment', url: '/courses/{{course}}/assignments' },
    steps: both('{{title}}', '{{summary}}'),
  },
  'campus-closure': {
    name: 'Campus closure', category: 'campus', critical: true,
    description: 'The campus or a building is closed. Always delivered, regardless of preferences or Focus Mode.',
    primaryAction: { label: 'Read official notice', url: '/notices/closure' },
    steps: both('{{title}}', '{{summary}}'),
  },
  'security-alert': {
    name: 'Security alert', category: 'campus', critical: true,
    description: 'Safety instructions from Campus Security. Always delivered.',
    primaryAction: { label: 'Safety instructions', url: '/safety' },
    steps: both('{{title}}', '{{summary}}'),
  },
  'transport-update': {
    name: 'Campus transport', category: 'campus', priority: 'normal', correlationKey: 'route',
    description: 'Shuttle delays, route changes and service suspensions.',
    primaryAction: { label: 'Live shuttle map', url: '/transport' },
    steps: [{ type: 'in-app', subject: '{{title}}', body: '{{summary}}' }],
  },
  'facilities-notice': {
    name: 'Facilities notice', category: 'campus', priority: 'low', correlationKey: 'facility',
    description: 'Library hours, maintenance and building works.',
    steps: [{ type: 'in-app', subject: '{{title}}', body: '{{summary}}' }],
  },
  'university-event': {
    name: 'University event', category: 'events', priority: 'normal', correlationKey: 'eventId',
    description: 'Talks, fests, workshops and convocation.',
    primaryAction: { label: 'Register', url: '/events/{{eventId}}' },
    secondaryAction: { label: 'Add to calendar', url: '/calendar/{{eventId}}' },
    steps: both('{{title}}', '{{summary}}'),
  },
  'club-announcement': {
    name: 'Club announcement', category: 'clubs', priority: 'low', correlationKey: 'eventId',
    description: 'Updates from student clubs and teams you follow.',
    primaryAction: { label: 'RSVP', url: '/clubs/{{club}}' },
    steps: [{ type: 'in-app', subject: '{{title}}', body: '{{summary}}' }],
  },
  'fee-reminder': {
    name: 'Fee reminder', category: 'administrative', priority: 'high', correlationKey: 'term',
    description: 'Tuition, hostel and examination fee deadlines.',
    primaryAction: { label: 'Pay fees', url: '/fees' },
    secondaryAction: { label: 'Download invoice', url: '/fees/invoice' },
    steps: both('{{title}}', '{{summary}}'),
  },
  'admin-notice': {
    name: 'University announcement', category: 'administrative', priority: 'normal', correlationKey: 'noticeId',
    description: 'Registrar and Dean of Students announcements.',
    primaryAction: { label: 'Read announcement', url: '/notices/{{noticeId}}' },
    steps: both('{{title}}', '{{summary}}'),
  },
};

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function seedCatalogue(engine) {
  const { subscribers, workflows } = engine.ctx;
  for (const [id, def] of Object.entries(WORKFLOWS)) workflows.upsert(id, def);
  for (const [code, name] of DEPTS) subscribers.upsertTopic(`dept:${code}`, { name, kind: 'department', followable: false, description: `All students in ${name}.` });
  for (let y = 1; y <= 4; y += 1) subscribers.upsertTopic(`year:${y}`, { name: `Year ${y}`, kind: 'year', followable: false, description: `All year ${y} students.` });
  for (const [code, name] of COURSES) subscribers.upsertTopic(`course:${code}`, { name: `${code} · ${name}`, kind: 'course', followable: false, description: `Students enrolled in ${name}.` });
  for (const [k, name, d] of CLUBS) subscribers.upsertTopic(`club:${k}`, { name, kind: 'club', description: d });
  for (const [k, name] of RESIDENCES) subscribers.upsertTopic(`residence:${k}`, { name, kind: 'residence', followable: false, description: `Residents of ${name}.` });
  subscribers.upsertTopic('service:transport', { name: 'Campus Transport', kind: 'service', description: 'Shuttle delays, route changes and night service.' });
  subscribers.upsertTopic('service:library', { name: 'Central Library', kind: 'service', description: 'Opening hours, holds and quiet-zone updates.' });
}

function seedStudents(engine) {
  const { subscribers, db } = engine.ctx;
  const r = rng(7);
  const ids = [];
  db.tx(() => {
    let n = 0;
    for (const [dept] of DEPTS) {
      for (let year = 1; year <= 4; year += 1) {
        for (let k = 0; k < 9; k += 1) {
          n += 1;
          const first = FIRST[(n * 7) % FIRST.length];
          const last = LAST[(n * 5) % LAST.length];
          const id = n === 1 ? 'student_001' : `${dept}${22 + (4 - year)}${String(100 + n).slice(-3)}`;
          // student_001 is the primary sign-in account: Aditi Rao, CSE, year 3.
          const isMain = n === 1;
          const s = subscribers.upsert(id, {
            email: `${(isMain ? 'aditi.rao' : `${first}.${last}${n}`).toLowerCase()}@student.srm.example`,
            firstName: isMain ? 'Aditi' : first, lastName: isMain ? 'Rao' : last,
            department: isMain ? 'CSE' : dept, year: isMain ? 3 : year, program: 'B.Tech',
          });
          const d = isMain ? 'CSE' : dept;
          const y = isMain ? 3 : year;
          const join = (t) => db.run('INSERT OR IGNORE INTO topic_members (topic, subscriber_id) VALUES (?,?)', t, s.id);
          join(`dept:${d}`); join(`year:${y}`);
          for (const [code, , cd, cy] of COURSES) if (cd === d && (cy === y || (isMain && cy === 2 && code === 'MA201'))) join(`course:${code}`);
          join(`residence:${RESIDENCES[n % 4][0]}`);
          if (isMain || r() < 0.35) join('club:coding');
          if (r() < 0.2) join(`club:${CLUBS[1 + (n % 3)][0]}`);
          if (isMain || r() < 0.6) join('service:transport');
          if (r() < 0.4) join('service:library');
          ids.push(id);
        }
      }
    }
  });
  return ids;
}

/** Three days of real campus traffic, replayed through the engine on a controlled clock. */
async function seedHistory(engine, clock) {
  const { ctx } = engine;
  const H = 3600 * 1000;
  const now = clock.now();
  const at = (hoursAgo) => now - hoursAgo * H;
  const iso = (hoursFromNow) => new Date(now + hoursFromNow * H).toISOString();
  const plan = [
    [70, 'admin-notice', { type: 'broadcast' }, { noticeId: 'N-2041', title: 'Mid-semester feedback is open', summary: 'Share anonymous feedback on each of your courses before Friday, 6 PM. It takes about 5 minutes.' }],
    [66, 'fee-reminder', { type: 'topic', topics: ['year:3', 'year:4'] }, { term: 'ODD-26', title: 'Hostel fee due in 7 days', summary: 'The hostel fee for the odd semester (Rs. 48,500) is due on 13 October. A late fee applies after the due date.' }],
    [52, 'university-event', { type: 'broadcast' }, { eventId: 'techfest-26', eventDate: iso(52), title: 'Techfest 2026 registrations are open', summary: 'Three days of talks, workshops and a 24-hour hackathon in the Main Auditorium. Registration closes on 14 October.' }],
    [48, 'club-announcement', { type: 'topic', topic: 'club:coding' }, { club: 'coding', eventId: 'cc-contest-14', eventDate: iso(30), title: 'Weekly contest: graphs edition', summary: 'Thursday, 7 PM in Lab 3. Two-hour contest, four problems. Bring your laptop.' }],
    [40, 'facilities-notice', { type: 'topic', topic: 'service:library' }, { facility: 'library', title: 'Library open till midnight during exams', summary: 'From 10 October the Central Library stays open until 12 AM. The silent study floor is on Level 3.' }],
    [30, 'class-cancellation', { type: 'topic', topic: 'course:CS302' }, { course: 'CS302', title: 'CS302 lecture cancelled on Thursday', summary: 'Prof. Menon is at a conference. The lecture will be made up on Saturday, 11 AM, in AB1-204.' }],
    [26, 'assignment-deadline', { type: 'topic', topic: 'course:CS301' }, { course: 'CS301', title: 'DBMS assignment 3 due Friday', summary: 'Normalisation and indexing exercises. Submit on the course portal by Friday, 11:59 PM.' }],
    [20, 'transport-update', { type: 'topic', topic: 'service:transport' }, { route: '4', title: 'Shuttle Route 4 delayed by 15 minutes', summary: 'Road work near the North Gate. Route 4 departures run about 15 minutes late this evening.' }],
    [8, 'security-alert', { type: 'topic', topic: 'residence:H2' }, { title: 'Fire drill in Hostel 2 at 7 PM', summary: 'A scheduled fire drill will take place at 7 PM. Please follow the wardens to the assembly point near Gate B.' }],
  ];
  // The exam change: four related updates within five minutes, combined into a single digest.
  const exam = [
    [3.2, { title: 'DBMS end-semester exam rescheduled', summary: 'Time moved from 10:00 AM to 2:00 PM.', changes: [{ label: 'Time', from: '10:00 AM', to: '2:00 PM' }] }],
    [3.18, { title: 'DBMS exam room changed', summary: 'Room moved from AB2-301 to AB3-204.', changes: [{ label: 'Room', from: 'AB2-301', to: 'AB3-204' }] }],
    [3.15, { title: 'DBMS seating plan published', summary: 'Seating is by roll number. Check your seat on the exam portal.', changes: [{ label: 'Seating', from: 'Not published', to: 'Published' }] }],
    [3.12, { title: 'DBMS exam: reporting time', summary: 'Report to AB3-204 by 1:40 PM with your ID card.', changes: [{ label: 'Reporting', from: '9:40 AM', to: '1:40 PM' }] }],
  ];
  // The exam itself: two days from now at 2:00 PM local time, matching the update text.
  const examDay = new Date(now + 48 * H);
  examDay.setHours(14, 0, 0, 0);
  const examAt = examDay.toISOString();
  let seq = 0;
  const events = plan.map(([h, wf, to, payload]) => [h, wf, to, payload]);
  for (const [h, p] of exam) {
    events.push([h, 'exam-schedule-change', { type: 'topic', topic: 'course:CS301' }, {
      course: 'CS301', courseName: 'Database Management Systems', examDate: examAt, ...p,
      changes: p.changes,
    }]);
  }
  events.sort((a, b) => b[0] - a[0]);
  for (const [h, wf, to, payload] of events) {
    clock.set(at(h));
    seq += 1;
    ctx.ingest.accept({ transactionId: `seed-${String(seq).padStart(3, '0')}-${wf}`, workflowIdentifier: wf, to, payload });
    await engine.tick(); // a later event's tick also closes any digest window that has expired
  }
  // Let the last digest window close at its real time, not at "now".
  clock.set(at(3.0));
  await engine.tick();
  // Engagement: older messages are mostly read; a few actions were clicked.
  const r = rng(11);
  const msgs = ctx.db.all(`SELECT m.id, m.created_at, m.subscriber_id FROM messages m WHERE m.channel = 'in-app'`);
  const main = ctx.db.get(`SELECT id FROM subscribers WHERE external_id = 'student_001'`).id;
  ctx.db.tx(() => {
    for (const m of msgs) {
      const age = (now - m.created_at) / H;
      const keepUnreadForMain = m.subscriber_id === main && age < 35;
      if (!keepUnreadForMain && r() < (age > 24 ? 0.85 : 0.5)) {
        const readAt = m.created_at + Math.floor(r() * 3 * H);
        const clicked = r() < 0.3 ? readAt + 20000 : null;
        ctx.db.run('UPDATE messages SET seen = 1, read_at = ?, clicked_at = ? WHERE id = ?', readAt, clicked, m.id);
      }
    }
  });
  clock.set(now);
  await engine.tick();
  return seq;
}

async function seed(engine, { history = true, clock } = {}) {
  seedCatalogue(engine);
  const ids = seedStudents(engine);
  let replayed = 0;
  const hasHistory = engine.ctx.db.get(`SELECT 1 AS x FROM events WHERE transaction_id LIKE 'seed-%' LIMIT 1`);
  if (history && clock && !hasHistory) replayed = await seedHistory(engine, clock);
  return { students: ids.length, replayed };
}

/** Clock that seeding can move into the past; it returns to real time afterwards. */
function controllableClock() {
  let fixed = null;
  return { now: () => (fixed ?? Date.now()), set: (t) => { fixed = t; }, release: () => { fixed = null; } };
}

async function runSeed(config) {
  const clock = controllableClock();
  const engine = createEngine({ config: { ...config, emailRatePerSec: 0 }, clock, logger: createLogger('silent') });
  const out = await seed(engine, { clock });
  clock.release();
  await engine.close();
  return out;
}

module.exports = { seed, runSeed, WORKFLOWS };

if (require.main === module) {
  if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');
  runSeed(loadConfig()).then((r) => {
    console.log(`Seeded SRM University: ${r.students} students, ${Object.keys(WORKFLOWS).length} workflows, ${r.replayed} historical events replayed.`);
  });
}
