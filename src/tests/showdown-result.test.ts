import test from 'node:test';
import assert from 'node:assert/strict';
import { cardsFromString } from '../engine/cards.js';
import { applyAction, startHand, type HandState } from '../engine/hand-state.js';
import { ActionType, PlayerStatus, Street } from '../engine/table-types.js';
import { evaluateOmahaHand } from '../engine/omaha.js';
import { buildPots, distributePots, verifyPayoutIntegrity } from '../engine/pot.js';
import { showdownView } from '../game/showdown-view.js';
import { TournamentRoom } from '../game/tournament-room.js';

function river(variant: 'holdem' | 'omaha', amounts: number[], folded: number[] = []): HandState {
  const ids = ['A','B','C','D'];
  const starting = startHand('showdown-test', {
    variant, maxSeats: amounts.length, structure: variant === 'omaha' ? 'pot-limit' : 'no-limit',
    blinds: { smallBlind: 1, bigBlind: 2, ante: 0 },
  }, amounts.map((_, seat) => ({ playerId: ids[seat]!, seat, stack: 1000 })), 0);
  const holes = variant === 'omaha'
    ? ['As Ad 2c 3c','Ks Kd 4c 5c','Qs Qd 6c 7c','Js Jd 8c 9c']
    : ['2c 3d','4c 5d','6c 7d','8c 9d'];
  return { ...starting, street: Street.River, dealerSeat: 0,
    communityCards: cardsFromString('Ah Kh Qh Jh Th'), toActPlayerId: 'A', currentBet: 0,
    players: starting.players.map((p,i) => ({ ...p, holeCards: cardsFromString(holes[i]!),
      stack: i === 0 ? 1 : 0, committedTotal: amounts[i]!, committedThisStreet: 0,
      status: folded.includes(i) ? PlayerStatus.Folded : i === 0 ? PlayerStatus.Active : PlayerStatus.AllIn,
      hasActedThisStreet: i !== 0 })) };
}

function finish(state: HandState): HandState {
  return applyAction(state, { type: ActionType.Check, playerId: 'A' });
}

test('showdown Omaha: main pot, side pot e restituzione senza falsa vittoria', () => {
  const before = river('omaha', [50,100,200]);
  const after = finish(before);
  assert.equal(after.street, Street.Complete);
  assert.deepEqual(after.payouts.map(p => [p.playerId,p.amount]), [['A',150],['B',100],['C',100]]);
  assert.deepEqual(showdownView(after).winnerIds, ['A','B']);
  assert.ok(after.pots[2]?.uncalled);
  assert.ok(verifyPayoutIntegrity(after.pots,after.payouts).valid);
  assert.equal(after.players.reduce((s,p)=>s+p.stack,0),351);
  assert.equal(before.players[0]!.stack,1, 'lo stato precedente non viene mutato');
  for (const h of showdownView(after).showdown) {
    assert.equal(h.usedHoleCards.length,2);
    assert.equal(h.usedCommunityCards.length,3);
    assert.equal(new Set(h.cards.map(c=>`${c.rank}${c.suit}`)).size,5);
  }
});

test('showdown Hold’em: board giocabile e fiche dispari dopo il bottone, anche con fold', () => {
  const after = finish(river('holdem',[50,50,1],[2]));
  assert.equal(after.payouts.find(p=>p.playerId==='A')?.amount,50);
  assert.equal(after.payouts.find(p=>p.playerId==='B')?.amount,51);
  const result=showdownView(after);
  assert.deepEqual(result.winnerIds,['A','B']);
  assert.equal(result.showdown.length,2);
  assert.ok(result.showdown.every(h=>h.usedHoleCards.length===0 && h.usedCommunityCards.length===5));
  assert.equal(after.players.reduce((s,p)=>s+p.stack,0),102);
});

test('showdown: all-in e posti foldati non cambiano l’ordine della fiche dispari', () => {
  const after=finish(river('holdem',[10,10,10,1],[3]));
  assert.equal(after.payouts.find(p=>p.playerId==='B')?.amount,11);
  assert.equal(after.payouts.find(p=>p.playerId==='A')?.amount,10);
  assert.equal(after.payouts.find(p=>p.playerId==='C')?.amount,10);
  assert.equal(after.players.reduce((s,p)=>s+p.stack,0),32);
});

test('Omaha: rifiuta board troppo lungo e duplicazioni personali/comuni', () => {
  assert.throws(()=>evaluateOmahaHand(cardsFromString('As Ks Qs Js'),cardsFromString('2c 3d 4h 5s 6c 7d')));
  assert.throws(()=>evaluateOmahaHand(cardsFromString('As As Qs Js'),cardsFromString('2c 3d 4h 5s 6c')));
  assert.throws(()=>evaluateOmahaHand(cardsFromString('As Ks Qs Js'),cardsFromString('As 3d 4h 5s 6c')));
  assert.throws(()=>evaluateOmahaHand(cardsFromString('As Ks Qs Js'),cardsFromString('2c 2c 4h 5s 6c')));
});

test('Omaha: mani 2+3 equivalenti dividono il piatto senza usare il board da solo',()=>{
  const before=river('omaha',[50,50]);
  const state={...before,communityCards:cardsFromString('Ac Kd Qh Js 9c'),
    players:before.players.map((p,i)=>({...p,holeCards:cardsFromString(i===0?'Th 8d 2c 3c':'Ts 8h 4c 5c')}))};
  const after=finish(state);
  assert.deepEqual(after.payouts.map(p=>p.amount),[50,50]);
  assert.deepEqual(showdownView(after).winnerIds,['A','B']);
  assert.ok(showdownView(after).showdown.every(h=>h.usedHoleCards.length===2 && h.usedCommunityCards.length===3));
});

test('showdown: un pot senza mani eleggibili viene rifiutato senza perdere chips', () => {
  const pots=buildPots([{playerId:'A',amount:10,eligible:true}]);
  assert.throws(()=>distributePots(pots,[],['A']),/Nessuna mano valida/);
});

test('torneo multiplayer: risultato identico per tutti, nessuna carta foldata e reconnect innocuo', () => {
  const room=new TournamentRoom('showdown-room', ['A','B','C'].map(id=>({id,name:id})),0);
  const before=river('holdem',[50,50,1],[2]);
  room.hand=before;
  const playing=room.view('A',0)!;
  assert.deepEqual(playing.showdown,[]);
  assert.equal(playing.players.find(p=>p.playerId==='B')?.holeCards,null);
  room.hand=finish(before);
  const a=room.view('A',0)!,b=room.view('B',0)!,c=room.view('C',0)!;
  assert.deepEqual(a.showdown,b.showdown);
  assert.deepEqual(a.winnerIds,c.winnerIds);
  assert.deepEqual(a.payouts,b.payouts);
  assert.equal(a.players.find(p=>p.playerId==='C')?.holeCards,null);
  assert.deepEqual(room.view('B',0),b);
  assert.deepEqual(a.players.map(p=>p.stack),b.players.map(p=>p.stack));
});
