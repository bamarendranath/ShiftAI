(function exposeScheduleCore(global) {
  const shifts = [
    { key: 'morning', start: 8, end: 16 },
    { key: 'evening', start: 16, end: 24 }
  ];

  function generateWeeklyShifts(members, limits) {
    if (!Array.isArray(members) || !limits ||
        !Number.isInteger(Number(limits.weeklyHoursCap)) ||
        Number(limits.weeklyHoursCap) < 8 || Number(limits.weeklyHoursCap) > 60 ||
        !Number.isInteger(Number(limits.minimumRestHours)) ||
        Number(limits.minimumRestHours) < 8 || Number(limits.minimumRestHours) > 24) {
      throw new TypeError('Valid team members and planning limits are required.');
    }

    const hoursByMember = members.map(() => 0);
    const lastShiftByMember = members.map(() => null);
    const assignments = [];

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      for (const shift of shifts) {
        const eligible = members.map((member, memberIndex) => {
          const unavailableDays = member.unavailableDays || [];
          if (unavailableDays.includes(dayIndex)) return null;
          if (hoursByMember[memberIndex] + 8 > Number(limits.weeklyHoursCap)) return null;

          const last = lastShiftByMember[memberIndex];
          if (last) {
            const restHours = (dayIndex - last.dayIndex) * 24 + shift.start - last.end;
            if (restHours < Number(limits.minimumRestHours)) return null;
          }

          return { memberIndex, hours: hoursByMember[memberIndex] };
        }).filter(Boolean).sort((a, b) => a.hours - b.hours || a.memberIndex - b.memberIndex);

        const selected = eligible[0];
        assignments.push({
          dayIndex,
          shiftKey: shift.key,
          memberId: selected ? members[selected.memberIndex].id : null
        });
        if (selected) {
          hoursByMember[selected.memberIndex] += 8;
          lastShiftByMember[selected.memberIndex] = { dayIndex, end: shift.end };
        }
      }
    }

    return assignments;
  }

  function localDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  }

  function localDateString(date, timeZone) {
    const parts = localDateParts(date, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function zonedDateTimeToDate(dateString, timeString, timeZone) {
    const [year, month, day] = dateString.split('-').map(Number);
    const [hour, minute] = timeString.split(':').map(Number);
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let timestamp = target;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = localDateParts(new Date(timestamp), timeZone);
      const represented = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute)
      );
      const difference = represented - target;
      if (difference === 0) return new Date(timestamp);
      timestamp -= difference;
    }

    throw new RangeError('The selected local time does not exist in this time zone.');
  }

  function nextAutomationDate(day, time, timeZone, after = new Date()) {
    if (!Number.isInteger(day) || day < 0 || day > 6 ||
        typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
        !(after instanceof Date) || Number.isNaN(after.valueOf())) {
      throw new TypeError('A valid weekday, 24-hour time, and date are required.');
    }

    const localDate = localDateString(after, timeZone);
    const [year, month, date] = localDate.split('-').map(Number);
    const localMidnight = new Date(Date.UTC(year, month - 1, date));

    for (let offset = 0; offset <= 7; offset += 1) {
      const candidateDate = new Date(localMidnight);
      candidateDate.setUTCDate(candidateDate.getUTCDate() + offset);
      if (candidateDate.getUTCDay() !== day) continue;

      const candidate = zonedDateTimeToDate(
        candidateDate.toISOString().slice(0, 10),
        time,
        timeZone
      );
      if (candidate > after) return candidate;
    }

    throw new RangeError('Could not find the next automation date.');
  }

  function nextMondayAfter(localDate) {
    const date = new Date(`${localDate}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== localDate) {
      throw new TypeError('A valid local date is required.');
    }
    date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7 || 7));
    return date.toISOString().slice(0, 10);
  }

  function mondayOf(localDate) {
    const date = new Date(`${localDate}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== localDate) {
      throw new TypeError('A valid local date is required.');
    }
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  }

  function weekStartForDueAutomation(dueAt, now, timeZone) {
    const scheduledWeekStart = nextMondayAfter(localDateString(dueAt, timeZone));
    const currentDate = localDateString(now, timeZone);
    const currentWeekStart = mondayOf(currentDate);
    const scheduledWeekEnd = new Date(`${scheduledWeekStart}T00:00:00Z`);
    scheduledWeekEnd.setUTCDate(scheduledWeekEnd.getUTCDate() + 6);
    const lastScheduledWeekDay = scheduledWeekEnd.toISOString().slice(0, 10);
    if (scheduledWeekStart < currentWeekStart || currentDate >= lastScheduledWeekDay) {
      return nextMondayAfter(currentDate);
    }
    return scheduledWeekStart;
  }

  const api = {
    generateWeeklyShifts,
    localDateString,
    mondayOf,
    nextAutomationDate,
    nextMondayAfter,
    weekStartForDueAutomation
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.RosterlySchedule = api;
})(globalThis);
