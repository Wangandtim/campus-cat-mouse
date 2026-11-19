export const limits = Object.freeze({
  capturePoints: 10,
  sessionPoints: 100,
  dailyPoints: 200,
  dailyDistancePoints: 30,
  movementMeters: 100,
  initialMovementAge: 15 * 60_000,
  codeAge: 30_000,
  gridWindow: 30_000,
  gridCaptures: 5,
});

export const sessions = Object.freeze({
  morning: { label: '早场', hours: '06:30–08:10', duration: 100, previewRemaining: 42 },
  evening: { label: '晚场', hours: '17:30–20:30', duration: 180, previewRemaining: 76 },
});

export function cappedAward(requested, sessionPoints, dailyPoints) {
  return Math.max(0, Math.min(
    requested,
    limits.sessionPoints - sessionPoints,
    limits.dailyPoints - dailyPoints,
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
