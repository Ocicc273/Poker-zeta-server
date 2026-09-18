import test from 'node:test';
import assert from 'node:assert/strict';
import { TournamentRoom } from '../game/tournament-room.js';
import { TournamentService } from '../game/tournament-service.js';
import { TOURNAMENT, tournamentBlinds } from '../game/tournament-config.js';
import { SeatGate } from '../game/seat-gate.js';
import { ActionType, isHandComplete } from '../engine/index.js';
import type { TournamentRecord, TournamentStore } from '../wallet/tournament.js';
import { PrivateRoom } from '../game/private-room.js';
import { Room } from '../game/room.js';
import { TwisterRoom } from '../game/twister-room.js';
import type { TableView } from '../game/protocol.js';

const players = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}` }));
test('torneo: carte private, azioni autorizzate/versionate, timeout e bui crescenti', () => {
  const r = new TournamentRoom('t', players.slice(0, 2), 0);
  r.tick(0);
  assert.equal(r.view('spectator', 0), null);
  const view = r.view('p0', 0)!;
  assert.equal(view.format, 'tournament');
  assert.equal(view.players.find(p => p.playerId === 'p0')!.holeCards!.length, 2);
  assert.equal(view.players.find(p => p.playerId === 'p1')!.holeCards, null);
  const actor = r.hand!.toActPlayerId!;
  const payload = { id: r.id, handId: r.hand!.handId, version: r.version, type: ActionType.Fold };
  assert.throws(() => r.act(actor === 'p0' ? 'p1' : 'p0', payload, 0));
  r.act(actor, payload, 0);
  assert.throws(() => r.act(actor, payload, 0));
  assert.equal(r.players.reduce((sum,p) => sum+p.stack, 0), 3000);
  r.tick(TOURNAMENT.levelMs);
  assert.equal(r.hand!.config.blinds.bigBlind, 40);
  const version = r.version;
  r.tick(r.deadline!);
  assert.ok(r.version > version);
  assert.equal(tournamentBlinds(-1).level, 1);
  assert.equal(tournamentBlinds(1e12).bigBlind, 12800);
});

test('torneo: sei giocatori, all-in forzati dai bui, eliminazioni e vincitore senza perdere fiche', () => {
  const r = new TournamentRoom('t', players, 0);
  let now = TOURNAMENT.levelMs * 20;
  for (let i=0; i<300 && !r.winner; i++) {
    r.tick(now);
    if (r.hand && !isHandComplete(r.hand) && r.hand.toActPlayerId) {
      r.act(r.hand.toActPlayerId, { id:r.id, handId:r.hand.handId, version:r.version, type:ActionType.AllIn }, now);
    }
    now += TOURNAMENT.betweenHandsMs;
  }
  assert.ok(r.winner);
  assert.deepEqual(r.players.map(p => p.place).sort(), [1,2,3,4,5,6]);
  assert.equal(r.players.reduce((s,p) => s+p.stack,0), 6*TOURNAMENT.startingStack);
  assert.equal(r.players.find(p=>p.id===r.winner)!.stack, 9000);
});

function fixture() {
  let clock=0;
  let record: TournamentRecord;
  let loseJoin=false, loseStart=false, failFinish=false;
  const debits=new Set<string>(), credits=new Map<string,number>();
  const calls:string[]=[];
  const store: TournamentStore = async (action,args={}) => {
    calls.push(action);
    if(action==='create') record={id:String(args.id),status:'waiting',buy_in:2000,entries:[]};
    if(action==='join' && !record.entries.some(e=>e.user_id===args.userId)) {
      debits.add(String(args.userId));
      record.entries.push({user_id:String(args.userId),name:String(args.name),active:true,place:null,prize:0,refunded:false});
      if(loseJoin) {loseJoin=false;throw Error('response lost');}
    }
    if(action==='start') {record.status='running';if(loseStart){loseStart=false;throw Error('response lost');}}
    if(action==='finish') {
      if(failFinish) throw Error('offline');
      if(record.status!=='finished') {
        const ranking=args.ranking as string[];
        for(const e of record.entries) { e.active=false;e.place=ranking.indexOf(e.user_id)+1;e.prize=e.place===1?4000:0; }
        record.status='finished';credits.set(ranking[0]!,4000);
      }
    }
    if(action==='cancel' && record.status!=='finished' && record.status!=='cancelled') {
      for(const e of record.entries){ e.active=false;e.refunded=true;credits.set(e.user_id,2000); }
      record.status='cancelled';
    }
    return structuredClone(record);
  };
  const service=new TournamentService(store,()=>clock);
  return { service,debits,credits,calls,setTime:(n:number)=>{clock=n;},loseJoin:()=>{loseJoin=true;},loseStart:()=>{loseStart=true;},failFinish:(b:boolean)=>{failFinish=b;} };
}

test('torneo: watch/reconnect non addebitano, join duplicato e risposta persa recuperati', async () => {
  const f=fixture();
  await f.service.watch('s1','p0',()=>{});
  assert.equal(f.debits.size,0);
  const id=f.service.snapshot('p0')!.id;
  f.loseJoin();
  await assert.rejects(f.service.join(id,'p0','P0'));
  await Promise.all([f.service.join(id,'p0','P0'),f.service.join(id,'p0','P0')]);
  assert.equal(f.debits.size,1);
  f.service.disconnect('s1');
  assert.equal(f.service.hasPlayer('p0'),true);
  await f.service.watch('s2','p0',()=>{});
  assert.equal(f.service.snapshot('p0')!.registered,true);
  assert.equal(f.debits.size,1);
  await f.service.shutdown();
  await f.service.shutdown();
  assert.equal(f.credits.get('p0'),2000);
  await assert.rejects(f.service.join(id,'p1','P1'));
  assert.equal(f.calls.some(c=>['open','close','cashout'].includes(c)),false);
});

test('torneo: start con risposta persa recuperato e timer continuano da disconnessi', async () => {
  const f=fixture();
  await f.service.watch('s','p0',()=>{});
  const id=f.service.snapshot('p0')!.id;
  await f.service.join(id,'p0','P0');await f.service.join(id,'p1','P1');
  f.loseStart();f.setTime(30000);await f.service.tick();
  f.service.disconnect('s');
  f.setTime(45000);await f.service.tick();
  assert.equal(f.service.snapshot('p0')!.status,'running');
  assert.ok(f.service.snapshot('p0')!.table);
  const version=f.service.snapshot('p0')!.actionVersion;
  f.setTime(71000);await f.service.tick();
  assert.ok(f.service.snapshot('p0')!.actionVersion>version);
});

test('torneo: premio ritentato senza annullare il vincitore, doppia liquidazione innocua', async () => {
  const f=fixture();
  await f.service.watch('s','p0',()=>{});
  const id=f.service.snapshot('p0')!.id;
  await f.service.join(id,'p0','P0');await f.service.join(id,'p1','P1');
  f.failFinish(true);
  let now=30000;f.setTime(now);await f.service.tick();
  for(let i=0;i<1000 && f.service.snapshot('p0')!.status!=='settling';i++) {
    const s=f.service.snapshot('p0')!;
    if(s.table && !s.table.isHandComplete && s.table.toActPlayerId) {
      try {await f.service.action(s.table.toActPlayerId,{id,handId:s.table.handId!,version:s.actionVersion,type:ActionType.AllIn});} catch { /* pagamento temporaneamente offline */ }
    }
    now+=4000;f.setTime(now);await f.service.tick();
  }
  assert.equal(f.service.snapshot('p0')!.status,'settling');
  assert.equal(f.credits.size,0);
  f.failFinish(false);f.setTime(now+16000);await f.service.tick();
  assert.equal(f.service.snapshot('p0')!.status,'finished');
  await f.service.shutdown();await f.service.shutdown();
  assert.equal(f.credits.size,1);
  assert.equal([...f.credits.values()][0],4000);
});

test('torneo: gate esclude ingressi concorrenti cash/torneo e libera dopo errore', async () => {
  const gate=new SeatGate();let release!:()=>void;
  const first=gate.run('p',()=>new Promise<void>(r=>{release=r;}));
  await assert.rejects(gate.run('p',async()=>{}));
  release();await first;
  await assert.rejects(gate.run('p',async()=>{throw Error('failed');}));
  assert.equal(await gate.run('p',()=>42),42);
});

test('regressione torneo: privato mantiene posti, carte private e azioni indipendenti', async () => {
  const views=new Map<string,TableView>();const errors:string[]=[];
  const room=new PrivateRoom({code:'TEST',hostId:'p0',buyIn:2000,sendState:(id,v)=>{views.set(id,v);},sendError:(_,m)=>{errors.push(m);}});
  try {
    assert.equal(room.siediti('p0','One',1500),true);
    assert.equal(room.siediti('p1','Two',1500),true);
    assert.equal(room.giocatoriSeduti(),2);
    await new Promise<void>(resolve=>setTimeout(resolve,1600));
    const v=views.get('p0')!;
    assert.ok(v.handId);
    assert.equal(v.players.every(p=>!p.isBot),true);
    assert.equal(v.players.find(p=>p.playerId==='p1')!.holeCards,null);
    const actor=v.toActPlayerId!;
    const own=views.get(actor)!;
    room.azione(actor,own.availableActions.some(a=>a.type===ActionType.Check)?ActionType.Check:ActionType.Fold);
    assert.equal(errors.length,0);
  } finally {room.close();}
});

for(const variant of ['holdem','omaha'] as const) test(`regressione torneo: stanza cash ${variant} invariata`,()=>{
  const views:TableView[]=[];
  const room=new Room({roomId:'cash',humanPlayerId:'p0',humanName:'One',buyIn:2000,variant,
    botStacks:[2000,2000,2000,2000,2000],sendState:v=>{views.push(v);},sendError:()=>{}});
  try {
    room.start();
    assert.equal(views.length>0,true);
    assert.equal(views.at(-1)!.players.find(p=>p.playerId==='p0')!.holeCards!.length,variant==='omaha'?4:2);
    assert.notEqual(views.at(-1)!.format,'tournament');
  } finally {room.close();}
});

test('regressione torneo: Twister mantiene formato e stack propri',()=>{
  const views:TableView[]=[];
  const room=new TwisterRoom({roomId:'twister',humanPlayerId:'p0',humanName:'One',buyIn:2000,multiplier:2,
    sendState:v=>{views.push(v);},sendError:()=>{},onFinish:()=>{}});
  try {
    room.start();
    assert.equal(views.at(-1)!.canStartNextHand,false);
    assert.equal(views.at(-1)!.players.length,3);
    assert.equal(views.at(-1)!.players.find(p=>p.playerId==='p0')!.holeCards!.length,2);
  } finally {room.close();}
});
