import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGame } from './game.mjs';
import { cappedAward, rankPlayers } from './rules.mjs';

const makePlayer = async (game) => {
  const player = await game.join();
  await game.snapshot(player);
  return player;
};

const captureSample = async (game, player, mouseId, id = randomUUID()) =>
  game.capture(player, id, (await game.issueCode(player, mouseId, 'sample')).code);

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
  assert.equal(cappedAward(10, 115, 155), 5);
  assert.equal(cappedAward(10, 50, 247), 3);
  assert.equal(cappedAward(10, 120, 250), 0);
});

test('retry is idempotent, same-stage repeats fail, and the next stage permits the mouse again', async (t) => {
  const game = createGame();
  t.after(game.close);
  let player = await makePlayer(game);
  const id = randomUUID();
  const { code } = await game.issueCode(player, 3, 'sample');
  const first = await game.capture(player, id, code);
  assert.deepEqual(await game.capture(player, id, code), first);
  assert.equal((await game.snapshot(player)).stats.sessionPoints, 22);
  assert.equal((await game.snapshot(player)).stats.captures, 1);
  await assert.rejects(captureSample(game, player, 3), { code: 'SESSION_DUP' });
  await assert.rejects(captureSample(game, player, 4), { code: 'STAMINA' });
  await game.setTracking(player, true);
  const walkingId = randomUUID();
  assert.deepEqual(await game.move(player, walkingId), await game.move(player, walkingId));
  assert.equal((await game.snapshot(player)).stats.meters, 1380);
  assert.equal((await captureSample(game, player, 4)).award, 10);
  await game.updatePlayer(player, { stage: 'morning' });
  player = await game.getPlayer(player.id);
  assert.equal((await captureSample(game, player, 3)).award, 10);
});

test('a partial award still records the full capture for ranking', async (t) => {
  let time = 1_000_000;
  const game = createGame(':memory:', () => time);
  t.after(game.close);
  const player = await makePlayer(game);
  await game.setTracking(player, true);
  for (let walk = 0; walk < 6; walk++) await game.move(player, randomUUID());
  for (let mouse = 1; mouse <= 7; mouse++) {
    assert.equal((await captureSample(game, player, mouse)).award, 10);
    time += 1000;
    await game.move(player, randomUUID());
  }
  assert.equal((await game.snapshot(player)).stats.sessionPoints, 95);
  assert.equal((await captureSample(game, player, 8)).award, 5);
  const current = await game.snapshot(player);
  assert.equal(current.stats.sessionPoints, 100);
  assert.equal(current.stats.captures, 8);
  assert.equal((await game.leaderboard(player, 'session')).find((row) => row.mine).captures, 8);
});

test('the sixth capture is held until fixed cooldown expiry', async (t) => {
  let time = 1_000_000;
  const game = createGame(':memory:', () => time);
  t.after(game.close);
  const players = await Promise.all(Array.from({ length: 6 }, () => makePlayer(game)));
  for (const player of players.slice(0, 5)) await captureSample(game, player, 3);
  await assert.rejects(captureSample(game, players[5], 4), { code: 'LOCK' });
  time += 30_000;
  assert.equal((await captureSample(game, players[5], 4)).award, 10);
});

test('expired and cross-stage mouse codes fail before location checks', async (t) => {
  let time = Date.parse('2026-11-23T17:45:00+08:00');
  const game = createGame(':memory:', () => time);
  t.after(game.close);
  const mouse = await makePlayer(game);
  const first = await makePlayer(game);
  const other = await makePlayer(game);
  await game.updatePlayer(mouse, { role: 'mouse' });
  const issuer = await game.getPlayer(mouse.id);
  const expired = (await game.issueCode(issuer, null, 'mouse')).code;
  time += 30_000;
  await assert.rejects(game.capture(first, randomUUID(), expired), { code: 'TOKEN' });
  const valid = (await game.issueCode(issuer, null, 'mouse')).code;
  await game.updatePlayer(other, { stage: 'morning' });
  await assert.rejects(game.capture(await game.getPlayer(other.id), randomUUID(), valid), { code: 'SESSION' });
  await assert.rejects(game.capture(first, randomUUID(), valid), { code: 'ACCURACY' });
});
