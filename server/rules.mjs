import campus from '../src/data/campus.json' with { type: 'json' };

export const limits = Object.freeze({
  capturePoints: 10,
  sessionPoints: 120,
  dailyPoints: 250,
  dailyDistancePoints: 30,
  movementMeters: 100,
  initialMovementAge: 15 * 60_000,
  codeAge: 30_000,
  captureDistance: 30,
  positionAccuracy: 50,
  positionAge: 30_000,
  gridMeters: 30,
  gridWindow: 30_000,
  gridCaptures: 5,
  mileageAccuracy: 80,
  mileageSpeed: 4.5,
  mileageGap: 30_000,
  mousePauseSeconds: 15 * 60,
});

export const previewCaps = Object.freeze({ sessionPoints: 100, dailyPoints: 200 });

export const sessions = Object.freeze({
  morning: { label: '早场', hours: '06:30–08:10', duration: 100, previewRemaining: 42 },
  evening: { label: '晚场', hours: '17:30–20:30', duration: 180, previewRemaining: 76 },
});

const shanghaiDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function eventDate(now) {
  return shanghaiDate.format(now);
}

const defaultEventEnd = eventDate(Date.parse(`${campus.startDate}T00:00:00+08:00`) + 30 * 86_400_000);
let eventWindowState = Object.freeze({ startDate: campus.startDate, endDate: defaultEventEnd });

const validDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00+08:00`)) && eventDate(Date.parse(`${value}T00:00:00+08:00`)) === value;

export function configureEventWindow(startDate, endDate) {
  if (!validDay(startDate) || !validDay(endDate) || endDate < startDate) {
    throw new Error('活动日期范围无效。');
  }
  eventWindowState = Object.freeze({ startDate, endDate });
  return eventWindowState;
}

export function eventWindow() {
  return eventWindowState;
}

export function sessionWindow(day, stage) {
  const hours = Object.hasOwn(sessions, stage) && sessions[stage].hours;
  if (!hours) return null;
  const [start, end] = hours.split('–');
  const startsAt = Date.parse(`${day}T${start}:00+08:00`);
  const endsAt = Date.parse(`${day}T${end}:00+08:00`);
  if (!Number.isFinite(startsAt) || eventDate(startsAt) !== day) return null;
  return { id: `${day}:${stage}`, startsAt, endsAt };
}

export function activeEvent(stage, now) {
  const day = eventDate(now);
  const { startDate, endDate } = eventWindowState;
  if (day < startDate || day > endDate) return null;
  const session = sessionWindow(day, stage);
  return session && now >= session.startsAt && now < session.endsAt ? session : null;
}

export function validGender(value) {
  return value === 'male' || value === 'female';
}

export function catRequirement(stage, gender) {
  return stage === 'morning'
    ? { meters: 2000, seconds: gender === 'male' ? 17 * 60 : 20 * 60 }
    : { meters: 3000, seconds: gender === 'male' ? 25 * 60 + 30 : 30 * 60 };
}

export function mileagePoints(role, meters) {
  const first = role === 'mouse' ? 3000 : 2000;
  return Number(meters >= first) + 3 * Number(meters >= first + 6000) + 10 * Number(meters >= 10_000);
}

export const campusFence = { type: 'Polygon', coordinates: [campus.boundary] };

export function validPosition({ lat, lng, accuracy }) {
  return Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    Number.isFinite(lng) && Math.abs(lng) <= 180 &&
    Number.isFinite(accuracy) && accuracy >= 0;
}

export function cappedAward(requested, sessionPoints, dailyPoints, caps = limits) {
  return Math.max(0, Math.min(
    requested,
    caps.sessionPoints - sessionPoints,
    caps.dailyPoints - dailyPoints,
  ));
}

export function rankPlayers(rows) {
  return [...rows].sort((a, b) => (
    b.captures - a.captures
    || b.meters - a.meters
    || (a.achievedAt ?? Infinity) - (b.achievedAt ?? Infinity)
    || a.id.localeCompare(b.id, 'en')
  )).map((row, index) => ({ ...row, rank: index + 1 }));
}
