import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const root = fileURLToPath(new URL('.', import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = 'rosterly_session';
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'styles.css']);

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function validateMember(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const role = typeof input.role === 'string' ? input.role.trim() : '';
  const unavailableDays = input.unavailableDays;
  if (!name || name.length > 80 || !role || role.length > 60) return null;
  if (!Array.isArray(unavailableDays) || unavailableDays.length > 7 ||
      unavailableDays.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(unavailableDays).size !== unavailableDays.length) return null;
  return { name, role, unavailableDays };
}

export function validateSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart) ||
      !Array.isArray(input.shifts) || input.shifts.length !== 14) return null;
  const date = new Date(`${input.weekStart}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== input.weekStart || date.getUTCDay() !== 1) return null;
  const slots = new Set();
  const shifts = [];
  for (const item of input.shifts) {
    if (!item || !Number.isInteger(item.dayIndex) || item.dayIndex < 0 || item.dayIndex > 6 ||
        !['morning', 'evening'].includes(item.shiftKey) ||
        (item.memberId !== null && (typeof item.memberId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.memberId)))) return null;
    const key = `${item.dayIndex}-${item.shiftKey}`;
    if (slots.has(key)) return null;
    slots.add(key);
    shifts.push({ dayIndex: item.dayIndex, shiftKey: item.shiftKey, memberId: item.memberId });
  }
  if (slots.size !== 14) return null;
  return { weekStart: input.weekStart, shifts };
}

export function scheduleIssues(schedule, members, limits) {
  const memberById = new Map(members.map(member => [member.id, member]));
  const hoursByMember = new Map();
  const shiftsByMember = new Map();
  const issues = [];

  for (const shift of schedule.shifts) {
    if (!shift.memberId) continue;
    const member = memberById.get(shift.memberId);
    if (!member) {
      issues.push('Schedule references a team member outside this workspace.');
      continue;
    }
    if (member.unavailableDays.includes(shift.dayIndex)) {
      issues.push('A team member is assigned on an unavailable day.');
    }
    hoursByMember.set(member.id, (hoursByMember.get(member.id) || 0) + 8);
    const shifts = shiftsByMember.get(member.id) || [];
    shifts.push({ dayIndex: shift.dayIndex, start: shift.shiftKey === 'morning' ? 8 : 16, end: shift.shiftKey === 'morning' ? 16 : 24 });
    shiftsByMember.set(member.id, shifts);
  }

  for (const [memberId, hours] of hoursByMember) {
    if (hours > limits.weeklyHoursCap) issues.push('A team member exceeds the configured weekly-hours cap.');
    const shifts = shiftsByMember.get(memberId).sort((a, b) => a.dayIndex - b.dayIndex || a.start - b.start);
    for (let index = 1; index < shifts.length; index += 1) {
      const previous = shifts[index - 1];
      const current = shifts[index];
      const restHours = (current.dayIndex - previous.dayIndex) * 24 + current.start - previous.end;
      if (restHours < limits.minimumRestHours) {
        issues.push('A team member has less than the configured minimum rest between shifts.');
      }
    }
  }
  return [...new Set(issues)];
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters.');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length, {
      N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    const key = part.slice(0, separator).trim();
    try {
      return [key, decodeURIComponent(part.slice(separator + 1).trim())];
    } catch {
      return [key, ''];
    }
  }).filter(([key]) => key));
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...headers
  });
  response.end(body);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    request.on('data', chunk => {
      if (tooLarge) return;
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  const trustedProxy = process.env.TRUST_PROXY === '1';
  const protocol = trustedProxy && request.headers['x-forwarded-proto']
    ? request.headers['x-forwarded-proto'].split(',')[0].trim()
    : (request.socket.encrypted ? 'https' : 'http');
  const host = trustedProxy && request.headers['x-forwarded-host']
    ? request.headers['x-forwarded-host'].split(',')[0].trim()
    : request.headers.host;
  return origin === `${protocol}://${host}`;
}

function cookieHeader(token, maxAge, secure) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function publicUser(row) {
  return { id: row.user_id, email: row.email, workspace: { id: row.workspace_id, name: row.workspace_name } };
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createApp({ pool, secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  if (!pool) throw new Error('A PostgreSQL pool is required.');
  const attempts = new Map();
  const sessionDays = Math.min(30, Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 7));

  async function getUser(request) {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length > 200) return null;
    const result = await pool.query(
      `SELECT u.id AS user_id, u.email, w.id AS workspace_id, w.name AS workspace_name, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = u.workspace_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    );
    return result.rows[0] || null;
  }

  async function createSession(userId, response, db = pool) {
    const token = randomBytes(32).toString('base64url');
    await db.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 day'))",
      [userId, hashToken(token), sessionDays]
    );
    response.setHeader('Set-Cookie', cookieHeader(token, sessionDays * 86400, secureCookies));
  }

  async function routeApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      await pool.query('SELECT 1');
      return sendJson(response, 200, { status: 'ok' });
    }

    if (request.method === 'POST' && ['/api/auth/register', '/api/auth/login', '/api/auth/logout'].includes(url.pathname)) {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      const key = request.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const recent = (attempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
      if (recent.length >= 10) return sendJson(response, 429, { error: 'Too many account requests. Try again in 15 minutes.' });
      const body = await parseBody(request);
      const email = normalizeEmail(body.email);
      const workspaceName = typeof body.workspaceName === 'string' ? body.workspaceName.trim() : '';
      if (!email || workspaceName.length < 1 || workspaceName.length > 120) {
        return sendJson(response, 400, { error: 'Enter a valid email address and workspace name.' });
      }
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
        return sendJson(response, 400, { error: 'Password must be between 12 and 128 characters.' });
      }
      const passwordHash = await hashPassword(body.password);
      recent.push(now);
      attempts.set(key, recent);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const workspace = await client.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name', [workspaceName]);
        const user = await client.query(
          'INSERT INTO users (workspace_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, workspace_id',
          [workspace.rows[0].id, email, passwordHash]
        );
        await createSession(user.rows[0].id, response, client);
        await client.query('COMMIT');
        return sendJson(response, 201, {
          user: { id: user.rows[0].id, email: user.rows[0].email, workspace: workspace.rows[0] }
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505') return sendJson(response, 409, { error: 'An account with that email already exists.' });
        throw error;
      } finally {
        client.release();
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      const now = Date.now();
      const key = request.socket.remoteAddress || 'unknown';
      const attemptsForIp = (attempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
      if (attemptsForIp.length >= 10) return sendJson(response, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      const body = await parseBody(request);
      const email = normalizeEmail(body.email);
      const result = email ? await pool.query(
        `SELECT u.id AS user_id, u.email, u.password_hash, w.id AS workspace_id, w.name AS workspace_name
         FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.email = $1`,
        [email]
      ) : { rows: [] };
      const row = result.rows[0];
      if (!row || !await verifyPassword(body.password, row.password_hash)) {
        attemptsForIp.push(now);
        attempts.set(key, attemptsForIp);
        return sendJson(response, 401, { error: 'Email or password is incorrect.' });
      }
      attempts.delete(key);
      await createSession(row.user_id, response);
      return sendJson(response, 200, { user: publicUser(row) });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0, secureCookies) });
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      const user = await getUser(request);
      return user
        ? sendJson(response, 200, { user: publicUser(user) })
        : sendJson(response, 401, { error: 'Sign in required.' });
    }

    const user = await getUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in required.' });

    if (request.method === 'GET' && url.pathname === '/api/team') {
      const result = await pool.query(
        'SELECT id, name, role, unavailable_days AS "unavailableDays" FROM team_members WHERE workspace_id = $1 ORDER BY created_at, id',
        [user.workspace_id]
      );
      return sendJson(response, 200, { members: result.rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/team') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
      const member = validateMember(await parseBody(request));
      if (!member) return sendJson(response, 400, { error: 'Check the team member name, role, and availability.' });
      const saved = await inTransaction(pool, async client => {
        await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [user.workspace_id]);
        const count = await client.query('SELECT count(*)::int AS count FROM team_members WHERE workspace_id = $1', [user.workspace_id]);
        if (count.rows[0].count >= 100) {
          throw Object.assign(new Error('A workspace can have up to 100 team members.'), { status: 409 });
        }
        const result = await client.query(
          `INSERT INTO team_members (workspace_id, name, role, unavailable_days)
           VALUES ($1, $2, $3, $4::smallint[]) RETURNING id, name, role, unavailable_days AS "unavailableDays"`,
          [user.workspace_id, member.name, member.role, member.unavailableDays]
        );
        await client.query('UPDATE schedules SET is_stale = TRUE, updated_at = now() WHERE workspace_id = $1', [user.workspace_id]);
        return result.rows[0];
      });
      return sendJson(response, 201, { member: saved });
    }

    const memberMatch = url.pathname.match(/^\/api\/team\/([0-9a-f-]{36})$/i);
    if (memberMatch && request.method === 'PATCH') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
      const member = validateMember(await parseBody(request));
      if (!member) return sendJson(response, 400, { error: 'Check the team member name, role, and availability.' });
      const saved = await inTransaction(pool, async client => {
        const result = await client.query(
          `UPDATE team_members SET name = $1, role = $2, unavailable_days = $3::smallint[], updated_at = now()
           WHERE id = $4 AND workspace_id = $5 RETURNING id, name, role, unavailable_days AS "unavailableDays"`,
          [member.name, member.role, member.unavailableDays, memberMatch[1], user.workspace_id]
        );
        if (result.rowCount) {
          await client.query('UPDATE schedules SET is_stale = TRUE, updated_at = now() WHERE workspace_id = $1', [user.workspace_id]);
        }
        return result.rows[0] || null;
      });
      return saved
        ? sendJson(response, 200, { member: saved })
        : sendJson(response, 404, { error: 'Team member not found.' });
    }

    if (memberMatch && request.method === 'DELETE') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
      const deleted = await inTransaction(pool, async client => {
        const result = await client.query('DELETE FROM team_members WHERE id = $1 AND workspace_id = $2', [memberMatch[1], user.workspace_id]);
        if (result.rowCount) {
          await client.query('UPDATE schedules SET is_stale = TRUE, updated_at = now() WHERE workspace_id = $1', [user.workspace_id]);
        }
        return result.rowCount > 0;
      });
      return deleted ? sendJson(response, 200, { ok: true }) : sendJson(response, 404, { error: 'Team member not found.' });
    }

    if (request.method === 'GET' && url.pathname === '/api/settings') {
      const result = await pool.query(
        'SELECT country_code AS "countryCode", industry, weekly_hours_cap AS "weeklyHoursCap", minimum_rest_hours AS "minimumRestHours" FROM workspaces WHERE id = $1',
        [user.workspace_id]
      );
      return sendJson(response, 200, { settings: result.rows[0] });
    }

    if (request.method === 'GET' && url.pathname === '/api/schedules') {
      const weekStart = url.searchParams.get('weekStart') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
        return sendJson(response, 400, { error: 'A Monday weekStart date is required.' });
      }
      const schedule = await pool.query(
        'SELECT id, week_start AS "weekStart", status, is_stale AS "isStale" FROM schedules WHERE workspace_id = $1 AND week_start = $2',
        [user.workspace_id, weekStart]
      );
      if (!schedule.rowCount) return sendJson(response, 200, { schedule: null });
      const shifts = await pool.query(
        `SELECT day_index AS "dayIndex", shift_key AS "shiftKey", team_member_id AS "memberId"
         FROM schedule_shifts WHERE schedule_id = $1 ORDER BY day_index, shift_key`,
        [schedule.rows[0].id]
      );
      return sendJson(response, 200, { schedule: { ...schedule.rows[0], shifts: shifts.rows } });
    }

    if (request.method === 'PUT' && url.pathname === '/api/schedules') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
      const schedule = validateSchedule(await parseBody(request));
      if (!schedule) return sendJson(response, 400, { error: 'A schedule must include each of the 14 weekly shift slots exactly once.' });
      const memberIds = [...new Set(schedule.shifts.map(shift => shift.memberId).filter(Boolean))];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const limits = await client.query(
          'SELECT weekly_hours_cap AS "weeklyHoursCap", minimum_rest_hours AS "minimumRestHours" FROM workspaces WHERE id = $1',
          [user.workspace_id]
        );
        const limitValues = limits.rows[0];
        if (!limitValues) {
          await client.query('ROLLBACK');
          return sendJson(response, 404, { error: 'Workspace not found.' });
        }
        let members = [];
        if (memberIds.length) {
          const memberResult = await client.query(
            'SELECT id, unavailable_days AS "unavailableDays" FROM team_members WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
            [user.workspace_id, memberIds]
          );
          members = memberResult.rows;
        }
        const issues = scheduleIssues(schedule, members, limitValues);
        if (issues.length) {
          await client.query('ROLLBACK');
          return sendJson(response, 400, { error: 'Schedule violates the configured workspace limits.', issues });
        }
        const saved = await client.query(
          `INSERT INTO schedules (workspace_id, week_start, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, week_start)
           DO UPDATE SET status = 'draft', is_stale = FALSE, created_by = EXCLUDED.created_by, updated_at = now()
           RETURNING id, week_start AS "weekStart", status, is_stale AS "isStale"`,
          [user.workspace_id, schedule.weekStart, user.user_id]
        );
        await client.query('DELETE FROM schedule_shifts WHERE schedule_id = $1', [saved.rows[0].id]);
        for (const shift of schedule.shifts) {
          await client.query(
            'INSERT INTO schedule_shifts (schedule_id, day_index, shift_key, team_member_id) VALUES ($1, $2, $3, $4)',
            [saved.rows[0].id, shift.dayIndex, shift.shiftKey, shift.memberId]
          );
        }
        await client.query('COMMIT');
        return sendJson(response, 200, { schedule: { ...saved.rows[0], shifts: schedule.shifts } });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    if (request.method === 'PUT' && url.pathname === '/api/settings') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
      const body = await parseBody(request);
      const countryCode = typeof body.countryCode === 'string' ? body.countryCode.toUpperCase() : '';
      const industry = typeof body.industry === 'string' ? body.industry.trim() : '';
      const weeklyHoursCap = Number(body.weeklyHoursCap);
      const minimumRestHours = Number(body.minimumRestHours);
      if (!/^[A-Z]{2}$/.test(countryCode) || !industry || industry.length > 100 ||
          !Number.isInteger(weeklyHoursCap) || weeklyHoursCap < 8 || weeklyHoursCap > 60 ||
          !Number.isInteger(minimumRestHours) || minimumRestHours < 8 || minimumRestHours > 24) {
        return sendJson(response, 400, { error: 'Check country, industry, weekly-hours cap, and minimum rest.' });
      }
      const settings = await inTransaction(pool, async client => {
        const result = await client.query(
          `UPDATE workspaces SET country_code = $1, industry = $2, weekly_hours_cap = $3,
           minimum_rest_hours = $4, updated_at = now() WHERE id = $5
           RETURNING country_code AS "countryCode", industry, weekly_hours_cap AS "weeklyHoursCap", minimum_rest_hours AS "minimumRestHours"`,
          [countryCode, industry, weeklyHoursCap, minimumRestHours, user.workspace_id]
        );
        await client.query('UPDATE schedules SET is_stale = TRUE, updated_at = now() WHERE workspace_id = $1', [user.workspace_id]);
        return result.rows[0];
      });
      return sendJson(response, 200, { settings });
    }

    return sendJson(response, 404, { error: 'API route not found.' });
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) return await routeApi(request, response, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed.' });
      let requestedPath;
      try {
        requestedPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      } catch {
        return sendJson(response, 400, { error: 'Invalid path.' });
      }
      if (!PUBLIC_FILES.has(requestedPath)) return sendJson(response, 404, { error: 'Not found.' });
      const filePath = join(root, requestedPath);
      const content = await readFile(filePath);
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
      response.writeHead(200, {
        'Content-Type': types[extname(filePath)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error.status) return sendJson(response, error.status, { error: error.message });
      console.error('Request failed:', error);
      return sendJson(response, 500, { error: 'The request could not be completed.' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  const port = Number(process.env.PORT) || 3000;
  const server = createApp({ pool });
  server.listen(port, () => console.log(`Rosterly is listening on http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(async () => {
      await pool.end();
      process.exit(0);
    }));
  }
}
