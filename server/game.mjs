import { createHash, randomBytes, randomUUID } from 'node:crypto';
import campus from '../src/data/campus.json' with { type: 'json' };
import { openDatabase } from './database.mjs';
import { cappedAward, limits, rankPlayers, sessions } from './rules.mjs';

const seededScores = [
  ['seed-1', '北区长跑组', 7, 4220, 88],
  ['seed-2', '星野', 6, 3650, 73],
  ['seed-3', '夜跑阿泽', 6, 3290, 69],
  ['seed-4', '虹桥晚风', 5, 2860, 62],
  ['seed-5', '西区步频', 5, 2670, 60],
  ['seed-6', '向北', 4, 2940, 50],
  ['seed-7', '跑过清凉山', 3, 2500, 43],
  ['seed-8', '橘子汽水', 2, 1920, 31],
  ['seed-9', '南山路过客', 1, 1820, 23],
  ['seed-10', '林间有风', 1, 1600, 21],
  ['seed-11', '一步一景', 0, 1510, 15],
];

const codeHash = (code) => createHash('sha256').update(code).digest('hex');
const zoneOf = (mouseId) => campus.zones.find((zone) => zone.mice.includes(mouseId));

export class GameError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createGame(filename = ':memory:', clock = Date.now) {
  const db = openDatabase(filename);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getPlayer(id) {
    return id ? get('SELECT * FROM players WHERE id = ?', id) : undefined;
  }

  function ensureProgress(player) {
    let progress = get('SELECT * FROM progress WHERE player_id = ? AND stage = ?', player.id, player.stage);
    if (progress) return progress;
    const meters = player.stage === 'evening' ? 1280 : 840;
    const now = clock();
    run('INSERT INTO progress (player_id, stage, meters, last_walk) VALUES (?, ?, ?, ?)',
      player.id, player.stage, meters, now);
    const points = totals(player);
    const distancePoints = Math.min(Math.floor(meters / 100), Math.max(0, limits.dailyDistancePoints - points.distance));
    const award = cappedAward(distancePoints, points.session, points.daily);
    if (award > 0) run('INSERT INTO points VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), player.id, player.stage, 'distance', award, now);
    progress = get('SELECT * FROM progress WHERE player_id = ? AND stage = ?', player.id, player.stage);
    return progress;
  }

  function join() {
    const id = randomBytes(24).toString('base64url');
    run('INSERT INTO players (id, nickname, created_at) VALUES (?, ?, ?)', id, '欧亚体验者', clock());
    return getPlayer(id);
  }

  function totals(player) {
    return get(`
      SELECT
        COALESCE(SUM(CASE WHEN stage = ? THEN amount ELSE 0 END), 0) AS session,
        COALESCE(SUM(amount), 0) AS daily,
        COALESCE(SUM(CASE WHEN source = 'distance' THEN amount ELSE 0 END), 0) AS distance
      FROM points WHERE player_id = ?
    `, player.stage, player.id);
  }

  function updatePlayer(player, fields) {
    transaction(() => {
      const role = fields.role ?? player.role;
      const stage = fields.stage ?? player.stage;
      const sharing = Number(fields.sharing ?? player.sharing);
      const nickname = fields.nickname ?? player.nickname;
      run('UPDATE players SET stage = ?, role = ?, sharing = ?, nickname = ? WHERE id = ?',
        stage, role, sharing, nickname, player.id);
      if (role !== player.role || stage !== player.stage || !sharing) {
        run('UPDATE codes SET used = 1 WHERE player_id = ? AND purpose = ?', player.id, 'mouse');
      }
    });
    return snapshot(getPlayer(player.id));
  }

  function runAction(player, id, kind, work) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(id)) {
      throw new GameError('REQUEST', '请求编号无效，请重新操作。', 400);
    }
    return transaction(() => {
      const previous = get('SELECT kind, result FROM actions WHERE player_id = ? AND request_id = ?', player.id, id);
      if (previous) {
        if (previous.kind !== kind) throw new GameError('REQUEST', '请求编号已使用，请重新操作。');
        return JSON.parse(previous.result);
      }
      const result = work();
      run('INSERT INTO actions VALUES (?, ?, ?, ?)', player.id, id, kind, JSON.stringify(result));
      return result;
    });
  }

  function issueCode(player, mouseId, purpose) {
    if (purpose === 'mouse') {
      if (player.role !== 'mouse' || !player.sharing) throw new GameError('OFFLINE', '开启鼠迹后即可展示二维码。');
      mouseId = 3;
    } else if (player.role !== 'cat' || !zoneOf(mouseId)) {
      throw new GameError('TARGET', '请选择一个有鼠迹的区域。', 400);
    }

    const now = clock();
    const expiresAt = now + limits.codeAge;
    const code = randomBytes(24).toString('base64url');
    const manualCode = purpose === 'mouse' ? makeManualCode() : null;
    transaction(() => {
      run('DELETE FROM codes WHERE expires_at <= ?', now);
      run('DELETE FROM codes WHERE player_id = ? AND purpose = ?', player.id, purpose);
      run('INSERT INTO codes VALUES (?, ?, ?, ?, ?, ?, 0)', codeHash(manualCode ?? code),
        player.id, player.stage, mouseId, purpose, expiresAt);
    });
    return { code: manualCode ?? code, expiresAt };
  }

  function move(player, requestId) {
    return runAction(player, requestId, 'move', () => {
      const progress = ensureProgress(player);
      if (!progress.tracking) throw new GameError('TRACK', '请先开始运动记录。');
      const now = clock();
      const points = totals(player);
      const award = cappedAward(Math.min(1, Math.max(0, limits.dailyDistancePoints - points.distance)), points.session, points.daily);
      const meters = progress.meters + limits.movementMeters;
      run('UPDATE progress SET meters = ?, last_walk = ? WHERE player_id = ? AND stage = ?',
        meters, now, player.id, player.stage);
      if (award > 0) {
        run('INSERT INTO points VALUES (?, ?, ?, ?, ?, ?)',
          randomUUID(), player.id, player.stage, 'distance', award, now);
      }
      return { meters, award };
    });
  }

  function setTracking(player, active) {
    transaction(() => {
      ensureProgress(player);
      run('UPDATE progress SET tracking = ? WHERE player_id = ? AND stage = ?',
        Number(active), player.id, player.stage);
    });
    return snapshot(player);
  }

  function capture(player, requestId, code) {
    return runAction(player, requestId, 'capture', () => {
      if (player.role !== 'cat') throw new GameError('ROLE', '切换到猫阵营后可扫码。');
      if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(code)) {
        throw new GameError('TOKEN', '请扫鼠端二维码，或输入完整捕获码。', 400);
      }
      const now = clock();
      const hash = codeHash(code);
      const token = get('SELECT * FROM codes WHERE hash = ?', hash);
      if (!token || token.expires_at <= now) throw new GameError('TOKEN', '二维码已失效，请扫描刚刷新的码。');
      if (token.stage !== player.stage) throw new GameError('SESSION', '二维码属于另一场次，请切换到同一场次。');
      if (token.purpose === 'sample' && token.player_id !== player.id) throw new GameError('TOKEN', '请在当前演示账号重新取码。');
      if (get('SELECT id FROM captures WHERE player_id = ? AND stage = ? AND mouse_id = ?',
        player.id, player.stage, token.mouse_id)) throw new GameError('SESSION_DUP', '本场已经抓过这只鼠，请选择另一只。');
      if (token.used) throw new GameError('TOKEN', '该码已核销，请扫描刚刷新的码。');
      if (token.purpose === 'mouse') {
        const mouse = getPlayer(token.player_id);
        if (mouse?.role !== 'mouse' || !mouse.sharing) throw new GameError('OFFLINE', '这只鼠已暂停共享。');
      }

      const progress = ensureProgress(player);
      const previous = get('SELECT meters FROM captures WHERE player_id = ? AND stage = ? ORDER BY completed_at DESC, meters DESC LIMIT 1',
        player.id, player.stage);
      const ready = previous
        ? progress.meters - previous.meters >= limits.movementMeters
        : now - progress.last_walk <= limits.initialMovementAge && progress.meters >= limits.movementMeters;
      if (!ready) throw new GameError('STAMINA', '再累计 100 米有效移动后就可以扫码。');
      const zone = zoneOf(token.mouse_id);
      const lock = get('SELECT until FROM cooldowns WHERE stage = ? AND zone_id = ?', player.stage, zone.id);
      if (lock?.until > now) {
        throw new GameError('LOCK', `该点位冷却中，${Math.ceil((lock.until - now) / 1000)} 秒后开放。`);
      }

      const id = randomUUID();
      const points = totals(player);
      const award = cappedAward(limits.capturePoints, points.session, points.daily);
      run('UPDATE codes SET used = 1 WHERE hash = ?', hash);
      run('INSERT INTO captures VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, player.id, player.stage,
        token.mouse_id, zone.id, now, progress.meters, award);
      if (award > 0) run('INSERT INTO points VALUES (?, ?, ?, ?, ?, ?)', id, player.id, player.stage, 'capture', award, now);
      const recent = get('SELECT COUNT(*) AS n FROM captures WHERE stage = ? AND zone_id = ? AND completed_at > ?',
        player.stage, zone.id, now - limits.gridWindow);
      if (recent.n >= limits.gridCaptures) {
        run(`INSERT INTO cooldowns VALUES (?, ?, ?)
          ON CONFLICT(stage, zone_id) DO UPDATE SET until = excluded.until`,
        player.stage, zone.id, now + limits.gridWindow);
      }
      return { id, mouseId: token.mouse_id, zone: zone.name, award, at: now };
    });
  }

  function snapshot(player) {
    return transaction(() => {
      const current = getPlayer(player.id);
      const progress = ensureProgress(current);
      const stage = sessions[current.stage];
      const now = clock();
      const initialOffset = (stage.duration - stage.previewRemaining) * 60_000;
      const remainingMs = stage.duration * 60_000 - ((now - current.created_at + initialOffset) % (stage.duration * 60_000));
      const captures = all(`SELECT mouse_id AS mouseId, zone_id AS zoneId, awarded AS award,
          completed_at AS at, id, meters FROM captures WHERE player_id = ? AND stage = ?
          ORDER BY completed_at DESC, meters DESC`, current.id, current.stage);
      const energy = captures.length
        ? Math.min(100, progress.meters - captures[0].meters)
        : (now - progress.last_walk <= limits.initialMovementAge ? 100 : 0);
      const { session, daily } = totals(current);
      const totalsForDay = get('SELECT SUM(meters) AS meters FROM progress WHERE player_id = ?', current.id);
      const cooldowns = all('SELECT zone_id AS zoneId, until FROM cooldowns WHERE stage = ? AND until > ?', current.stage, now);
      const usedMouseCode = current.role === 'mouse' && get(`
        SELECT expires_at FROM codes
        WHERE player_id = ? AND stage = ? AND purpose = 'mouse' AND used = 1 AND expires_at > ?
        LIMIT 1
      `, current.id, current.stage, now);
      return {
        profile: { nickname: current.nickname, role: current.role, sharing: !!current.sharing },
        stage: { id: current.stage, ...stage, endsAt: now + remainingMs },
        serverTime: now,
        stats: {
          meters: progress.meters,
          dailyMeters: totalsForDay.meters,
          sessionPoints: session,
          dailyPoints: daily,
          captures: captures.length,
          energy,
          tracking: !!progress.tracking,
        },
        captures,
        cooldowns,
        usedMouseCodeExpiry: usedMouseCode?.expires_at ?? null,
      };
    });
  }

  function leaderboard(player, range) {
    const filterStage = range === 'session' ? player.stage : '';
    const sample = seededScores.map(([id, nickname, captures, meters, points], index) => ({
      id, nickname, captures, meters, points, achievedAt: index, mine: false,
    }));
    const real = all(`
      WITH capture_summary AS (
        SELECT player_id, COUNT(*) AS captures, MAX(completed_at) AS achievedAt
        FROM captures WHERE (? = '' OR stage = ?) GROUP BY player_id
      ),
      progress_summary AS (
        SELECT player_id, SUM(meters) AS meters FROM progress WHERE (? = '' OR stage = ?) GROUP BY player_id
      ),
      points_summary AS (
        SELECT player_id, SUM(amount) AS points FROM points WHERE (? = '' OR stage = ?) GROUP BY player_id
      )
      SELECT players.id, nickname, COALESCE(captures, 0) AS captures, achievedAt,
        COALESCE(meters, 0) AS meters, COALESCE(points, 0) AS points
      FROM players
      LEFT JOIN capture_summary ON capture_summary.player_id = players.id
      LEFT JOIN progress_summary ON progress_summary.player_id = players.id
      LEFT JOIN points_summary ON points_summary.player_id = players.id
      WHERE players.id = ? OR COALESCE(captures, 0) > 0
    `, filterStage, filterStage, filterStage, filterStage, filterStage, filterStage, player.id);
    return rankPlayers([...sample, ...real.map((row) => ({ ...row, mine: row.id === player.id }))])
      .map(({ id, achievedAt, ...visible }) => visible);
  }

  return { getPlayer, join, updatePlayer, issueCode, capture, setTracking, move, snapshot, leaderboard, close: () => db.close() };
}

function makeManualCode() {
  return randomBytes(8).toString('hex').toUpperCase();
}
