import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Esegue il coordinatore reale in isolamento: niente socket, wallet o process.exit reali.
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const cash = deferred();
  const twister = deferred();
  const privateTables = deferred();
  const calls = { cash: 0, twister: 0, privateTables: 0, io: 0, http: 0, timers: 0, exits: 0 };
  const listeners = new Map<string, () => void>();
  const context = createContext({
    console: { log() {}, error() {} },
    activeRoomCount: () => 1,
    activeTwisterCount: () => 1,
    privateTableCount: () => 1,
    closeAllRooms: () => { calls.cash++; return cash.promise; },
    closeAllTwisterRooms: () => { calls.twister++; return twister.promise; },
    closeAllPrivateTables: () => { calls.privateTables++; return privateTables.promise; },
    io: { close: () => { calls.io++; } },
    httpServer: { close: (done: () => void) => { calls.http++; done(); } },
    process: {
      on: (signal: string, listener: () => void) => { listeners.set(signal, listener); },
      exit: () => { calls.exits++; },
    },
    setTimeout: () => { calls.timers++; return { unref() {} }; },
  });
  const start = source.indexOf('let shuttingDown = false;');
  assert.notEqual(start, -1);
  const coordinator = source.slice(start).replace(
    'async function shutdown(signal: string): Promise<void>',
    'async function shutdown(signal)',
  );
  runInContext(coordinator, context);
  return { cash, twister, privateTables, calls, listeners, context };
}

test('shutdown: un solo gestore per SIGTERM e SIGINT', () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const registrations = source.match(new RegExp(`process\\.on\\('${signal}'`, 'g'));
    assert.equal(registrations?.length, 1);
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`shutdown: ${signal} attende tutte le sessioni anche con segnali ripetuti`, async () => {
    const h = harness();
    h.listeners.get(signal)!();
    h.listeners.get('SIGTERM')!();
    h.listeners.get('SIGINT')!();
    assert.equal(h.calls.cash, 1);
    assert.equal(h.calls.twister, 1);
    assert.equal(h.calls.privateTables, 1);

    h.cash.resolve();
    h.twister.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.calls.io, 0);
    assert.equal(h.calls.http, 0);
    assert.equal(h.calls.timers, 0);
    assert.equal(h.calls.exits, 0);

    h.privateTables.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.calls.io, 1);
    assert.equal(h.calls.http, 1);
    assert.equal(h.calls.exits, 1);
    assert.equal(h.calls.timers, 1);
  });
}
