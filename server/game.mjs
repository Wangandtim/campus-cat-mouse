import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { distance } from '@turf/distance';
import campus from '../src/data/campus.json' with { type: 'json' };
import { openSqliteStore } from './database.mjs';
import { activeEvent, campusFence, cappedAward, eventDate, limits, previewCaps, rankPlayers,
  sessions, sessionWindow, validGender, validPosition } from './rules.mjs';
import { eventId } from './db/migrations.mjs';
import { changeParticipation, createParticipation, earnedPoints, markDataGap, participationOf,
  settleDueSessions } from './db/participation.mjs';

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
const [campusLng, campusLat] = campus.center;
const metersPerDegree = 111_195;
const metersPerLongitudeDegree = metersPerDegree * Math.cos(campusLat * Math.PI / 180);

function gridOf([lng, lat]) {
  const x = Math.floor((lng - campusLng) * metersPerLongitudeDegree / limits.gridMeters);
  const y = Math.floor((lat - campusLat) * metersPerDegree / limits.gridMeters);
  return `${x}:${y}`;
}

export class GameError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createGame(database = ':memory:', clock = Date.now) {
  const store = typeof database === 'string' ? openSqliteStore(database) : database;
  const { users, ledger } = store.tables;
  let autoStage = false;

  function playerOf(query, id) {
    return id ? query.get(`SELECT id, nickname, role, stage, sharing, created_at, gender, openid IS NOT NULL AS registered
      FROM ${users} WHERE id = ?`, id) : undefined;
  }

  async function ensureProgress(tx, player) {
    const progress = await tx.get('SELECT * FROM progress WHERE player_id = ? AND stage = ?', player.id, player.stage);
    if (progress) return progress;
    const meters = player.stage === 'evening' ? 1280 : 840;
    const now = clock();
    await tx.run('INSERT INTO progress (player_id, stage, meters, last_walk) VALUES (?, ?, ?, ?)',
      player.id, player.stage, meters, now);
    const points = await totals(tx, player);
    const distancePoints = Math.min(Math.floor(meters / 100), Math.max(0, limits.dailyDistancePoints - points.distance));
    const award = cappedAward(distancePoints, points.session, points.daily, previewCaps);
    if (award > 0) await tx.addPoints(randomUUID(), player.id, player.stage, 'distance', award, now);
    return tx.get('SELECT * FROM progress WHERE player_id = ? AND stage = ?', player.id, player.stage);
  }

  function join() {
    const id = randomBytes(24).toString('base64url');
    return store.transaction(async (tx) => {
      await tx.run(`INSERT INTO ${users} (id, nickname, created_at) VALUES (?, ?, ?)`, id, '欧亚体验者', clock());
      return playerOf(tx, id);
    });
  }

  function totals(query, player) {
    return query.get(`
      SELECT
        COALESCE(SUM(CASE WHEN stage = ? THEN amount ELSE 0 END), 0) AS session,
        COALESCE(SUM(amount), 0) AS daily,
        COALESCE(SUM(CASE WHEN source = 'distance' THEN amount ELSE 0 END), 0) AS distance
      FROM ${ledger} WHERE player_id = ? AND amount > 0
    `, player.stage, player.id);
  }

  async function updatePlayer(player, fields) {
    await store.transaction(async (tx) => {
      await tx.lockPlayers([player.id]);
      const current = await playerOf(tx, player.id);
      const role = fields.role ?? current.role;
      const stage = fields.stage ?? current.stage;
      const sharing = Number(fields.sharing ?? current.sharing);
      const nickname = fields.nickname ?? current.nickname;
      if (current.registered && (role !== current.role || stage !== current.stage)) {
        const now = clock();
        const session = activeEvent(current.stage, now);
        if (session) await changeParticipation(tx, await participationOf(tx, session.id, player.id), 'exited', now);
      }
      await tx.run(`UPDATE ${users} SET stage = ?, role = ?, sharing = ?, nickname = ? WHERE id = ?`,
        stage, role, sharing, nickname, player.id);
      if (role !== current.role || stage !== current.stage || !sharing) {
        await tx.run('UPDATE codes SET used = 1 WHERE player_id = ? AND purpose = ?', player.id, 'mouse');
      }
    });
    return snapshot(player);
  }

  async function runAction(player, id, kind, work) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(id)) {
      throw new GameError('REQUEST', '请求编号无效，请重新操作。', 400);
    }
    return store.transaction(async (tx) => {
      const action = await tx.claimAction(player.id, id, kind);
      if (action.kind !== kind) throw new GameError('REQUEST', '请求编号已使用，请重新操作。');
      if (action.result !== '') return JSON.parse(action.result);
      const result = await work(tx);
      await tx.run('UPDATE actions SET result = ? WHERE player_id = ? AND request_id = ?', JSON.stringify(result), player.id, id);
      return result;
    });
  }

  function issueCode(player, mouseId, purpose) {
    return store.transaction(async (tx) => {
      await tx.lockPlayers([player.id]);
      const current = await playerOf(tx, player.id);
      if (purpose === 'sample' && current.registered) throw new GameError('DEMO_ONLY', '模拟扫码仅用于体验。', 403);
      if (purpose === 'mouse') {
        if (current.role !== 'mouse' || !current.sharing) throw new GameError('OFFLINE', '开启鼠迹后即可展示二维码。');
      } else if (current.role !== 'cat' || !zoneOf(mouseId)) {
        throw new GameError('TARGET', '请选择一个有鼠迹的区域。', 400);
      }

      const now = clock();
      const expiresAt = now + limits.codeAge;
      const code = purpose === 'mouse' ? makeManualCode() : randomBytes(24).toString('base64url');
      await tx.run('DELETE FROM codes WHERE expires_at <= ?', now);
      await tx.run('DELETE FROM codes WHERE player_id = ? AND purpose = ?', player.id, purpose);
      await tx.run('INSERT INTO codes (hash, player_id, stage, mouse_id, purpose, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, 0)',
        codeHash(code), player.id, current.stage, purpose === 'mouse' ? 3 : mouseId, purpose, expiresAt);
      return { code, expiresAt };
    });
  }

  function move(player, requestId) {
    return runAction(player, requestId, 'move', async (tx) => {
      await tx.lockPlayers([player.id]);
      const current = await playerOf(tx, player.id);
      if (current.registered) throw new GameError('DEMO_ONLY', '活动里程由定位记录。', 403);
      const progress = await ensureProgress(tx, current);
      if (!progress.tracking) throw new GameError('TRACK', '请先开始运动记录。');
      const now = clock();
      const points = await totals(tx, current);
      const award = cappedAward(Math.min(1, Math.max(0, limits.dailyDistancePoints - points.distance)),
        points.session, points.daily, previewCaps);
      const meters = progress.meters + limits.movementMeters;
      await tx.run('UPDATE progress SET meters = ?, last_walk = ? WHERE player_id = ? AND stage = ?',
        meters, now, player.id, current.stage);
      if (award > 0) await tx.addPoints(randomUUID(), player.id, current.stage, 'distance', award, now);
      return { meters, award };
    });
  }

  async function setTracking(player, active, sessionId) {
    if (player.registered) {
      await setParticipation(player, active ? 'active' : 'paused', sessionId);
      return snapshot(player);
    }
    await store.transaction(async (tx) => {
      await tx.lockPlayers([player.id]);
      const current = await playerOf(tx, player.id);
      await ensureProgress(tx, current);
      await tx.run('UPDATE progress SET tracking = ? WHERE player_id = ? AND stage = ?',
        Number(active), player.id, current.stage);
    });
    return snapshot(player);
  }

  function setParticipation(player, status, expectedSession) {
    if (!player?.registered) return;
    return store.transaction(async (tx) => {
      const initial = activeEvent(player.stage, clock());
      if (!initial || (expectedSession !== undefined && initial.id !== expectedSession)) {
        if (status === 'active') throw new GameError('SESSION', '请在本场活动时间内开始参与。');
        return;
      }
      if (status === 'active') {
        await tx.ensureSession(initial.id);
        const task = await tx.lockSettlement(initial.id);
        if (task.settled_at !== null) throw new GameError('SESSION', '本场已结算。');
      }
      await tx.lockPlayers([player.id]);
      const current = await playerOf(tx, player.id);
      const now = clock();
      if (activeEvent(current.stage, now)?.id !== initial.id) {
        if (status === 'active') throw new GameError('SESSION', '请在本场活动时间内开始参与。');
        return;
      }
      if (status === 'active' && !validGender(current.gender)) {
        throw new GameError('GENDER', '请先补齐报名资料。', 403);
      }
      const row = await participationOf(tx, initial.id, current.id);
      if (!row && status === 'active') await createParticipation(tx, initial.id, current, now);
      else await changeParticipation(tx, row, status, now);
    });
  }

  function dataGap(player, sessionId, reason) {
    if (!player.registered) return;
    return store.transaction(async (tx) => {
      await tx.lockPlayers([player.id]);
      const current = await playerOf(tx, player.id);
      if (activeEvent(current.stage, clock())?.id !== sessionId) return;
      await markDataGap(tx, await participationOf(tx, sessionId, player.id), reason);
    });
  }

  function capturePosition(position, role, session, now) {
    if (!position) throw new GameError('ACCURACY', '请猫鼠双方开启定位后再试。');
    if (position.session_id !== session.id || position.role !== role || position.updated_at < session.startsAt) {
      throw new GameError('SESSION', '请猫鼠双方在当前场次重新获取定位。');
    }
    if (!validPosition(position) || position.accuracy > limits.positionAccuracy ||
        !Number.isFinite(position.updated_at) || position.updated_at > now || now - position.updated_at > limits.positionAge) {
      throw new GameError('ACCURACY', '猫鼠双方需刷新定位，定位误差须在 50 米以内。');
    }
    return [position.lng, position.lat];
  }

  function capture(cat, requestId, code) {
    return runAction(cat, requestId, 'capture', async (tx) => {
      const hash = typeof code === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(code) ? codeHash(code) : null;
      // Look up the issuer without a lock so both player rows can be locked in ID order.
      const issuer = hash ? await tx.get('SELECT player_id FROM codes WHERE hash = ?', hash) : undefined;
      await tx.lockPlayers(issuer ? [cat.id, issuer.player_id] : [cat.id]);
      const player = await playerOf(tx, cat.id);
      if (player?.role !== 'cat') throw new GameError('ROLE', '切换到猫阵营后可扫码。');
      if (!hash) {
        throw new GameError('TOKEN', '请扫鼠端二维码，或输入完整捕获码。', 400);
      }
      const token = await tx.lockCode(hash);
      let now = clock();
      if (!token || token.player_id !== issuer?.player_id || token.expires_at <= now) {
        throw new GameError('TOKEN', '二维码已失效，请扫描刚刷新的码。');
      }
      if (token.stage !== player.stage) throw new GameError('SESSION', '二维码属于另一场次，请切换到同一场次。');
      if (token.purpose === 'sample' && token.player_id !== player.id) throw new GameError('TOKEN', '请在当前演示账号重新取码。');
      const mouseCode = token.purpose === 'mouse';
      if (!mouseCode && player.registered) throw new GameError('DEMO_ONLY', '模拟扫码仅用于体验。', 403);
      const session = mouseCode ? activeEvent(player.stage, now) : null;
      if (mouseCode && !session) throw new GameError('SESSION', '当前不在本场的抓捕时间内。');
      const duplicate = session
        ? await tx.get('SELECT 1 FROM captures WHERE session_id = ? AND player_id = ? AND mouse_player_id = ?',
          session.id, player.id, token.player_id)
        : await tx.get('SELECT 1 FROM captures WHERE session_id IS NULL AND player_id = ? AND stage = ? AND mouse_id = ?',
          player.id, player.stage, token.mouse_id);
      if (duplicate) throw new GameError('SESSION_DUP', '本场已经抓过这只鼠，请选择另一只。');
      if (token.used) throw new GameError('TOKEN', '该码已核销，请扫描刚刷新的码。');
      const zone = zoneOf(token.mouse_id);
      let gridId = null;
      if (session) {
        const mouse = await playerOf(tx, token.player_id);
        if (mouse?.role !== 'mouse' || !mouse.sharing) throw new GameError('OFFLINE', '这只鼠已暂停共享。');
        if (mouse.stage !== player.stage) throw new GameError('SESSION', '请猫鼠双方切换到同一场次。');
        const catPosition = await tx.getPosition(player.id);
        const mousePosition = await tx.getPosition(mouse.id);
        const catPoint = capturePosition(catPosition, 'cat', session, now);
        const mousePoint = capturePosition(mousePosition, 'mouse', session, now);
        if (!booleanPointInPolygon(catPoint, campusFence) || !booleanPointInPolygon(mousePoint, campusFence)) {
          throw new GameError('FENCE', '猫鼠双方都在校园围栏内时才可抓捕。');
        }
        if (distance(catPoint, mousePoint, { units: 'meters' }) > limits.captureDistance) {
          throw new GameError('DISTANCE', '离鼠鼠太远了，请靠近到 30 米内再试。');
        }
        gridId = gridOf(mousePoint);
        await tx.lockGrid(session.id, gridId);
        now = clock();
        if (activeEvent(player.stage, now)?.id !== session.id) throw new GameError('SESSION', '当前不在本场的抓捕时间内。');
        capturePosition(catPosition, 'cat', session, now);
        capturePosition(mousePosition, 'mouse', session, now);
      } else {
        await tx.lockZone(player.stage, zone.id);
        now = clock();
      }
      if (token.expires_at <= now) throw new GameError('TOKEN', '二维码已失效，请扫描刚刷新的码。');

      const participation = player.registered ? await participationOf(tx, session.id, player.id) : undefined;
      if (player.registered && (participation?.status !== 'active' || participation.gap_started_at !== null ||
          participation.last_sample_at === null || now - participation.last_sample_at > limits.mileageGap)) {
        throw new GameError('TRACK', '请先开始参与并保持定位。');
      }
      const progress = participation
        ? { meters: participation.valid_meters, last_walk: participation.last_movement_at }
        : await ensureProgress(tx, player);
      const previousMeters = participation ? participation.last_capture_meters
        : (await tx.get('SELECT meters FROM captures WHERE player_id = ? AND stage = ? ORDER BY completed_at DESC, meters DESC LIMIT 1',
          player.id, player.stage))?.meters ?? null;
      const ready = previousMeters !== null
        ? progress.meters - previousMeters >= limits.movementMeters
        : now - progress.last_walk <= limits.initialMovementAge && progress.meters >= limits.movementMeters;
      if (!ready) throw new GameError('STAMINA', '再累计 100 米有效移动后就可以扫码。');
      const grid = session && await tx.gridHistory(session.id, gridId, now - limits.gridWindow);
      const lockedUntil = session ? grid.until
        : (await tx.get('SELECT until FROM cooldowns WHERE stage = ? AND zone_id = ?', player.stage, zone.id))?.until;
      if (lockedUntil > now) {
        throw new GameError('LOCK', `该点位冷却中，${Math.ceil((lockedUntil - now) / 1000)} 秒后开放。`);
      }

      const id = randomUUID();
      const points = participation ? await earnedPoints(tx, ledger, player.id, session.id) : await totals(tx, player);
      const award = cappedAward(limits.capturePoints, points.session, points.daily, participation ? limits : previewCaps);
      const gridLockUntil = grid && grid.count + 1 >= limits.gridCaptures ? now + limits.gridWindow : null;
      await tx.run('UPDATE codes SET used = 1 WHERE hash = ?', hash);
      await tx.run(`INSERT INTO captures (id, player_id, stage, mouse_id, zone_id, completed_at, meters, awarded,
          session_id, mouse_player_id, grid_id, grid_lock_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, player.id, player.stage, token.mouse_id, zone.id, now, Math.floor(progress.meters), award,
        session?.id ?? null, session ? token.player_id : null, gridId, gridLockUntil);
      if (participation) {
        await tx.run(`UPDATE participation_sessions SET last_capture_meters = ?
          WHERE event_id = ? AND session_id = ? AND player_id = ?`, progress.meters, eventId, session.id, player.id);
      }
      if (award > 0) await tx.addPoints(id, player.id, player.stage, 'capture', award, now, session?.id);
      if (!session) {
        const recent = await tx.get(`SELECT COUNT(*) AS n FROM captures
          WHERE session_id IS NULL AND stage = ? AND zone_id = ? AND completed_at > ?`,
        player.stage, zone.id, now - limits.gridWindow);
        if (recent.n >= limits.gridCaptures) {
          await tx.setZoneCooldown(player.stage, zone.id, now + limits.gridWindow);
        }
      }
      return { id, mouseId: token.mouse_id, zone: zone.name, award, at: now };
    });
  }

  function snapshot(player) {
    return store.transaction(async (tx) => {
      await tx.lockPlayers([player.id]);
      const current = await playerOf(tx, player.id);
      if (current.registered) {
        if (autoStage) {
          const now = clock();
          const activeStage = ['morning', 'evening'].find((stage) => activeEvent(stage, now));
          if (activeStage && current.stage !== activeStage) {
            await tx.run(`UPDATE ${users} SET stage = ? WHERE id = ?`, activeStage, current.id);
            current.stage = activeStage;
          }
        }
        return participationSnapshot(tx, current, clock());
      }
      const progress = await ensureProgress(tx, current);
      const stage = sessions[current.stage];
      const now = clock();
      const initialOffset = (stage.duration - stage.previewRemaining) * 60_000;
      const remainingMs = stage.duration * 60_000 - ((now - current.created_at + initialOffset) % (stage.duration * 60_000));
      const captures = await tx.all(`SELECT mouse_id AS mouseId, zone_id AS zoneId, awarded AS award,
          completed_at AS at, id, meters FROM captures WHERE player_id = ? AND stage = ?
          ORDER BY completed_at DESC, meters DESC`, current.id, current.stage);
      const energy = captures.length
        ? Math.min(100, progress.meters - captures[0].meters)
        : (now - progress.last_walk <= limits.initialMovementAge ? 100 : 0);
      const { session, daily } = await totals(tx, current);
      const totalsForDay = await tx.get('SELECT SUM(meters) AS meters FROM progress WHERE player_id = ?', current.id);
      const cooldowns = await tx.all('SELECT zone_id AS zoneId, until FROM cooldowns WHERE stage = ? AND until > ?', current.stage, now);
      const usedMouseCode = current.role === 'mouse' && await tx.get(`
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

  async function participationSnapshot(tx, player, now) {
    const day = eventDate(now);
    const window = sessionWindow(day, player.stage);
    const row = await participationOf(tx, window.id, player.id);
    const open = !!activeEvent(player.stage, now);
    const { session, daily } = await earnedPoints(tx, ledger, player.id, window.id);
    const { balance } = await tx.get(`SELECT COALESCE(SUM(amount), 0) AS balance FROM ${ledger} WHERE player_id = ?`,
      player.id);
    const { dailyMeters } = await tx.get(`SELECT COALESCE(SUM(valid_meters), 0) AS dailyMeters
      FROM participation_sessions WHERE event_id = ? AND player_id = ? AND session_id IN (?, ?) AND status <> 'void'`,
    eventId, player.id, `${day}:morning`, `${day}:evening`);
    const captures = await tx.all(`SELECT mouse_id AS mouseId, zone_id AS zoneId, awarded AS award,
        completed_at AS at, id, meters FROM captures WHERE player_id = ? AND session_id = ?
        ORDER BY completed_at DESC, meters DESC`, player.id, window.id);
    const meters = row?.status === 'void' ? 0 : Math.floor(row?.valid_meters ?? 0);
    const tracking = open && row?.status === 'active';
    const dataGap = tracking && (row.gap_started_at !== null ||
      now - (row.last_sample_at ?? row.status_at) > limits.mileageGap);
    const energy = tracking && !dataGap && row.last_sample_at !== null &&
      (row.last_capture_meters !== null || (row.last_movement_at !== null && now - row.last_movement_at <= limits.initialMovementAge))
      ? Math.min(100, Math.max(0, Math.floor(row.valid_meters - (row.last_capture_meters ?? 0)))) : 0;
    const usedMouseCode = player.role === 'mouse' && await tx.get(`SELECT expires_at FROM codes
      WHERE player_id = ? AND stage = ? AND purpose = 'mouse' AND used = 1 AND expires_at > ? LIMIT 1`,
    player.id, player.stage, now);
    return {
      profile: { nickname: player.nickname, role: player.role, sharing: !!player.sharing },
      stage: { id: player.stage, ...sessions[player.stage], endsAt: window.endsAt },
      serverTime: now,
      stats: {
        meters, dailyMeters: Math.floor(dailyMeters), sessionPoints: session, dailyPoints: daily,
        captures: captures.length, energy, tracking, balance, availablePoints: Math.max(balance, 0),
      },
      participation: {
        sessionId: window.id, open, status: row?.status ?? 'idle', dataGap,
        startedAt: row?.started_at ?? null, completedAt: row?.completed_at ?? null,
        deadline: row?.max_seconds ? Math.min(window.endsAt, row.started_at + row.max_seconds * 1000) : null,
        requiredMeters: row?.required_meters ?? null,
      },
      captures: row?.status === 'void' ? captures.map((item) => ({ ...item, award: 0, voided: true })) : captures,
      cooldowns: [],
      usedMouseCodeExpiry: usedMouseCode?.expires_at ?? null,
    };
  }

  async function leaderboard(player, range) {
    if (player.registered) return participationLeaderboard(player, range);
    const filterStage = range === 'session' ? player.stage : '';
    const sample = seededScores.map(([id, nickname, captures, meters, points], index) => ({
      id, nickname, captures, meters, points, achievedAt: index, mine: false,
    }));
    const real = await store.read((query) => query.all(`
      WITH capture_summary AS (
        SELECT player_id, COUNT(*) AS captures, MAX(completed_at) AS achievedAt
        FROM captures WHERE (? = '' OR stage = ?) GROUP BY player_id
      ),
      progress_summary AS (
        SELECT player_id, SUM(meters) AS meters FROM progress WHERE (? = '' OR stage = ?) GROUP BY player_id
      ),
      points_summary AS (
        SELECT player_id, SUM(amount) AS points FROM ${ledger} WHERE (? = '' OR stage = ?) GROUP BY player_id
      )
      SELECT players.id, nickname, COALESCE(captures, 0) AS captures, achievedAt,
        COALESCE(meters, 0) AS meters, COALESCE(points, 0) AS points
      FROM ${users} AS players
      LEFT JOIN capture_summary ON capture_summary.player_id = players.id
      LEFT JOIN progress_summary ON progress_summary.player_id = players.id
      LEFT JOIN points_summary ON points_summary.player_id = players.id
      WHERE players.id = ? OR COALESCE(captures, 0) > 0
    `, filterStage, filterStage, filterStage, filterStage, filterStage, filterStage, player.id));
    return rankPlayers([...sample, ...real.map((row) => ({ ...row, mine: row.id === player.id }))])
      .map(({ id, achievedAt, ...visible }) => visible);
  }

  async function participationLeaderboard(player, range) {
    const day = eventDate(clock());
    const ids = range === 'session' ? [`${day}:${player.stage}`, `${day}:${player.stage}`]
      : [`${day}:morning`, `${day}:evening`];
    const rows = await store.read((tx) => tx.all(`
      WITH capture_summary AS (
        SELECT c.player_id, COUNT(*) AS captures, MAX(c.completed_at) AS achievedAt
        FROM captures c INNER JOIN participation_sessions p ON p.player_id = c.player_id AND p.session_id = c.session_id
        WHERE p.event_id = ? AND c.session_id IN (?, ?) AND p.status <> 'void' GROUP BY c.player_id
      ), mileage_summary AS (
        SELECT player_id, SUM(valid_meters) AS meters FROM participation_sessions
        WHERE event_id = ? AND session_id IN (?, ?) AND status <> 'void' GROUP BY player_id
      ), points_summary AS (
        SELECT player_id, SUM(amount) AS points FROM ${ledger} WHERE session_id IN (?, ?)
          AND (amount > 0 OR source = 'capture_reversal') GROUP BY player_id
      )
      SELECT u.id, u.nickname, COALESCE(c.captures, 0) AS captures, c.achievedAt,
        COALESCE(m.meters, 0) AS meters, COALESCE(p.points, 0) AS points
      FROM ${users} u
      LEFT JOIN capture_summary c ON c.player_id = u.id
      LEFT JOIN mileage_summary m ON m.player_id = u.id
      LEFT JOIN points_summary p ON p.player_id = u.id
      WHERE u.openid IS NOT NULL AND (u.id = ? OR c.player_id IS NOT NULL)
    `, eventId, ...ids, eventId, ...ids, ...ids, player.id));
    return rankPlayers(rows.map((row) => ({ ...row, mine: row.id === player.id })))
      .map(({ id, achievedAt, ...visible }) => visible);
  }

  return {
    getPlayer: (id) => store.read((query) => playerOf(query, id)),
    setAutoStage: (value) => { autoStage = !!value; },
    join, updatePlayer, issueCode, capture, setTracking, move, snapshot, leaderboard, dataGap,
    exitParticipation: (player, sessionId) => setParticipation(player, 'exited', sessionId),
    settleDue: (now = clock()) => settleDueSessions(store, now),
    close: store.close,
  };
}

function makeManualCode() {
  return randomBytes(8).toString('hex').toUpperCase();
}
