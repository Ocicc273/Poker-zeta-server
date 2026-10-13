import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { PrivateRoom } from '../game/private-room.js';
import { ActionType } from '../engine/table-types.js';
import type { TableView } from '../game/protocol.js';

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean):Promise<void> {
  const deadline=Date.now()+7000;
  while(!check()) { if(Date.now()>deadline) throw Error('Timeout socket showdown'); await pause(10); }
}

// Trasporto Socket.IO reale, stanza reale, account di test locali: nessun wallet/Auth esterno.
test('showdown Socket.IO: tre utenti, fold privato, risultati sincronizzati e reconnect senza doppio accredito',async()=>{
  const http=createServer();
  const io=new Server(http);
  const views=new Map<string,TableView>();
  const clients:WebSocket[]=[];
  const errors:string[]=[];
  const room=new PrivateRoom({code:'SDTEST',hostId:'A',buyIn:1000,startingStack:1000,maxSeats:6,
    manualStart:true,rakePercent:0,
    sendState:(id,view)=>io.to(id).emit('view',view),sendError:(_,message)=>errors.push(message)});
  io.on('connection',socket=>{
    const id=String(socket.handshake.auth.playerId);
    if(!['A','B','C'].includes(id)) {socket.disconnect();return;}
    void socket.join(id);
    socket.on('join',()=>room.siediti(id,id,1000));
    socket.on('start',()=>room.avviaDaHost(id));
    socket.on('action',(type:ActionType)=>room.azione(id,type));
    socket.on('disconnect',()=>room.disconnetti(id));
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const address=http.address();assert.ok(address && typeof address!=='string');
  async function connect(id:string):Promise<WebSocket> {
    const ws=new WebSocket(`ws://127.0.0.1:${(address as {port:number}).port}/socket.io/?EIO=4&transport=websocket`);
    clients.push(ws);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Handshake Socket.IO scaduto')),7000);
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Socket.IO non raggiungibile'));});
      ws.addEventListener('message',event=>{
        const packet=String(event.data);
        if(packet.startsWith('0')) ws.send('40'+JSON.stringify({playerId:id}));
        else if(packet==='2') ws.send('3');
        else if(packet.startsWith('40')) {clearTimeout(timer);resolve();}
        else if(packet.startsWith('42')) {
          const [name,data]=JSON.parse(packet.slice(2)) as [string,TableView];
          if(name==='view') views.set(id,data);
        }
      });
    });
    ws.send('42["join"]');
    return ws;
  }
  try {
    const sockets=new Map<string,WebSocket>();
    for(const id of ['A','B','C']) sockets.set(id,await connect(id));
    await until(()=>views.get('A')?.players.length===3);
    sockets.get('A')!.send('42["start"]');
    await until(()=>Boolean(views.get('A')?.handId));
    for(const id of ['A','B','C']) {
      const v=views.get(id)!;
      assert.ok(v.players.filter(p=>p.playerId!==id).every(p=>p.holeCards===null));
      assert.deepEqual(v.showdown,[]);
    }
    const folded=views.get('A')!.toActPlayerId!;
    sockets.get(folded)!.send('42'+JSON.stringify(['action',ActionType.Fold]));
    await until(()=>views.get('A')?.players.find(p=>p.playerId===folded)?.status==='folded');
    for(let n=0;n<30 && !views.get('A')!.isHandComplete;n++) {
      const v=views.get('A')!,actor=v.toActPlayerId!;
      await until(()=>views.get(actor)?.privateTable?.revision===v.privateTable?.revision);
      const mine=views.get(actor)!;
      const action=mine.availableActions.some(a=>a.type===ActionType.Check)?ActionType.Check:ActionType.Call;
      const revision=v.privateTable!.revision;
      sockets.get(actor)!.send('42'+JSON.stringify(['action',action]));
      await until(()=>views.get('A')?.privateTable?.revision!==revision);
    }
    await until(()=>['A','B','C'].every(id=>views.get(id)?.isHandComplete));
    const final=views.get('A')!;
    assert.equal(final.players.find(p=>p.isDealer)?.playerId,'A');
    assert.equal(final.players.reduce((sum,p)=>sum+p.stack,0),3000);
    for(const id of ['A','B','C']) {
      const v=views.get(id)!;
      assert.deepEqual(v.showdown,final.showdown);
      assert.deepEqual(v.payouts,final.payouts);
      assert.deepEqual(v.winnerIds,final.winnerIds);
      if(id!==folded) assert.equal(v.players.find(p=>p.playerId===folded)?.holeCards,null);
    }
    const money=(v:TableView)=>({handId:v.handId,payouts:v.payouts,showdown:v.showdown,
      winners:v.winnerIds,stacks:v.players.map(p=>[p.playerId,p.stack])});
    const before=money(final);
    sockets.get('B')!.close();
    await until(()=>!views.get('A')!.privateTable!.connectedPlayerIds.includes('B'));
    await connect('B');
    await until(()=>views.get('B')!.privateTable!.connectedPlayerIds.includes('B'));
    assert.deepEqual(money(views.get('B')!),before);
    assert.deepEqual(errors,[]);
  } finally {
    room.close();
    for(const ws of clients) ws.close();
    await new Promise<void>(resolve=>io.close(()=>resolve()));
  }
});
