import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chipUnits, clubBlinds, CLUB_BLINDS, assertClubConservation, openClubSeat, reloadClubSeat,
  closeClubSeat, ClubGate, type ClubCheckpoint } from '../game/club-ledger.js';

function checkpoint(): ClubCheckpoint {
  return { code: 'TEST', requestId: randomUUID(), clubId: randomUUID(), hostId: 'mario', tableName: 'Test Club',
    maxSeats: 6, rakePercent: 0, smallBlind: 25, bigBlind: 50, allocations: { mario: 50000, luca: 150000,
      anna: 300000, paolo: 75000 }, seats: [], rakeUnits: 0, version: 0, closed: false, inHand: false };
}
test('Club: decimali esatti, virgola italiana e tutti i preset', () => {
  assert.equal(chipUnits('0,25'),25);
  assert.equal(chipUnits(0.5),50);
  assert.equal(chipUnits('10000000'),1_000_000_000);
  for (const raw of [-1, 0, NaN, Infinity, '0.001', '1e3', '', true, '10000000.01']) assert.throws(()=>chipUnits(raw));
  assert.deepEqual(clubBlinds(0.25,0.5),{ smallBlind:25,bigBlind:50,ante:0 });
  assert.deepEqual(clubBlinds(0.5,1),{ smallBlind:50,bigBlind:100,ante:0 });
  assert.deepEqual(clubBlinds(250,500),{ smallBlind:25000,bigBlind:50000,ante:0 });
  for (const [smallBlind,bigBlind] of CLUB_BLINDS)
    assert.deepEqual(clubBlinds(smallBlind/100,bigBlind/100),{smallBlind,bigBlind,ante:0});
  assert.throws(()=>clubBlinds(2,1));
});

test('Club: un rifiuto definitivo non viene ritentato né conferma chips non salvate', async () => {
  process.env.SUPABASE_URL='https://example.invalid';
  process.env.SUPABASE_PUBLISHABLE_KEY='test-only';
  process.env.MATCH_SERVER_SECRET='test-only-not-a-production-secret';
  process.env.CLUB_PHASE3_ENABLED='true';
  const manager=await import('../game/club-room-manager.js');
  const {clubStore,ClubStoreError}=await import('../wallet/club-session.js');
  const original={...clubStore}, originalMission=manager.clubEffects.recordMissionEvent;
  manager.clubEffects.recordMissionEvent=async()=>0;
  const host=randomUUID(),club=randomUUID(),requestId=randomUUID();
  let saved:ClubCheckpoint|undefined, commits=0, rejectCommit=true;
  let displayed=0;
  Object.assign(clubStore,{
    authorize:async()=>true,receipt:async()=>false,recover:async()=>[structuredClone(saved!)],
    create:async(state:ClubCheckpoint)=>{saved={...structuredClone(state),code:'FAIL01'};
      delete saved.allocations[state.hostId];return structuredClone(saved);},
    commit:async(state:ClubCheckpoint)=>{
      commits++;
      if(rejectCommit) throw new ClubStoreError('Permesso admin richiesto',403);
      saved=structuredClone({...state,version:state.version+1});
      return saved.version;
    },
  });
  manager.configureClubRooms({to:()=>({emit:(event:string,data:any)=>{
    if(event==='server:table-state') displayed=data.players[0].stack;
  }}),sockets:{sockets:new Map()}});
  try{
    const code=await manager.createClubRoom(host,host,'Mario',{clubId:club,requestId:randomUUID(),
      tableName:'Rifiuto definitivo',maxSeats:2,rakePercent:0,smallBlind:0.5,bigBlind:1,
      initialStacks:{[host]:500}});
    assert.equal(displayed,500);
    await assert.rejects(()=>manager.reloadClub(host,code,host,50,requestId),/Permesso admin/);
    assert.equal(commits,1);
    assert.equal(saved!.seats[0].reloadUnits,0);
    assert.equal(displayed,500);
    assert.equal(manager.clubRoomByCode(code)!.checkpointPending(),true);
    await assert.rejects(()=>manager.currentClubStacks(host,code),/Salvataggio/);
    await assert.rejects(()=>manager.reloadClub(host,code,host,50,requestId),/sospeso/);
    assert.equal(commits,1);
    await manager.stopClubRooms();
    await manager.recoverClubRooms();
    assert.equal(manager.clubRoomByCode(code)!.accountingStacks()[0].stack,50000);
    rejectCommit=false;
    await manager.reloadClub(host,code,host,50,requestId);
    assert.equal(saved!.seats[0].reloadUnits,5000);
    await manager.closeClub(host,code);
    assert.equal(saved!.seats[0].finalUnits,55000);
  }finally{
    await manager.stopClubRooms();
    Object.assign(clubStore,original);
    manager.clubEffects.recordMissionEvent=originalMission;
  }
});
test('Club: quattro stack, ricariche additive e risultato netto', () => {
  const state=checkpoint();
  for (const id of ['mario','luca','anna','paolo']) openClubSeat(state,id,id);
  assert.deepEqual(state.seats.map(s=>s.currentUnits),[50000,150000,300000,75000]);
  assert.equal(openClubSeat(state,'luca','Luca').id,state.seats[1].id);
  reloadClubSeat(state,'luca',12525);
  reloadClubSeat(state,'luca',2500);
  assert.equal(state.seats[1].reloadUnits,15025);
  assert.equal(state.seats[1].currentUnits,165025);
  state.seats[0].currentUnits+=65000;
  state.seats[1].currentUnits-=65000;
  assertClubConservation(state);
  closeClubSeat(state,'mario');
  closeClubSeat(state,'luca');
  assert.equal(state.seats[0].finalUnits!-state.seats[0].initialUnits,65000);
  assert.equal(state.seats[1].finalUnits!-state.seats[1].initialUnits-state.seats[1].reloadUnits,-65000);
  closeClubSeat(state,'mario');
  assertClubConservation(state);
  assert.throws(()=>openClubSeat(state,'mario','Mario'),/autorizzato/);
  state.seats[2].currentUnits++;
  assert.throws(()=>assertClubConservation(state));
});
test('Club: coda seriale anche dopo un errore', async () => {
  const gate=new ClubGate(), order:number[]=[];
  const a=gate.run(async()=>{order.push(1);await new Promise(r=>setTimeout(r,5));order.push(2);});
  const b=gate.run(async()=>{order.push(3);throw new Error('rifiutata');}).catch(()=>undefined);
  const c=gate.run(async()=>{order.push(4);});
  await Promise.all([a,b,c]);
  assert.deepEqual(order,[1,2,3,4]);
});

test('Club: bui frazionari, pot e rake conservano ogni centesimo', async () => {
  const { PrivateRoom } = await import('../game/private-room.js');
  const { ActionType } = await import('../engine/index.js');
  let view: any;
  const room = new PrivateRoom({ code:'RAKE',hostId:'a',buyIn:1000,manualStart:true,rakePercent:6,
    clubBlinds:{smallBlind:25,bigBlind:50,ante:0},
    sendState:(_id,v)=>{view=v;},sendError:(_id,message)=>{throw new Error(message);} });
  try {
    for(const [id,stack] of [['a',50000],['b',150000],['c',300000],['d',75000]] as const) room.siediti(id,id,stack);
    room.avviaDaHost('a');
    await new Promise(r=>setTimeout(r,1550));
    let guard=0;
    while(room.handInProgress() && guard++<30) {
      const who=view.toActPlayerId;
      room.inviaA(who);
      const available=view.availableActions;
      room.azione(who,available.some((a:any)=>a.type===ActionType.Check) ? ActionType.Check : ActionType.Call);
    }
    assert.equal(room.handInProgress(),false);
    assert.equal(room.rakeTotal(),12);
    assert.equal(room.accountingStacks().reduce((n,p)=>n+p.stack,0)+room.rakeTotal(),575000);
  } finally {room.close();}
});

test('Club: server autoritativo, duplicati, reconnect, crash e chiusura automatica', async () => {
  process.env.SUPABASE_URL='https://example.invalid';
  process.env.SUPABASE_PUBLISHABLE_KEY='test-only';
  process.env.MATCH_SERVER_SECRET='test-only-not-a-production-secret';
  process.env.CLUB_PHASE3_ENABLED='true';
  const manager=await import('../game/club-room-manager.js');
  const originalMissionRecorder=manager.clubEffects.recordMissionEvent;
  let missionCount=0;
  manager.clubEffects.recordMissionEvent=async()=>{missionCount++;return 0;};
  const { clubStore }=await import('../wallet/club-session.js');
  const { ActionType }=await import('../engine/index.js');
  const { ServerEvent }=await import('../game/protocol.js');
  const host=randomUUID(), luca=randomUUID(), anna=randomUUID(), paolo=randomUUID(), club=randomUUID();
  const users=new Set<string>([host,luca,anna,paolo]);
  let saved:ClubCheckpoint|undefined;
  const operations=new Map<string,{ operation: unknown; version:number }>();
  const views=new Map<string,any>();
  let writes=0;
  let loseResponse=false;
  const originals={...clubStore};
  Object.assign(clubStore,{
    authorize:async(id:string,c:string,admin=false)=>c===club && users.has(id) && (!admin || id===host),
    create:async(state:ClubCheckpoint)=>{ if (!saved) {saved={...structuredClone(state),code:'CLUB01'};
      delete saved.allocations[state.hostId];}return structuredClone(saved); },
    recover:async()=>saved && !saved.closed ? [structuredClone(saved)] : [],
    receipt:async(_code:string,op: any)=>{
      const previous=operations.get(op.id);
      if (previous) assert.deepEqual(previous.operation,op);
      return Boolean(previous);
    },
    commit:async(state:ClubCheckpoint,op:any)=>{
      const previous=operations.get(op.id);
      if (previous) return previous.version;
      assert.equal(state.version,saved!.version);
      assertClubConservation(state);
      saved=structuredClone({...state,version:state.version+1});
      operations.set(op.id,{operation:structuredClone(op),version:saved.version});
      writes++;
      if(loseResponse) { loseResponse=false; throw new Error('Risposta persa dopo il commit'); }
      return saved.version;
    },
  });
  manager.configureClubRooms({
    to:(id:string)=>({emit:(event:string,data:unknown)=>{if(event===ServerEvent.TableState)views.set(id,data);}}),
    sockets:{sockets:new Map()},
  } as any);
  try {
    const requestId=randomUUID();
    const request={ clubId:club,tableName:'Tavolo test',gameMode:'holdem',requestId,stakeLevel:1,
      maxSeats:6,rakePercent:0,startingStack:1000,smallBlind:0.25,bigBlind:0.5,
      initialStacks:{[host]:500,[luca]:1500,[anna]:3000,[paolo]:750} };
    const code=await manager.createClubRoom(host,host,'Mario',request);
    assert.equal(await manager.createClubRoom(host,host,'Mario',request),code);
    for(const [id,name] of [[luca,'Luca'],[anna,'Anna'],[paolo,'Paolo']])
      await manager.joinClubRoom(id,code,id,name);
    assert.deepEqual(saved!.seats.map(s=>s.currentUnits),[50000,150000,300000,75000]);
    assert.equal(views.get(host).blinds.smallBlind,0.25);
    assert.equal(views.get(host).blinds.bigBlind,0.5);
    const reloadId=randomUUID();
    await manager.reloadClub(host,code,luca,125.25,reloadId);
    const afterReload=writes;
    await manager.reloadClub(host,code,luca,125.25,reloadId);
    assert.equal(writes,afterReload);
    assert.equal(saved!.seats.find(s=>s.userId===luca)!.reloadUnits,12525);
    await assert.rejects(()=>manager.reloadClub(host,code,luca,126,reloadId));
    await assert.rejects(()=>manager.reloadClub(luca,code,luca,9999,randomUUID()));
    loseResponse=true;
    await manager.reloadClub(host,code,luca,25.5,randomUUID());
    assert.equal(saved!.seats.find(s=>s.userId===luca)!.reloadUnits,15075);
    const oldId=saved!.seats.find(s=>s.userId===anna)!.id;
    manager.detachClubSocket(anna,anna);
    await manager.joinClubRoom('anna-reconnected',code,anna,'Anna');
    assert.equal(saved!.seats.find(s=>s.userId===anna)!.id,oldId);
    assert.equal(saved!.seats.filter(s=>s.userId===anna).length,1);
    await manager.startClub(host);
    await new Promise(r=>setTimeout(r,1650));
    assert.equal(manager.clubRoomByCode(code)!.handInProgress(),true);
    await assert.rejects(()=>manager.reloadClub(host,code,luca,100,randomUUID()));
    await assert.rejects(()=>manager.closeClub(host,code));
    let guard=0;
    while(manager.clubRoomByCode(code)!.handInProgress() && guard++<6){
      const actor=views.get(host).toActPlayerId;
      await manager.actClub(actor,ActionType.Fold,undefined,randomUUID());
    }
    assert.equal(manager.clubRoomByCode(code)!.handInProgress(),false);
    assertClubConservation(saved!);
    assert(saved!.seats.some(s=>s.currentUnits>s.initialUnits+s.reloadUnits));
    assert(saved!.seats.some(s=>s.currentUnits<s.initialUnits+s.reloadUnits));
    const beforeLeave=saved!.seats.find(s=>s.userId===anna)!.currentUnits;
    assert.equal(await manager.leaveClub(anna),true);
    assert.equal(await manager.leaveClub(anna),false);
    assert.equal(saved!.seats.find(s=>s.userId===anna)!.finalUnits,beforeLeave);
    await assert.rejects(()=>manager.joinClubRoom('anna-without-approval',code,anna,'Anna'),/autorizzato/);
    await assert.rejects(()=>manager.assignClub(luca,code,anna,750,randomUUID()),/Permesso/);
    await manager.assignClub(host,code,anna,750,randomUUID());
    await manager.joinClubRoom('anna-new-authorized-session',code,anna,'Anna');
    const visits=saved!.seats.filter(s=>s.userId===anna);
    assert.equal(visits.length,2);
    assert.equal(visits[0].finalUnits,beforeLeave);
    assert.equal(visits[1].initialUnits,75000);
    assert.equal(saved!.allocations[anna],undefined);
    await manager.startClub(host);
    await new Promise(r=>setTimeout(r,6050));
    assert.equal(manager.clubRoomByCode(code)!.handInProgress(),true);
    const beforeCrash=structuredClone(saved);
    await manager.stopClubRooms();
    await manager.recoverClubRooms();
    assert.equal(manager.clubRoomByCode(code)!.handInProgress(),false);
    assert.deepEqual(saved!.seats.map(s=>[s.id,s.currentUnits,s.finalUnits]),
      beforeCrash!.seats.map(s=>[s.id,s.currentUnits,s.finalUnits]));
    await manager.joinClubRoom('luca-after-crash',code,luca,'Luca');
    await manager.reloadClub(host,code,luca,125.25,reloadId);
    assert.equal(saved!.seats.find(s=>s.userId===luca)!.reloadUnits,15075);
    await manager.closeClub(host,code);
    assert(saved!.closed);
    assert(saved!.seats.every(s=>s.finalUnits!==null));
    assertClubConservation(saved!);
    assert.equal(await manager.closeClub(host,code),true);
    assert.equal(saved!.seats.length,5);
    assert.equal(missionCount,5); // Una creazione e quattro partecipanti alla mano conclusa.
  } finally {
    await manager.stopClubRooms();
    Object.assign(clubStore,originals);
    manager.clubEffects.recordMissionEvent=originalMissionRecorder;
  }
});
