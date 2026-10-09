import test from 'node:test';
import assert from 'node:assert/strict';

import { ActionType } from '../engine/index.js';
import { PrivateRoom } from '../game/private-room.js';
import type { TableView } from '../game/protocol.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('privato: lobby manuale, reconnect e avvio host senza duplicare stack', async () => {
  const views = new Map<string, TableView>();
  const errors: string[] = [];

  const room = new PrivateRoom({
    code: 'AB12CD',
    hostId: 'host',
    buyIn: 2000,
    maxSeats: 6,
    startingStack: 1000,
    manualStart: true,
    sendState: (id, view) => {
      views.set(id, view);
    },
    sendError: (_, message) => {
      errors.push(message);
    },
  });

  assert.equal(room.siediti('host', 'Host', 1000), true);
  assert.equal(room.siediti('guest', 'Guest', 1000), true);

  await wait(1600);

  assert.equal(views.get('host')?.handId, null);
  assert.equal(views.get('host')?.privateTable?.phase, 'lobby');
  assert.deepEqual(
    [...(views.get('host')?.privateTable?.connectedPlayerIds ?? [])].sort(),
    ['guest', 'host'],
  );

  room.disconnetti('guest');
  assert.deepEqual(views.get('host')?.privateTable?.connectedPlayerIds, ['host']);

  assert.equal(room.siediti('guest', 'Guest', 5000), true);
  const rejoined = views.get('guest');
  assert.equal(rejoined?.players.find((p) => p.playerId === 'guest')?.stack, 1000);

  assert.equal(room.avviaDaHost('guest'), false);
  assert.equal(room.avviaDaHost('host'), true);

  await wait(1600);

  assert.notEqual(views.get('host')?.handId, null);
  assert.equal(views.get('host')?.privateTable?.phase, 'playing');
  assert.equal(errors.length, 0);

  const active = views.get('host')?.toActPlayerId;
  if (active) room.azione(active, ActionType.Fold);

  room.close();
});
