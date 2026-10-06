/**
 * The local date (YYYY-MM-DD) of the most recent daily window at or before `now`: today's if
 * `runAt` has passed in `timeZone`, otherwise yesterday's. A replica that was down through a
 * window therefore still owes that day's run when it comes back — catch-up needs no extra rule.
 */
export function dueRunDate(now: Date, runAt: string, timeZone: string): string {
  const local = localParts(now, timeZone);
  const [hour, minute] = runAt.split(':').map(Number);
  const passed = local.hour > hour || (local.hour === hour && local.minute >= minute);
  if (passed) return local.date;
  const yesterday = new Date(Date.UTC(local.year, local.month - 1, local.day - 1));
  return yesterday.toISOString().slice(0, 10);
}

function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const [year, month, day] = [Number(get('year')), Number(get('month')), Number(get('day'))];
  return { year, month, day, hour: Number(get('hour')), minute: Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}
