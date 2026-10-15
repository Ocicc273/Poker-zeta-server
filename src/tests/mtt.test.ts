import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Deck, SeededRandomSource } from '../engine/cards.js';
import { MttEngine, newTournament } from '../game/mtt-engine.js';
import { MttService } from '../game/mtt-service.js';
import { ActionType } from '../engine/index.js';
import type { MttCommand } from '../game/mtt-protocol.js';
import type { MttRecord, MttStore } from '../wallet/mtt.js';

const config = { name: 'Torneo di prova', capacity: 18, minimum: 2, startingStack: 1500,
  scheduledAt: 30000, levelMs: 60000, bigBlinds: [20,40,80,160,320,640,1280,2560,5120,10240] };
function fixture(n=12) {
  const e = new MttEngine(newTournament(randomUUID(), config, 0));
  for(let i=0;i<n;i++) e.join(`p${i}`, `Player ${i}`, 0);
  e.tick(30000,new SeededRandomSource(77)); return e;
}
function action(e: MttEngine, t = e.state.tables[0]!, type = ActionType.AllIn): MttCommand {
  return { kind:'action', requestId:randomUUID(), tournamentId:e.state.id, tableId:t.id,
    handId:t.hand!.handId, version:t.version, type };
}

test('MTT: mazzo ripristinato senza shuffle, copie indipendenti e corruzione rifiutata',()=>{
  const deck=new Deck(new SeededRandomSource(17));deck.drawMany(9);const saved=deck.snapshot();
  const restored=Deck.restore(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(deck.drawMany(43),restored.drawMany(43));
  const bad=structuredClone(saved);bad.cards[0]=bad.cards[1]!;assert.throws(()=>Deck.restore(bad));
  assert.throws(()=>Deck.restore({...saved,position:53}));
  assert.equal(saved.position,9);
});

test('MTT: iscrizione e calendario, 7 iscritti distribuiti 4+3, nessuna mano singola',()=>{
  const e=fixture(7);assert.equal(e.state.status,'running');
  assert.deepEqual(e.state.tables.map(t=>t.seats.length),[4,3]);
  assert.equal(new Set(e.state.tables.flatMap(t=>t.seats)).size,7);
  e.assertIntegrity(); assert.throws(()=>e.join('late','Late',31000));
  const empty=new MttEngine(newTournament(randomUUID(),config,0));empty.tick(30000);
  assert.equal(empty.state.status,'cancelled');
});

test('MTT: privacy, azioni fuori turno, versione e scadenza',()=>{
  const e=fixture(12), t=e.state.tables[0]!, actor=t.hand!.toActPlayerId!;
  const c=action(e,t,ActionType.Fold);
  assert.throws(()=>e.action('estraneo',c,30000));
  assert.throws(()=>e.action(actor,{...c,version:999},30000));
  assert.throws(()=>e.action(actor,c,55000));
  const view=e.view(actor,1,30000,new Set());
  assert.equal(view.table!.players.filter(p=>p.holeCards?.length).length,1);
  assert.equal(JSON.stringify(view).includes('"deck"'),false);
  assert.equal(e.view('spettatore',1,30000,new Set()).table,null);
  e.action(actor,c,30000);assert.throws(()=>e.action(actor,c,30000));e.assertIntegrity();
});

test('MTT: checkpoint dopo ogni azione produce identico board, piatti e vincitori',()=>{
  let e=fixture(6);let now=30000;
  const rng=new SeededRandomSource(13);
  for(let i=0;i<400 && e.state.status==='running';i++) {
    const t=e.state.tables.find(x=>x.deadline!==null);
    if(t) {
      const c=action(e,t), id=t.hand!.toActPlayerId!;
      const resumed=new MttEngine(JSON.parse(JSON.stringify(e.state)));
      const previous=JSON.stringify(e.state);
      resumed.action(id,c,now);
      assert.equal(JSON.stringify(e.state),previous);
      e.action(id,c,now);assert.deepEqual(resumed.state,e.state);
    } else { now+=4000;e.tick(now,rng); }
    e.assertIntegrity();
  }
  assert.equal(e.state.status,'finished');
  assert.equal(e.state.players.reduce((a,p)=>a+p.stack,0),9000);
});

for(const n of [12,18]) test(`MTT: ${n} giocatori, riequilibrio, finale e premio unico`,()=>{
  const e=fixture(n);const rng=new SeededRandomSource(99);let now=30000;let hadFinal=false;
  for(let i=0;i<2000 && e.state.status==='running';i++) {
    for(const t of [...e.state.tables]) if(t.deadline!==null) e.action(t.hand!.toActPlayerId!,action(e,t),now);
    if(e.state.tables.every(t=>t.deadline===null)) { now+=4000;e.tick(now,rng); }
    hadFinal ||= e.state.tables.length===1;
    e.assertIntegrity();
  }
  assert.equal(e.state.status,'finished');assert.equal(hadFinal,true);
  assert.equal(e.state.players.filter(p=>p.place===1).length,1);
  assert.equal(e.state.players.reduce((a,p)=>a+p.points,0),100);
  assert.equal(e.state.players.reduce((a,p)=>a+p.stack,0),n*1500);
});

test('MTT: ripresa congela clock e timer, timeout ripetuto non duplica azione',()=>{
  const e=fixture(2);e.state.savedAt=30000;const deadline=e.state.tables[0]!.deadline!;
  e.resume(130000);assert.equal(e.state.startedAt,130000);assert.equal(e.state.tables[0]!.deadline,deadline+100000);
  const version=e.state.tables[0]!.version;e.tick(deadline+100000);
  assert.ok(e.state.tables[0]!.version>version);const saved=JSON.stringify(e.state);
  e.tick(deadline+100000);assert.equal(JSON.stringify(e.state),saved);
});

function memoryStore() {
  const records=new Map<string,MttRecord>(), receipts=new Map<string,string>();let failAfter=false;
  const fn=async(a:string,p:Record<string,any>={})=>{
    if(a==='access')return {admin:p.userId==='admin'};
    if(a==='list')return structuredClone([...records.values()]);
    if(a==='create') {
      if(p.userId!=='admin')throw Error('admin');
      if(!records.has(p.id))records.set(p.id,{id:p.id,revision:0,epoch:0,owner:null,snapshot:structuredClone(p.snapshot)});
      return structuredClone(records.get(p.id));
    }
    const r=records.get(p.id)!; const key=`${p.id}:${p.requestId}`, fingerprint=JSON.stringify([p.actor,p.command]);
    if(a==='receipt'||a==='commit') {
      if(receipts.has(key)){assert.equal(receipts.get(key),fingerprint);return a==='receipt'?{found:true}:structuredClone(r);}
      if(a==='receipt')return {found:false};
    }
    if(a==='acquire'){if(r.owner!==p.owner){r.epoch++;r.owner=p.owner;}return structuredClone(r);}
    if(a==='release'){r.owner=null;return structuredClone(r);}
    if(a==='commit') {
      assert.equal(r.revision,p.revision);assert.equal(r.epoch,p.epoch);assert.equal(r.owner,p.owner);
      r.snapshot=structuredClone(p.snapshot);r.revision++;receipts.set(key,fingerprint);
      if(failAfter){failAfter=false;throw Error('ACK perso');}
      return structuredClone(r);
    }
    throw Error(a);
  };
  return {store:fn as MttStore,records,lose:()=>{failAfter=true;}};
}

test('MTT service: DB conferma ma ACK perso, retry, shutdown e ripresa senza doppia iscrizione',async()=>{
  const mem=memoryStore();let now=0;
  const s=new MttService(mem.store,()=>now);await s.refresh();
  const id=randomUUID();await s.command('admin','Admin',{kind:'create',requestId:randomUUID(),tournamentId:id,config});
  const c:MttCommand={kind:'join',requestId:randomUUID(),tournamentId:id};
  mem.lose();await assert.rejects(s.command('p1','Uno',c));
  await s.command('p1','Uno',c);
  assert.equal(mem.records.get(id)!.snapshot.players.length,1);
  await s.command('p2','Due',{...c,requestId:randomUUID()});
  now=30000;await s.tick();const original=structuredClone(mem.records.get(id)!.snapshot);
  assert.equal(original.status,'running');await s.shutdown();
  now=90000;const restarted=new MttService(mem.store,()=>now);await restarted.refresh();await restarted.tick();
  const recovered=mem.records.get(id)!.snapshot;
  assert.equal(recovered.startedAt,90000);
  assert.deepEqual(recovered.tables[0]!.hand,original.tables[0]!.hand);
  assert.equal(restarted.hasPlayer('p1'),true);
  assert.equal(restarted.state('p1',id).selected!.table!.players.filter(p=>p.holeCards?.length).length,1);
});
