import test from 'node:test';
import assert from 'node:assert/strict';
import { runDueAutomations } from '../weekly-automation.mjs';

test('creates one upcoming-week draft and manager notification for a due automation', async () => {
  const workspace = {
    id: 'workspace-1',
    automationEnabled: true,
    automationDay: 0,
    automationTime: '09:00',
    automationTimezone: 'Asia/Kolkata',
    nextRunAt: new Date('2026-11-08T03:30:00Z'),
    weeklyHoursCap: 40,
    minimumRestHours: 11
  };
  const members = [
    { id: 'member-a', unavailableDays: [] },
    { id: 'member-b', unavailableDays: [] }
  ];
  const schedule = { id: 'schedule-1', weekStart: null };
  const insertedShifts = [];
  const notifications = [];
  let scheduleInsertions = 0;

  const pool = {
    async query(sql, values) {
      if (sql.includes('FROM workspaces WHERE automation_enabled = TRUE')) {
        return { rows: [{ ...workspace }] };
      }
      if (sql.includes('UPDATE workspaces SET automation_next_run_at = $1')) {
        workspace.nextRunAt = values[0];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, values) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
          if (sql.includes('FROM workspaces WHERE id = $1 FOR UPDATE')) {
            return { rowCount: 1, rows: [{ ...workspace }] };
          }
          if (sql.includes('FROM schedules WHERE workspace_id = $1')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM team_members WHERE workspace_id = $1')) {
            return { rowCount: members.length, rows: members };
          }
          if (sql.includes('INSERT INTO schedules')) {
            scheduleInsertions += 1;
            schedule.weekStart = values[1];
            return { rowCount: 1, rows: [{ id: schedule.id }] };
          }
          if (sql.includes('INSERT INTO schedule_shifts')) {
            insertedShifts.push(values.slice(1));
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('INSERT INTO notifications')) {
            notifications.push(values);
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('UPDATE workspaces SET automation_next_run_at = $1')) {
            workspace.nextRunAt = values[0];
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`Unexpected client query: ${sql}`);
        },
        release() {}
      };
    }
  };

  const now = new Date('2026-11-09T04:00:00Z');
  await runDueAutomations(pool, now);
  await runDueAutomations(pool, now);

  assert.equal(scheduleInsertions, 1);
  assert.equal(schedule.weekStart, '2026-11-09');
  assert.equal(insertedShifts.length, 14);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][3], /staff were not notified/);
  assert.equal(workspace.nextRunAt.toISOString(), '2026-11-15T03:30:00.000Z');
});
