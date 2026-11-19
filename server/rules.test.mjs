import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGame } from './game.mjs';
import { cappedAward, rankPlayers } from './rules.mjs';

const makePlayer = (game) => {
  const player = game.join();
  game.snapshot(player);
  return player;
};

const captureSample = (game, player, mouseId, id = randomUUID()) =>
  game.capture(player, id, game.issueCode(player, mouseId, 'sample').code);

test('leaderboard compares full eligible mileage and then the achievement time', () => {
  const rows = [
    { id: 'first-distance', captures: 4, meters: 1600, achievedAt: 100 },
    { id: 'late', captures: 4, meters: 3050, achievedAt: 300 },
    { id: 'early', captures: 4, meters: 3050, achievedAt: 200 },
    { id: 'more-captures', captures: 5, meters: 1500, achievedAt: 400 },
  ];
  assert.deepEqual(rankPlayers(rows).map((row) => row.id), ['more-captures', 'early', 'late', 'first-distance']);
});

test('both point caps apply to every award', () => {
  assert.equal(cappedAward(10, 95, 155), 5);
  assert.equal(cappedAward(10, 50, 197), 3);
  assert.equal(cappedAward(10, 100, 200), 0);
});

test('retry is idempotent, same-stage repeats fail, and the next stage permits the mouse again', (t) => {
  const game = createGame();
  t.after(game.close);
  let player = makePlayer(game);
  const id = randomUUID();
  const { code } = game.issueCode(player, 3, 'sample');
  const first = game.capture(player, id, code);
  assert.deepEqual(game.capture(player, id, code), first);
  assert.equal(game.snapshot(player).stats.sessionPoints, 22);
  assert.equal(game.snapshot(player).stats.captures, 1);
  assert.throws(() => captureSample(game, player, 3), { code: 'SESSION_DUP' });
  assert.throws(() => captureSample(game, player, 4), { code: 'STAMINA' });
  game.setTracking(player, true);
  const walkingId = randomUUID();
  assert.deepEqual(game.move(player, walkingId), game.move(player, walkingId));
  assert.equal(game.snapshot(player).stats.meters, 1380);
  assert.equal(captureSample(game, player, 4).award, 10);
  game.updatePlayer(player, { stage: 'morning' });
  player = game.getPlayer(player.id);
  assert.equal(captureSample(game, player, 3).award, 10);
});

test('a partial award still records the full capture for ranking', (t) => {
  let time = 1_000_000;
  const game = createGame(':memory:', () => time);
  t.after(game.close);
  const player = makePlayer(game);
  game.setTracking(player, true);
  for (let walk = 0; walk < 6; walk++) game.move(player, randomUUID());
  for (let mouse = 1; mouse <= 7; mouse++) {
    assert.equal(captureSample(game, player, mouse).award, 10);
    time += 1000;
    game.move(player, randomUUID());
  }
  assert.equal(game.snapshot(player).stats.sessionPoints, 95);
  assert.equal(captureSample(game, player, 8).award, 5);
  const current = game.snapshot(player);
  assert.equal(current.stats.sessionPoints, 100);
  assert.equal(current.stats.captures, 8);
  assert.equal(game.leaderboard(player, 'session').find((row) => row.mine).captures, 8);
});

test('the sixth capture is held until fixed cooldown expiry', (t) => {
  let time = 1_000_000;
  const game = createGame(':memory:', () => time);
  t.after(game.close);
  const players = Array.from({ length: 6 }, () => makePlayer(game));
  for (const player of players.slice(0, 5)) captureSample(game, player, 3);
  assert.throws(() => captureSample(game, players[5], 4), { code: 'LOCK' });
  time += 30_000;
  assert.equal(captureSample(game, players[5], 4).award, 10);
});

test('mouse codes are one-time, scoped to the stage, and expire', (t) => {
  let time = 1_000_000;
  const game = createGame(':memory:', () => time);
  t.after(game.close);
  const mouse = makePlayer(game);
  const first = makePlayer(game);
  const other = makePlayer(game);
  game.updatePlayer(mouse, { role: 'mouse' });
  const issuer = game.getPlayer(mouse.id);
  const expired = game.issueCode(issuer, null, 'mouse').code;
  time += 30_000;
  assert.throws(() => game.capture(first, randomUUID(), expired), { code: 'TOKEN' });
  const valid = game.issueCode(issuer, null, 'mouse').code;
  game.updatePlayer(other, { stage: 'morning' });
  assert.throws(() => game.capture(game.getPlayer(other.id), randomUUID(), valid), { code: 'SESSION' });
  assert.equal(game.capture(first, randomUUID(), valid).mouseId, 3);
  game.updatePlayer(other, { stage: 'evening' });
  assert.throws(() => game.capture(game.getPlayer(other.id), randomUUID(), valid), { code: 'TOKEN' });
});
