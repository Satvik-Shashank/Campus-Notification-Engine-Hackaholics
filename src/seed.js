'use strict';

const fs = require('node:fs');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createEngine } = require('./engine');

/** Demo data: workflows, a handful of students and one topic. Safe to run repeatedly. */
function seed(engine) {
  const { workflows, subscribers } = engine.ctx;

  workflows.upsert('exam-update', {
    correlationKey: 'exam',
    criticalRules: [{ field: 'minutesUntilExam', op: 'lt', value: 30 }],
    steps: [
      { type: 'digest', windowMs: 5 * 60 * 1000, digestKey: 'exam' },
      { type: 'email', subject: 'Exam update: {{exam}}', body: '{{exam}} is now in room {{room}} at {{time}}.' },
      { type: 'in-app', subject: 'Exam update: {{exam}}', body: '{{exam}} is now in room {{room}} at {{time}}.' },
    ],
  });
  workflows.upsert('grade-alerts', {
    correlationKey: 'course',
    steps: [
      { type: 'email', subject: 'Grade posted: {{course}}', body: '{{course}} {{assessment}}: {{grade}}' },
      { type: 'in-app', subject: 'Grade posted: {{course}}', body: '{{course}} {{assessment}}: {{grade}}' },
    ],
  });
  workflows.upsert('emergency-alert', {
    critical: true,
    steps: [
      { type: 'email', subject: '{{title}}', body: '{{title}}: {{reason}} ({{duration}})' },
      { type: 'in-app', subject: '{{title}}', body: '{{title}}: {{reason}} ({{duration}})' },
    ],
  });

  const ids = [];
  for (let i = 1; i <= 5; i += 1) {
    const id = `student_${String(i).padStart(3, '0')}`;
    subscribers.upsert(id, { email: `${id}@campus.example`, firstName: `Student${i}` });
    ids.push(id);
  }
  subscribers.setTopicMembers('CS101-students', ids);
  return ids;
}

module.exports = { seed };

if (require.main === module) {
  if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');
  const engine = createEngine({ config: loadConfig(), logger: createLogger('info') });
  const ids = seed(engine);
  console.log(`Seeded workflows (exam-update, grade-alerts, emergency-alert) and subscribers: ${ids.join(', ')}`);
  engine.close();
}
