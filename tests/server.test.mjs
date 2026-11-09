import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, hashPassword, normalizeEmail, scheduleIssues, validateMember, validateSchedule, verifyPassword } from '../server.mjs';

test('normalizes and validates account email addresses', () => {
  assert.equal(normalizeEmail('  Person@Example.com '), 'person@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('x'.repeat(250) + '@example.com'), null);
});

test('validates team member data and unavailable day indexes', () => {
  assert.deepEqual(validateMember({ name: ' Maya ', role: ' Lead ', unavailableDays: [0, 6] }), {
    name: 'Maya', role: 'Lead', unavailableDays: [0, 6]
  });
  assert.equal(validateMember({ name: 'Maya', role: 'Lead', unavailableDays: [7] }), null);
  assert.equal(validateMember({ name: 'Maya', role: 'Lead', unavailableDays: [1, 1] }), null);
});

test('requires a complete Monday-based week before accepting a saved schedule', () => {
  const shifts = Array.from({ length: 7 }, (_, dayIndex) => [
    { dayIndex, shiftKey: 'morning', memberId: null },
    { dayIndex, shiftKey: 'evening', memberId: null }
  ]).flat();
  assert.deepEqual(validateSchedule({ weekStart: '2026-11-09', shifts }), {
    weekStart: '2026-11-09', shifts
  });
  assert.equal(validateSchedule({ weekStart: '2026-11-08', shifts }), null);
  assert.equal(validateSchedule({ weekStart: '2026-11-09', shifts: shifts.slice(1) }), null);
});

test('rejects saved shifts that break configured hours, rest, availability, or workspace rules', () => {
  const shifts = Array.from({ length: 7 }, (_, dayIndex) => [
    { dayIndex, shiftKey: 'morning', memberId: 'member-a' },
    { dayIndex, shiftKey: 'evening', memberId: null }
  ]).flat();
  const schedule = { weekStart: '2026-11-09', shifts };
  const issues = scheduleIssues(schedule, [
    { id: 'member-a', unavailableDays: [0] }
  ], { weeklyHoursCap: 40, minimumRestHours: 17 });
  assert.ok(issues.some(issue => issue.includes('unavailable')));
  assert.ok(issues.some(issue => issue.includes('weekly-hours')));
  assert.ok(issues.some(issue => issue.includes('minimum rest')));
  assert.ok(scheduleIssues(schedule, [], { weeklyHoursCap: 40, minimumRestHours: 11 })
    .some(issue => issue.includes('outside this workspace')));
});

test('hashes passwords with scrypt and verifies without plaintext storage', async () => {
  const hash = await hashPassword('a long unique password');
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(hash, 'a long unique password');
  assert.equal(await verifyPassword('a long unique password', hash), true);
  assert.equal(await verifyPassword('different password', hash), false);
  assert.equal(await verifyPassword('anything', 'invalid'), false);
  await assert.rejects(hashPassword('short'), /12 and 128/);
});

test('serves only public app files and checks API availability', async t => {
  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    }
  };
  const server = createApp({ pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const anonymous = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(anonymous.status, 401);

  const app = await fetch(baseUrl);
  assert.equal(app.status, 200);
  assert.match(await app.text(), /Rosterly — Shift planning/);

  const privateFile = await fetch(`${baseUrl}/server.mjs`);
  assert.equal(privateFile.status, 404);

  const crossOriginLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ email: 'user@example.com', password: 'a long unique password' })
  });
  assert.equal(crossOriginLogin.status, 403);
});
