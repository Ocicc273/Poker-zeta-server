import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateRoom } from '../game/private-room.js';
import { ActionType } from '../engine/index.js';
import type { TableView } from '../game/protocol.js';

test('Club: un comando rifiutato durante il checkpoint non riavvia il tempo del turno', async()=>{
  let view:TableView|undefined;
  const errors:string[]=[];
  const room=new PrivateRoom({code:'TIMER1',hostId:'a',buyIn:1000,manualStart:true,
    clubBlinds:{smallBlind:50,bigBlind:100,ante:0},sendState:(_,v)=>{view=v;},
    sendError:(_,message)=>{errors.push(message);}});
  try{
    room.siediti('a','Mario',50000);room.siediti('b','Luca',150000);
    room.avviaDaHost('a');
    await new Promise(r=>setTimeout(r,1550));
    assert(view?.toActPlayerId);
    const before=view.turnMillisLeft!;
    await new Promise(r=>setTimeout(r,40));
    room.holdCheckpoint();
    room.azione(view.toActPlayerId==='a'?'b':'a',ActionType.Check);
    room.resumeCheckpoint();
    assert.equal(errors.length,1);
    assert(view.turnMillisLeft!<=before-20);
  }finally{room.close();}
});
