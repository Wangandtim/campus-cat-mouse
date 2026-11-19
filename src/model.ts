import campusData from './data/campus.json';

export type Position = [longitude: number, latitude: number];
export type Zone = { id: string; name: string; position: Position; radius: number; mice: number[] };
export const campus = campusData as Omit<typeof campusData, 'center' | 'boundary' | 'demoPosition' | 'zones'> & {
  center: Position;
  boundary: Position[];
  demoPosition: Position;
  zones: Zone[];
};

export type Role = 'cat' | 'mouse';
export type StageId = 'morning' | 'evening';
export type Profile = { nickname: string; role: Role; sharing: boolean };
export type CaptureResult = { id: string; mouseId: number; zone: string; award: number; at: number };
export type IssuedCode = { code: string; expiresAt: number };

export type GameState = {
  profile: Profile;
  stage: { id: StageId; label: string; hours: string; endsAt: number };
  serverTime: number;
  stats: {
    meters: number;
    dailyMeters: number;
    sessionPoints: number;
    dailyPoints: number;
    captures: number;
    energy: number;
    tracking: boolean;
  };
  captures: { id: string; mouseId: number; zoneId: string; award: number; at: number }[];
  cooldowns: { zoneId: string; until: number }[];
  usedMouseCodeExpiry: number | null;
};

export type RankRow = {
  rank: number;
  nickname: string;
  captures: number;
  meters: number;
  points: number;
  mine: boolean;
};

export type ZoneView = Zone & { distance: number; available: number[]; cooldown: number };

export class ApiError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export async function request<T>(path: string, body?: object, id?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(id ? { 'Idempotency-Key': id } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('网络暂时不可用，请重试。', 'NETWORK');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    throw new ApiError(data?.message ?? '活动服务暂时不可用。', data?.code ?? 'SERVER');
  }
  return data as T;
}

export function metersBetween(a: Position, b: Position) {
  const latitudeRadians = (a[1] + b[1]) / 2 * Math.PI / 180;
  return Math.round(Math.hypot((a[0] - b[0]) * Math.cos(latitudeRadians), a[1] - b[1]) * 111_195);
}

export const kilometers = (meters: number) => (meters / 1000).toFixed(2);
export const distanceLabel = (meters: number) => meters < 1000 ? `${meters} 米` : `${kilometers(meters)} 公里`;
export const shanghaiTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
});
