const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHIFTS = [
  { key: 'morning', label: 'Morning', start: 8, end: 16 },
  { key: 'evening', label: 'Evening', start: 16, end: 24 }
];
const COUNTRY_CODES = {
  Germany: 'DE', Austria: 'AT', Belgium: 'BE', Bulgaria: 'BG', Croatia: 'HR',
  Cyprus: 'CY', Czechia: 'CZ', Denmark: 'DK', Estonia: 'EE', Finland: 'FI',
  France: 'FR', Greece: 'GR', Hungary: 'HU', Ireland: 'IE', Italy: 'IT',
  Latvia: 'LV', Lithuania: 'LT', Luxembourg: 'LU', Malta: 'MT', Netherlands: 'NL',
  Poland: 'PL', Portugal: 'PT', Romania: 'RO', Slovakia: 'SK', Slovenia: 'SI',
  Spain: 'ES', Sweden: 'SE', 'United Kingdom': 'GB'
};
const DEFAULT_STAFF = [
  { id: 'maya', name: 'Maya Chen', role: 'Shift lead', unavailable: [5, 6] },
  { id: 'luca', name: 'Luca Bianchi', role: 'Team member', unavailable: [] },
  { id: 'amira', name: 'Amira Saleh', role: 'Team member', unavailable: [0, 1] },
  { id: 'jonas', name: 'Jonas Keller', role: 'Team member', unavailable: [] },
  { id: 'sofia', name: 'Sofia Costa', role: 'Team member', unavailable: [6, 0] }
];

const state = {
  weekStart: startOfWeek(new Date()),
  assignments: [],
  staff: location.protocol === 'file:' ? loadStaff() : [],
  generated: false,
  toastTimer: null,
  user: null,
  authMode: 'login'
};

const dayGrid = document.querySelector('#day-grid');
const teamTable = document.querySelector('#team-table');
const weeklyCapInput = document.querySelector('#weekly-cap');
const restHoursInput = document.querySelector('#rest-hours');
const countrySelect = document.querySelector('#country');
const toast = document.querySelector('#toast');

function loadStaff() {
  const defaultStaff = () => DEFAULT_STAFF.map(person => ({ ...person, unavailable: [...person.unavailable] }));
  try {
    const saved = JSON.parse(localStorage.getItem('rosterly.staff') || 'null');
    if (!Array.isArray(saved) || !saved.every(person =>
      person && typeof person.id === 'string' &&
      typeof person.name === 'string' && person.name.trim() &&
      typeof person.role === 'string' && Array.isArray(person.unavailable) &&
      person.unavailable.every(day => Number.isInteger(day) && day >= 0 && day < 7)
    )) {
      if (saved !== null) console.warn('Saved team data is invalid; default team is in use.');
      return defaultStaff();
    }
    return saved;
  } catch (error) {
    console.error('Could not read saved team data; default team is in use.', error);
    return defaultStaff();
  }
}

function persistData() {
  if (location.protocol !== 'file:') return;
  try {
    localStorage.setItem('rosterly.staff', JSON.stringify(state.staff));
    localStorage.setItem('rosterly.settings', JSON.stringify({
      country: countrySelect.value,
      industry: document.querySelector('#industry').value,
      weeklyCap: weeklyCapInput.value,
      restHours: restHoursInput.value
    }));
  } catch (error) {
    showToast('Could not save changes in this browser. Check storage settings and try again.');
  }
}

function loadSettings() {
  if (location.protocol !== 'file:') return;
  try {
    const settings = JSON.parse(localStorage.getItem('rosterly.settings') || 'null');
    if (!settings) return;
    if ([...countrySelect.options].some(option => option.value === settings.country)) {
      countrySelect.value = settings.country;
    }
    const industries = document.querySelector('#industry').options;
    if ([...industries].some(option => option.value === settings.industry)) {
      document.querySelector('#industry').value = settings.industry;
    }
    const weeklyCap = Number(settings.weeklyCap);
    const restHours = Number(settings.restHours);
    if (Number.isFinite(weeklyCap) && weeklyCap >= 8 && weeklyCap <= 60) weeklyCapInput.value = weeklyCap;
    if (Number.isFinite(restHours) && restHours >= 8 && restHours <= 24) restHoursInput.value = restHours;
  } catch (error) {
    showToast('Saved settings could not be read. Default settings are in use.');
  }
}

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    console.error('Could not reach the Rosterly API.', error);
    throw new Error('Can’t connect to the server. Check your connection and try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showAuthScreen(mode = 'login', error = '') {
  state.authMode = mode;
  document.body.classList.add('api-mode', 'auth-required');
  document.querySelector('#auth-screen').hidden = false;
  document.querySelector('#auth-error').textContent = error;
  document.querySelector('#auth-title').textContent = mode === 'register' ? 'Create your workspace' : 'Welcome back';
  document.querySelector('#auth-eyebrow').textContent = mode === 'register' ? 'GET STARTED' : 'WORKSPACE ACCESS';
  document.querySelector('#auth-description').textContent = mode === 'register'
    ? 'Create an account to securely save your team and planning settings.'
    : 'Sign in to your workspace to manage your team.';
  document.querySelector('#auth-submit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
  document.querySelector('#auth-switch-copy').textContent = mode === 'register' ? 'Already have a workspace?' : 'New to Rosterly?';
  document.querySelector('#auth-mode-toggle').textContent = mode === 'register' ? 'Sign in' : 'Create a workspace';
  document.querySelector('#workspace-name-field').hidden = mode !== 'register';
  document.querySelector('#auth-workspace').required = mode === 'register';
  document.querySelector('#auth-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
}

function countryName(code) {
  return Object.keys(COUNTRY_CODES).find(name => COUNTRY_CODES[name] === code) || 'Other';
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function loadWeeklySchedule() {
  if (location.protocol === 'file:' || !state.user) return;
  const result = await apiRequest(`/api/schedules?weekStart=${encodeURIComponent(isoDate(state.weekStart))}`);
  const schedule = result.schedule;
  state.assignments = [];
  state.generated = Boolean(schedule);
  if (schedule) {
    const memberIndexes = new Map(state.staff.map((member, index) => [member.id, index]));
    state.assignments = schedule.shifts.filter(shift => shift.memberId && memberIndexes.has(shift.memberId))
      .map(shift => ({
        day: shift.dayIndex,
        shift: shift.shiftKey,
        staffIndex: memberIndexes.get(shift.memberId)
      }));
    document.querySelector('#schedule-message').textContent = schedule.isStale
      ? 'This saved draft is stale because the team or planning rules changed. Generate a fresh schedule.'
      : 'Saved draft loaded. Review coverage and planning checks before publishing.';
  } else {
    document.querySelector('#schedule-message').textContent = 'Generate a draft to see your team’s shifts.';
  }
  renderSchedule();
}

async function saveWeeklySchedule() {
  if (location.protocol === 'file:' || !state.user) return;
  const assignmentBySlot = new Map(state.assignments.map(assignment => [
    `${assignment.day}-${assignment.shift}`,
    state.staff[assignment.staffIndex]?.id || null
  ]));
  const shifts = DAYS.flatMap((_, dayIndex) => SHIFTS.map(shift => ({
    dayIndex,
    shiftKey: shift.key,
    memberId: assignmentBySlot.get(`${dayIndex}-${shift.key}`) || null
  })));
  try {
    await apiRequest('/api/schedules', {
      method: 'PUT',
      body: JSON.stringify({ weekStart: isoDate(state.weekStart), shifts })
    });
    document.querySelector('#schedule-message').textContent =
      'Draft saved. Review coverage and planning checks before publishing.';
  } catch (error) {
    document.querySelector('#schedule-message').textContent =
      'Draft generated locally but could not be saved to the server.';
    showToast(error.message);
  }
}

async function loadWorkspace() {
  const [teamResult, settingsResult] = await Promise.all([
    apiRequest('/api/team'),
    apiRequest('/api/settings')
  ]);
  state.staff = teamResult.members.map(member => ({
    id: member.id,
    name: member.name,
    role: member.role,
    unavailable: member.unavailableDays
  }));
  const settings = settingsResult.settings;
  countrySelect.value = countryName(settings.countryCode);
  document.querySelector('#industry').value = settings.industry;
  weeklyCapInput.value = settings.weeklyHoursCap;
  restHoursInput.value = settings.minimumRestHours;
  document.querySelector('h1').innerHTML = `Good morning, ${escapeHTML(state.user.email.split('@')[0])} <span>✳</span>`;
  document.querySelector('.workspace-name').innerHTML = `${escapeHTML(state.user.workspace.name)}<small>Operations team</small>`;
  document.querySelector('.workspace-avatar').textContent = state.user.workspace.name.trim()[0].toUpperCase();
  document.querySelector('.profile-name').innerHTML = `${escapeHTML(state.user.email)}<small>Workspace admin</small>`;
  document.querySelector('.profile-avatar').textContent = initialsFor(state.user.email);
  document.querySelector('#logout-button').hidden = false;
  document.body.classList.remove('auth-required');
  document.querySelector('#auth-screen').hidden = true;
  state.assignments = [];
  state.generated = false;
  renderSchedule();
  await loadWeeklySchedule();
}

async function initializeApiMode() {
  document.body.classList.add('api-mode', 'auth-required');
  try {
    const result = await apiRequest('/api/auth/me');
    state.user = result.user;
    await loadWorkspace();
  } catch (error) {
    if (error.message === 'Sign in required.') {
      showAuthScreen();
      return;
    }
    showAuthScreen('login', `${error.message} Your workspace was not loaded.`);
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function initialsFor(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0].toUpperCase()).join('');
}

function startOfWeek(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateLabel(date, options) {
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

function formatWeekRange() {
  const end = addDays(state.weekStart, 6);
  const startMonth = dateLabel(state.weekStart, { month: 'short' });
  const endMonth = dateLabel(end, { month: 'short' });
  const startDay = state.weekStart.getDate();
  const endDay = end.getDate();
  const year = end.getFullYear();
  const range = startMonth === endMonth
    ? `${startMonth} ${startDay} – ${endDay}, ${year}`
    : `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${year}`;
  document.querySelector('#week-range').innerHTML = `${range} <span class="timezone">· ${countryTimezone()}</span>`;
}

function countryTimezone() {
  const timezones = {
    Germany: 'Europe/Berlin', Austria: 'Europe/Vienna', Belgium: 'Europe/Brussels',
    France: 'Europe/Paris', Italy: 'Europe/Rome', Netherlands: 'Europe/Amsterdam',
    Spain: 'Europe/Madrid', Sweden: 'Europe/Stockholm', Finland: 'Europe/Helsinki',
    Poland: 'Europe/Warsaw', Portugal: 'Europe/Lisbon', Greece: 'Europe/Athens',
    Ireland: 'Europe/Dublin', Denmark: 'Europe/Copenhagen', 'United Kingdom': 'Europe/London'
  };
  return timezones[countrySelect.value] || 'Local timezone';
}

function renderSchedule() {
  dayGrid.innerHTML = '';
  const todayKey = dateKey(new Date());
  const assignmentsBySlot = new Map(state.assignments.map(item => [`${item.day}-${item.shift}`, item]));

  DAYS.forEach((day, dayIndex) => {
    const date = addDays(state.weekStart, dayIndex);
    const column = document.createElement('div');
    column.className = `day-column${dateKey(date) === todayKey ? ' today' : ''}`;
    column.innerHTML = `
      <div class="day-heading">
        <div class="day-name">${day}</div>
        <div class="day-date">${date.getDate()}</div>
      </div>
      ${SHIFTS.map(shift => {
        const assignment = assignmentsBySlot.get(`${dayIndex}-${shift.key}`);
        const person = assignment ? state.staff[assignment.staffIndex] : null;
        const typeClass = shift.key === 'evening' ? 'evening' : '';
        const cardClass = person ? typeClass : `${typeClass} open`;
        const safeName = person ? escapeHTML(person.name) : '';
        const safeFirstName = person ? escapeHTML(person.name.split(' ')[0]) : '';
        return `<div class="shift-slot">
          <div class="shift-type">${shift.label}</div>
          ${person
            ? `<div class="shift-card ${cardClass}" title="${safeName}: ${shift.label} shift"><div class="shift-name">${safeFirstName}</div><div class="shift-time">${formatHour(shift.start)}–${formatHour(shift.end)}</div></div>`
            : `<div class="shift-card open"><div class="shift-name">Open shift</div><div class="shift-time">${formatHour(shift.start)}–${formatHour(shift.end)}</div></div>`}
        </div>`;
      }).join('')}
    `;
    dayGrid.appendChild(column);
  });
  formatWeekRange();
  renderSummary();
  renderTeam();
}

function formatHour(hour) {
  return `${String(hour % 24).padStart(2, '0')}:00`;
}

function generateSchedule() {
  const weeklyCap = Number(weeklyCapInput.value);
  const minimumRest = Number(restHoursInput.value);
  if (!Number.isFinite(weeklyCap) || weeklyCap < 8 || weeklyCap > 60) {
    showToast('Weekly hours cap must be between 8 and 60.');
    weeklyCapInput.focus();
    return;
  }
  if (!Number.isFinite(minimumRest) || minimumRest < 8 || minimumRest > 24) {
    showToast('Minimum rest must be between 8 and 24 hours.');
    restHoursInput.focus();
    return;
  }

  const hoursByPerson = state.staff.map(() => 0);
  const lastShiftByPerson = state.staff.map(() => null);
  const assignments = [];
  const slots = DAYS.flatMap((_, day) => SHIFTS.map(shift => ({ day, shift })));

  slots.forEach(({ day, shift }) => {
    const eligible = state.staff.map((person, staffIndex) => {
      if (person.unavailable.includes(day)) return null;
      if (hoursByPerson[staffIndex] + 8 > weeklyCap) return null;

      const last = lastShiftByPerson[staffIndex];
      if (last) {
        const hoursSinceEnd = (day - last.day) * 24 + shift.start - last.end;
        if (hoursSinceEnd < minimumRest) return null;
      }

      return { staffIndex, hours: hoursByPerson[staffIndex] };
    }).filter(Boolean).sort((a, b) => a.hours - b.hours || a.staffIndex - b.staffIndex);

    if (eligible.length === 0) return;
    const { staffIndex } = eligible[0];
    assignments.push({ day, shift: shift.key, staffIndex });
    hoursByPerson[staffIndex] += 8;
    lastShiftByPerson[staffIndex] = { day, end: shift.end };
  });

  state.assignments = assignments;
  state.generated = true;
  renderSchedule();
  const openCount = slots.length - assignments.length;
  document.querySelector('#schedule-message').textContent = openCount
    ? `${openCount} shift${openCount === 1 ? '' : 's'} still need coverage. Adjust availability or limits and generate again.`
    : `Draft generated. Review the coverage and planning checks before publishing.`;
  showToast(openCount
    ? `Draft created with ${openCount} open shift${openCount === 1 ? '' : 's'} to cover.`
    : `Draft created for ${countrySelect.value}. Review local rules before publishing.`);
  saveWeeklySchedule();
}

function renderSummary() {
  const covered = state.assignments.length;
  const hours = covered * 8;
  const capacity = state.staff.length * Number(weeklyCapInput.value || 0);
  document.querySelector('#scheduled-hours').textContent = hours;
  document.querySelector('#planned-hours').textContent = `${capacity} hrs`;
  document.querySelector('#hours-progress').style.width = `${capacity ? Math.min(hours / capacity * 100, 100) : 0}%`;
  document.querySelector('#covered-shifts').textContent = covered;
  document.querySelector('#coverage-status').textContent = state.generated
    ? (covered === 14 ? 'All shifts covered' : `${14 - covered} shift${14 - covered === 1 ? '' : 's'} need coverage`)
    : 'Generate a schedule to get started';
  document.querySelector('.mini-bars').classList.toggle('active', state.generated);
  const checks = runChecks();
  document.querySelector('#check-count').textContent = state.generated ? checks.length : '—';
  document.querySelector('#check-label').textContent = 'issues';
  document.querySelector('#check-summary').textContent = !state.generated
    ? 'Run a schedule to check your limits'
    : checks.length === 0
      ? 'No configured-limit issues found'
      : `${checks.length} issue${checks.length === 1 ? '' : 's'} need attention`;
}

function runChecks() {
  const hoursByPerson = state.staff.map(() => 0);
  const shiftsByPerson = state.staff.map(() => []);
  state.assignments.forEach(({ day, shift, staffIndex }) => {
    const shiftDetails = SHIFTS.find(item => item.key === shift);
    hoursByPerson[staffIndex] += 8;
    shiftsByPerson[staffIndex].push({ day, start: shiftDetails.start, end: shiftDetails.end });
  });

  return state.staff.flatMap((person, staffIndex) => {
    const violations = [];
    if (hoursByPerson[staffIndex] > Number(weeklyCapInput.value)) {
      violations.push(`${person.name} exceeds the weekly hours cap`);
    }
    const shifts = shiftsByPerson[staffIndex].sort((a, b) => a.day - b.day || a.start - b.start);
    shifts.forEach((shift, index) => {
      if (person.unavailable.includes(shift.day)) {
        violations.push(`${person.name} is scheduled on an unavailable day`);
      }
      if (index > 0) {
        const previous = shifts[index - 1];
        const rest = (shift.day - previous.day) * 24 + shift.start - previous.end;
        if (rest < Number(restHoursInput.value)) {
          violations.push(`${person.name} has less than the configured rest between shifts`);
        }
      }
    });
    return violations;
  });
}

function renderTeam() {
  const maxHours = Number(weeklyCapInput.value) || 0;
  teamTable.innerHTML = state.staff.map((person, index) => {
    const hours = state.assignments.filter(assignment => assignment.staffIndex === index).length * 8;
    const availability = DAYS.map((day, dayIndex) =>
      `<button class="availability-day ${person.unavailable.includes(dayIndex) ? 'off' : ''}" type="button" data-staff-id="${escapeHTML(person.id)}" data-day="${dayIndex}" aria-label="${escapeHTML(person.name)}: ${day} ${person.unavailable.includes(dayIndex) ? 'unavailable' : 'available'}" aria-pressed="${!person.unavailable.includes(dayIndex)}">${day[0]}</button>`
    ).join('');
    return `<tr>
      <td><div class="member-cell"><span class="member-avatar tone-${index % 5}">${escapeHTML(initialsFor(person.name))}</span>${escapeHTML(person.name)}</div></td>
      <td><span class="role-pill">${escapeHTML(person.role)}</span></td>
      <td><div class="availability" aria-label="Availability: ${DAYS.filter((_, dayIndex) => !person.unavailable.includes(dayIndex)).join(', ')}">${availability}</div></td>
      <td><div class="hours-cell"><span>${hours} hrs <small>of ${maxHours} hrs</small></span><div class="tiny-progress"><i style="width:${maxHours ? Math.min(hours / maxHours * 100, 100) : 0}%"></i></div></div></td>
      <td><span class="availability-status">${hours ? 'Scheduled' : 'Available'}</span> <button class="remove-member" type="button" data-remove-id="${escapeHTML(person.id)}" aria-label="Remove ${escapeHTML(person.name)}">×</button></td>
    </tr>`;
  }).join('');
  document.querySelector('#team-count').textContent = state.staff.length;
  document.querySelector('.member-pill').textContent = `${state.staff.length} member${state.staff.length === 1 ? '' : 's'}`;
  document.querySelector('#team-footer-text').textContent = `Showing ${state.staff.length} of ${state.staff.length} team members`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

function updatePlanningSettings() {
  formatWeekRange();
  renderSummary();
  renderTeam();
  if (state.generated) {
    document.querySelector('#schedule-message').textContent =
      'Planning limits changed. Generate the draft again to re-check this schedule.';
  }
  persistData();
  if (location.protocol !== 'file:' && state.user) {
    apiRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        countryCode: COUNTRY_CODES[countrySelect.value] || 'ZZ',
        industry: document.querySelector('#industry').value,
        weeklyHoursCap: Number(weeklyCapInput.value),
        minimumRestHours: Number(restHoursInput.value)
      })
    }).catch(error => showToast(error.message));
  }
}

function renderCurrentDate() {
  const now = new Date();
  document.querySelector('#today-label').textContent = dateLabel(now, {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
  });
  document.querySelector('#heading-date').textContent = dateLabel(now, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }).toUpperCase();
}

document.querySelector('#generate-button').addEventListener('click', generateSchedule);
document.querySelector('#previous-week').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, -7);
  state.generated = false;
  state.assignments = [];
  document.querySelector('#schedule-message').textContent = 'Generate a draft to see your team’s shifts.';
  renderSchedule();
  loadWeeklySchedule().catch(error => showToast(error.message));
});
document.querySelector('#next-week').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, 7);
  state.generated = false;
  state.assignments = [];
  document.querySelector('#schedule-message').textContent = 'Generate a draft to see your team’s shifts.';
  renderSchedule();
  loadWeeklySchedule().catch(error => showToast(error.message));
});
document.querySelector('#today-button').addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  state.generated = false;
  state.assignments = [];
  document.querySelector('#schedule-message').textContent = 'Generate a draft to see your team’s shifts.';
  renderSchedule();
  loadWeeklySchedule().catch(error => showToast(error.message));
});
countrySelect.addEventListener('change', updatePlanningSettings);
document.querySelector('#industry').addEventListener('change', updatePlanningSettings);
weeklyCapInput.addEventListener('change', updatePlanningSettings);
restHoursInput.addEventListener('change', updatePlanningSettings);
document.querySelector('#invite-button').addEventListener('click', () => {
  document.querySelector('#member-dialog').showModal();
  document.querySelector('#member-name').focus();
});
document.querySelector('#member-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = document.querySelector('#member-name').value.trim();
  const role = document.querySelector('#member-role').value.trim();
  if (!name || !role) return;
  const unavailable = [...document.querySelectorAll('#member-days input:checked')].map(input => Number(input.value));
  let member = {
    id: `member-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    role,
    unavailable
  };
  if (location.protocol !== 'file:') {
    try {
      const result = await apiRequest('/api/team', {
        method: 'POST',
        body: JSON.stringify({ name, role, unavailableDays: unavailable })
      });
      member = { ...result.member, unavailable: result.member.unavailableDays };
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  state.staff.push(member);
  state.assignments = [];
  state.generated = false;
  document.querySelector('#schedule-message').textContent = 'Team updated. Generate a new draft to assign shifts.';
  event.currentTarget.reset();
  document.querySelector('#member-dialog').close();
  persistData();
  renderSchedule();
  showToast(`${name} added to your team.`);
});
document.querySelector('#close-member-dialog').addEventListener('click', () => {
  document.querySelector('#member-dialog').close();
});
document.querySelector('#cancel-member-dialog').addEventListener('click', () => {
  document.querySelector('#member-dialog').close();
});
document.querySelector('#auth-mode-toggle').addEventListener('click', () => {
  showAuthScreen(state.authMode === 'login' ? 'register' : 'login');
});
document.querySelector('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = document.querySelector('#auth-submit');
  submit.disabled = true;
  document.querySelector('#auth-error').textContent = '';
  const registering = state.authMode === 'register';
  try {
    const result = await apiRequest(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.querySelector('#auth-email').value,
        password: document.querySelector('#auth-password').value,
        workspaceName: document.querySelector('#auth-workspace').value
      })
    });
    state.user = result.user;
    await loadWorkspace();
  } catch (error) {
    document.querySelector('#auth-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.staff = [];
    state.assignments = [];
    showAuthScreen('login', 'You have signed out.');
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector('#team-table').addEventListener('click', async event => {
  const availabilityButton = event.target.closest('[data-staff-id]');
  const removeButton = event.target.closest('[data-remove-id]');
  if (availabilityButton) {
    const person = state.staff.find(item => item.id === availabilityButton.dataset.staffId);
    const day = Number(availabilityButton.dataset.day);
    if (!person || !Number.isInteger(day)) return;
    const unavailable = person.unavailable.includes(day)
      ? person.unavailable.filter(item => item !== day)
      : [...person.unavailable, day];
    if (location.protocol !== 'file:') {
      try {
        await apiRequest(`/api/team/${encodeURIComponent(person.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: person.name, role: person.role, unavailableDays: unavailable })
        });
      } catch (error) {
        showToast(error.message);
        return;
      }
    }
    person.unavailable = unavailable;
    state.assignments = [];
    state.generated = false;
    document.querySelector('#schedule-message').textContent = 'Availability changed. Generate a new draft to update shifts.';
    persistData();
    renderSchedule();
    return;
  }
  if (removeButton) {
    const person = state.staff.find(item => item.id === removeButton.dataset.removeId);
    if (!person) return;
    if (!window.confirm(`Remove ${person.name} from this team?`)) return;
    if (location.protocol !== 'file:') {
      try {
        await apiRequest(`/api/team/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
      } catch (error) {
        showToast(error.message);
        return;
      }
    }
    state.staff = state.staff.filter(item => item.id !== person.id);
    state.assignments = [];
    state.generated = false;
    document.querySelector('#schedule-message').textContent = 'Team updated. Generate a new draft to assign shifts.';
    persistData();
    renderSchedule();
  }
});

renderCurrentDate();
if (location.protocol === 'file:') {
  loadSettings();
  renderSchedule();
} else {
  initializeApiMode();
}
