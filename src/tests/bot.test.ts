/**
 * Poker Zeta — Test della logica dei bot
 *
 * Il primo test di questo file esiste per una ragione precisa: il
 * bot foldava con due fiche contro un piatto da centocinquanta,
 * perché il costo veniva confrontato con il valore nominale della
 * puntata invece che con quanto poteva davvero pagare. Il bug è
 * stato trovato giocando. Questo test lo avrebbe preso subito.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideBotAction,
  ActionType,
  Street,
  type AvailableAction,
} from '../engine/index.js';

import { card } from './helpers.js';

/** Due carte scoordinate e basse: la mano più debole possibile. */
const MANO_PESSIMA = [card(7, 'c'), card(2, 'd')];

/** Coppia d'assi: la mano più forte possibile preflop. */
const MANO_OTTIMA = [card(14, 's'), card(14, 'h')];

test('bot: con stack corto non folda contro un prezzo irrisorio', () => {
  // Due fiche contro un piatto da 150: chiamare costa 2, non 100.
  // Foldare qui è indifendibile con qualunque mano.
  const available: AvailableAction[] = [
    { type: ActionType.Fold },
    { type: ActionType.AllIn, minAmount: 2, maxAmount: 2 },
  ];

  const decision = decideBotAction({
    playerId: 'bot-1',
    profile: 'tight',
    holeCards: MANO_PESSIMA,
    communityCards: [],
    street: Street.Preflop,
    available,
    toCall: 100,
    potSize: 150,
    stack: 2,
  });

  assert.notEqual(
    decision.type,
    ActionType.Fold,
    'il bot ha foldato pagando il 1,3% del piatto',
  );
});

test('bot: non folda mai quando restare costa zero', () => {
  const available: AvailableAction[] = [
    { type: ActionType.Fold },
    { type: ActionType.Check },
    { type: ActionType.Bet, minAmount: 10, maxAmount: 500 },
  ];

  const decision = decideBotAction({
    playerId: 'bot-1',
    profile: 'tight',
    holeCards: MANO_PESSIMA,
    communityCards: [],
    street: Street.Preflop,
    available,
    toCall: 0,
    potSize: 30,
    stack: 500,
  });

  assert.equal(decision.type, ActionType.Check);
});

test('bot: folda quando il prezzo è alto e la mano è debole', () => {
  // Metà del piatto finale con una mano che non regge: fold.
  // Serve a verificare che il bot non sia diventato una calling
  // station correggendo il bug precedente.
  const available: AvailableAction[] = [
    { type: ActionType.Fold },
    { type: ActionType.Call },
    { type: ActionType.Raise, minAmount: 200, maxAmount: 1_000 },
  ];

  const decision = decideBotAction({
    playerId: 'bot-1',
    profile: 'tight',
    holeCards: MANO_PESSIMA,
    communityCards: [],
    street: Street.Preflop,
    available,
    toCall: 100,
    potSize: 100,
    stack: 1_000,
  });

  assert.equal(decision.type, ActionType.Fold);
});

test('bot: con una mano fortissima non passa', () => {
  const available: AvailableAction[] = [
    { type: ActionType.Fold },
    { type: ActionType.Call },
    { type: ActionType.Raise, minAmount: 200, maxAmount: 1_000 },
  ];

  const decision = decideBotAction({
    playerId: 'bot-1',
    profile: 'tight',
    holeCards: MANO_OTTIMA,
    communityCards: [],
    street: Street.Preflop,
    available,
    toCall: 100,
    potSize: 100,
    stack: 1_000,
  });

  assert.notEqual(decision.type, ActionType.Fold);
});

test('bot: sceglie sempre e solo azioni dichiarate legali', () => {
  // Invariante di sicurezza: il motore rifiuterebbe un'azione
  // illegale sollevando, e nel turno di un bot quella eccezione
  // fermerebbe la mano.
  const scenari = [
    { toCall: 0, potSize: 50, stack: 1_000 },
    { toCall: 25, potSize: 75, stack: 1_000 },
    { toCall: 400, potSize: 200, stack: 400 },
    { toCall: 1_000, potSize: 3_000, stack: 5 },
  ];

  const available: AvailableAction[] = [
    { type: ActionType.Fold },
    { type: ActionType.Check },
    { type: ActionType.Call },
    { type: ActionType.Raise, minAmount: 50, maxAmount: 1_000 },
    { type: ActionType.AllIn },
  ];

  const consentite = new Set(available.map((a) => a.type));

  for (const profile of ['tight', 'balanced', 'loose'] as const) {
    for (const scenario of scenari) {
      const decision = decideBotAction({
        playerId: 'bot-1',
        profile,
        holeCards: MANO_PESSIMA,
        communityCards: [],
        street: Street.Preflop,
        available,
        ...scenario,
      });

      assert.ok(
        consentite.has(decision.type),
        `${profile} ha scelto ${decision.type}, non fra le azioni legali`,
      );
    }
  }
});

test('bot: la puntata resta dentro i limiti dichiarati dal motore', () => {
  const available: AvailableAction[] = [
    { type: ActionType.Fold },
    { type: ActionType.Check },
    { type: ActionType.Bet, minAmount: 40, maxAmount: 300 },
  ];

  const decision = decideBotAction({
    playerId: 'bot-1',
    profile: 'loose',
    holeCards: MANO_OTTIMA,
    communityCards: [],
    street: Street.Preflop,
    available,
    toCall: 0,
    potSize: 10_000,
    stack: 1_000,
  });

  if (decision.amount !== undefined) {
    assert.ok(decision.amount >= 40, 'importo sotto il minimo legale');
    assert.ok(decision.amount <= 300, 'importo sopra il massimo legale');
  }
});
