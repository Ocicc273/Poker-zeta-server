import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MttService } from '../game/mtt-service.js';
import { ActionType } from '../engine/index.js';
import type { MttStore } from '../wallet/mtt.js';

// Integrazione locale facoltativa: richiede PGLITE_MODULE e MTT_MIGRATION, mai un DB pubblico.
test('MTT completo su PostgreSQL: 12 iscritti, riavvio, finale e premio', {skip:!process.env.PGLITE_MODULE || !process.env.MTT_MIGRATION}, async()=>{
  const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE!).href);
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key, raw_app_meta_data jsonb default '{}');`);
    await db.exec(readFileSync(process.env.MTT_MIGRATION!,'utf8'));
    const admin=randomUUID(), users=Array.from({length:12},()=>randomUUID());
    await db.query('insert into auth.users values($1,$2)',[admin,{tournaments_admin:true}]);
    for(const id of users)await db.query('insert into auth.users(id) values($1)',[id]);
    const store:MttStore=async<T>(action:string,args:Record<string,unknown>={})=>{
      return (await db.query('select public.pz_mtt_command($1,$2::jsonb) r',[action,JSON.stringify(args)])).rows[0].r as T;
    };
    let now=0, service=new MttService(store,()=>now);await service.refresh();
    const id=randomUUID();await service.command(admin,'Admin',{kind:'create',requestId:randomUUID(),tournamentId:id,
      config:{name:'Integrazione reale SQL',capacity:12,minimum:2,startingStack:1500,scheduledAt:30000,levelMs:60000,bigBlinds:[20,40,80,160,320,640,1280,2560,5120,10240]}});
    for(const user of users)await service.command(user,'Giocatore',{kind:'join',requestId:randomUUID(),tournamentId:id});
    now=30000;await service.tick();
    const before=service.state(users[0]!,id).selected!.table;
    await service.shutdown();now+=60000;service=new MttService(store,()=>now);await service.refresh();await service.tick();
    const after=service.state(users[0]!,id).selected!.table;
    assert.equal(after!.handId,before!.handId);assert.deepEqual(after!.players,before!.players);
    for(let i=0;i<1500 && service.state(users[0]!,id).selected!.status==='running';i++) {
      for(const user of users) {
        const s=service.state(user,id).selected!;
        if(s.table?.isYourTurn) await service.command(user,'Giocatore',{kind:'action',requestId:randomUUID(),tournamentId:id,
          tableId:s.table.tableId,handId:s.table.handId!,version:s.actionVersion,type:ActionType.AllIn});
      }
      now+=4000;await service.tick();
    }
    const final=service.state(users[0]!,id).selected!;
    assert.equal(final.status,'finished');assert.equal(final.players.reduce((a,p)=>a+p.stack,0),18000);
    assert.equal((await db.query('select count(*) n from public.pz_mtt_rewards')).rows[0].n,1);
    assert.equal((await db.query('select count(*) n from public.pz_mtt_members where active')).rows[0].n,0);
    await service.shutdown();
  } finally {await db.close();}
});
