import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { attachMtt } from '../game/mtt-socket.js';
import { MttService } from '../game/mtt-service.js';
import { MttEvent, type MttState, type MttReply } from '../game/mtt-protocol.js';
import { ActionType } from '../engine/index.js';
import type { MttStore, MttRecord } from '../wallet/mtt.js';

test('MTT Socket.IO: due browser, privacy, retry e riconnessione', async()=>{
  let now=0;const records=new Map<string,MttRecord>(), receipts=new Set<string>();
  const store=(async(a:string,p:Record<string,any>={})=>{
    if(a==='list')return structuredClone([...records.values()]);
    if(a==='access')return {admin:false};
    if(a==='create'){const r={id:p.id,snapshot:p.snapshot,revision:0,owner:null,epoch:0};records.set(p.id,r);return structuredClone(r);}
    const r=records.get(p.id)!;
    if(a==='receipt')return {found:receipts.has(p.requestId)};
    if(a==='acquire'){r.owner=p.owner;return structuredClone(r);}
    if(a==='release'){r.owner=null;return structuredClone(r);}
    if(a==='commit') {if(!receipts.has(p.requestId)){r.snapshot=structuredClone(p.snapshot);r.revision++;receipts.add(p.requestId);}return structuredClone(r);}
    throw Error(a);
  }) as MttStore;
  const service=new MttService(store,()=>now);await service.refresh();
  const id=randomUUID();await service.command('admin','Admin',{kind:'create',requestId:randomUUID(),tournamentId:id,
    config:{name:'Socket reale',capacity:2,minimum:2,startingStack:1500,scheduledAt:30000,levelMs:60000,bigBlinds:[20,40]}});
  const http=createServer(),io=new Server(http),clients:WebSocket[]=[];
  io.on('connection',socket=>attachMtt(socket,{userId:String(socket.handshake.auth.testUser),username:'Test'},service,job=>job()));
  const wait=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('Timeout Socket.IO');await new Promise(r=>setTimeout(r,10));}};
  try {
    await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const addr=http.address();assert.ok(addr&&typeof addr!=='string');
    async function connect(user:string) {
      const ws=new WebSocket(`ws://127.0.0.1:${(addr as {port:number}).port}/socket.io/?EIO=4&transport=websocket`);clients.push(ws);
      let ready=false,seq=0,state:MttState|null=null;
      const callbacks=new Map<number,(r:MttReply)=>void>();
      ws.addEventListener('message',event=>{
        const text=String(event.data);
        if(text.startsWith('0'))ws.send('40'+JSON.stringify({testUser:user}));
        else if(text==='2')ws.send('3');
        else if(text.startsWith('40'))ready=true;
        else if(text.startsWith('42')){const [event,data]=JSON.parse(text.slice(2));if(event===MttEvent.State)state=data;}
        else if(text.startsWith('43')){const bracket=text.indexOf('['),ack=Number(text.slice(2,bracket));callbacks.get(ack)?.(JSON.parse(text.slice(bracket))[0]);callbacks.delete(ack);}
      });
      await wait(()=>ready);
      const send=(event:string,data:unknown)=>new Promise<MttReply>((resolve,reject)=>{
        const ack=++seq,timer=setTimeout(()=>reject(Error('ACK mancante')),4000);
        callbacks.set(ack,r=>{clearTimeout(timer);resolve(r);});ws.send('42'+ack+JSON.stringify([event,data]));
      });
      assert.equal((await send(MttEvent.Watch,{id})).ok,true);
      return {ws,send,view:()=>state?.selected};
    }
    const a=await connect('a'),b=await connect('b');
    for(const c of [a,b])assert.equal((await c.send(MttEvent.Command,{kind:'join',tournamentId:id,requestId:randomUUID()})).ok,true);
    now=30000;await service.tick();await wait(()=>!!a.view()?.table && !!b.view()?.table);
    for(const c of [a,b])assert.equal(c.view()!.table!.players.filter(p=>p.holeCards?.length).length,1);
    const actor=a.view()!.table!.isYourTurn?a:b, other=actor===a?b:a, v=actor.view()!;
    const command={kind:'action',requestId:randomUUID(),tournamentId:id,tableId:v.table!.tableId,
      handId:v.table!.handId,version:v.actionVersion,type:ActionType.Fold};
    assert.equal((await other.send(MttEvent.Command,command)).ok,false);
    assert.equal((await actor.send(MttEvent.Command,command)).ok,true);
    const revision=records.get(id)!.revision;
    assert.equal((await actor.send(MttEvent.Command,command)).ok,true);
    assert.equal(records.get(id)!.revision,revision);
    a.ws.close();const reconnected=await connect('a');
    await wait(()=>!!reconnected.view()?.table);
    assert.equal(reconnected.view()!.registered,true);assert.equal(records.get(id)!.snapshot.players.length,2);
  } finally {
    for(const c of clients)c.close();await service.shutdown();await new Promise<void>(r=>io.close(()=>r()));
  }
});
