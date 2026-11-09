import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateWeeklyShifts, nextAutomationDate, weekStartForDueAutomation } =
  require('./schedule-core.cjs');
const POLL_INTERVAL_MS = 60_000;

export function validateAutomationSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.automationEnabled !== 'boolean' ||
      !Number.isInteger(input.automationDay) || input.automationDay < 0 || input.automationDay > 6 ||
      typeof input.automationTime !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.automationTime) ||
      typeof input.automationTimezone !== 'string' || input.automationTimezone.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.automationTimezone });
  } catch {
    return null;
  }
  return {
    automationEnabled: input.automationEnabled,
    automationDay: input.automationDay,
    automationTime: input.automationTime,
    automationTimezone: input.automationTimezone
  };
}

async function processWorkspace(pool, workspaceId, now) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, automation_enabled AS "automationEnabled", automation_day AS "automationDay",
              to_char(automation_time, 'HH24:MI') AS "automationTime",
              automation_timezone AS "automationTimezone", automation_next_run_at AS "nextRunAt",
              weekly_hours_cap AS "weeklyHoursCap", minimum_rest_hours AS "minimumRestHours"
       FROM workspaces WHERE id = $1 FOR UPDATE`,
      [workspaceId]
    );
    const workspace = result.rows[0];
    if (!workspace?.automationEnabled || new Date(workspace.nextRunAt) > now) {
      await client.query('COMMIT');
      return;
    }

    const targetWeekStart = weekStartForDueAutomation(
      workspace.nextRunAt,
      now,
      workspace.automationTimezone
    );
    const existing = await client.query(
      'SELECT id FROM schedules WHERE workspace_id = $1 AND week_start = $2 FOR UPDATE',
      [workspaceId, targetWeekStart]
    );
    let scheduleId;
    let title;
    let message;

    if (existing.rowCount) {
      scheduleId = existing.rows[0].id;
      title = 'Weekly draft was not replaced';
      message = `The schedule for the week of ${targetWeekStart} already exists. Review it before making changes; staff were not notified.`;
    } else {
      const memberResult = await client.query(
        'SELECT id, unavailable_days AS "unavailableDays" FROM team_members WHERE workspace_id = $1 ORDER BY created_at, id',
        [workspaceId]
      );
      const shifts = generateWeeklyShifts(memberResult.rows, workspace);
      const saved = await client.query(
        `INSERT INTO schedules (workspace_id, week_start, status, is_stale)
         VALUES ($1, $2, 'draft', FALSE) RETURNING id`,
        [workspaceId, targetWeekStart]
      );
      scheduleId = saved.rows[0].id;
      for (const shift of shifts) {
        await client.query(
          `INSERT INTO schedule_shifts (schedule_id, day_index, shift_key, team_member_id)
           VALUES ($1, $2, $3, $4)`,
          [scheduleId, shift.dayIndex, shift.shiftKey, shift.memberId]
        );
      }
      const openShifts = shifts.filter(shift => !shift.memberId).length;
      title = 'Your weekly draft is ready';
      message = `A draft for the week of ${targetWeekStart} was created automatically with ${openShifts} open shift${openShifts === 1 ? '' : 's'}. Review it before use; staff were not notified.`;
    }

    await client.query(
      `INSERT INTO notifications (user_id, workspace_id, schedule_id, title, message)
       SELECT id, $1, $2, $3, $4 FROM users WHERE workspace_id = $1
       ON CONFLICT (user_id, schedule_id) DO NOTHING`,
      [workspaceId, scheduleId, title, message]
    );
    const nextRunAt = nextAutomationDate(
      workspace.automationDay,
      workspace.automationTime,
      workspace.automationTimezone,
      now
    );
    await client.query(
      'UPDATE workspaces SET automation_next_run_at = $1, updated_at = now() WHERE id = $2',
      [nextRunAt, workspaceId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runDueAutomations(pool, now = new Date()) {
  const result = await pool.query(
    `SELECT id, automation_day AS "automationDay",
            to_char(automation_time, 'HH24:MI') AS "automationTime",
            automation_timezone AS "automationTimezone", automation_next_run_at AS "nextRunAt"
     FROM workspaces WHERE automation_enabled = TRUE ORDER BY id`
  );

  for (const workspace of result.rows) {
    if (!workspace.nextRunAt) {
      const nextRunAt = nextAutomationDate(
        workspace.automationDay,
        workspace.automationTime,
        workspace.automationTimezone,
        now
      );
      await pool.query(
        `UPDATE workspaces SET automation_next_run_at = $1
         WHERE id = $2 AND automation_next_run_at IS NULL`,
        [nextRunAt, workspace.id]
      );
      continue;
    }
    if (new Date(workspace.nextRunAt) > now) continue;
    try {
      await processWorkspace(pool, workspace.id, now);
    } catch (error) {
      console.error(`Weekly schedule automation failed for workspace ${workspace.id}:`, error);
    }
  }
}

export function startWeeklyAutomation(pool) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueAutomations(pool);
    } catch (error) {
      console.error('Could not check weekly schedule automation:', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
