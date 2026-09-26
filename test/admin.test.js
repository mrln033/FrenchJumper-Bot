import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { canPublish, handleAdmin, readBotSettings, settingsEnv } from '../src/admin.js';
import { runEntropiaPoll } from '../src/index.js';

const guildId='442710603300208652', roleId='464513638414417930', userId='123456789012345678', botId='1479825051522957462', channelId='1553100694503034940';
const origin='https://frenchjumper-bot.enzo-488.workers.dev';
function setup() {
  const sql = new DatabaseSync(':memory:');
  for(const f of ['0002_entropia_polling.sql','0003_admin.sql']) sql.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const DB={prepare(query){let values=[];const statement={bind(...v){values=v;return statement;},async first(){return sql.prepare(query).get(...values)||null;},async all(){return {results:sql.prepare(query).all(...values)};},async run(){return {meta:{changes:sql.prepare(query).run(...values).changes}};}};return statement;},async batch(items){return Promise.all(items.map(i=>i.run()));}};
  return { sql, env:{DB,ADMIN_ORIGIN:origin,ADMIN_GUILD_ID:guildId,ALLOWED_GUILD_IDS:guildId,ADMIN_ROLE_IDS:roleId,DISCORD_CLIENT_ID:botId,DISCORD_CLIENT_SECRET:'test-only-secret',BOT_TOKEN:'test-only-bot',ENTROPIA_DISCORD_CHANNEL_ID:channelId,ENTROPIA_PUBLISH_ENABLED:'true',ENTROPIA_POLLING_ENABLED:'true'} };
}
function mockDiscord(roles=[roleId]) { return async(url)=>{
  const path=new URL(url).pathname;
  if(path==='/api/oauth2/token') return Response.json({access_token:'test-oauth'});
  if(path==='/api/v10/users/@me') return Response.json({id:userId});
  if(path.endsWith('/members/'+userId)) return Response.json({roles});
  if(path.endsWith('/roles')) return Response.json([{id:guildId,name:'everyone',permissions:'19456'},{id:roleId,name:'Admin',permissions:'0'},{id:'555555555555555555',name:'Officier',permissions:'0'}]);
  if(path.endsWith('/channels')) return Response.json([{id:channelId,guild_id:guildId,name:'comparaison',type:0,permission_overwrites:[]}]);
  if(path==='/api/v10/guilds/'+guildId) return Response.json({id:guildId,owner_id:'999999999999999999'});
  throw new Error('Unexpected '+url);
}; }
async function login(env, fetcher=mockDiscord()) {
  const start=await handleAdmin(new Request(origin+'/admin/login'),env,fetcher);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const stateCookie=start.headers.getSetCookie()[0].split(';')[0];
  const callback=await handleAdmin(new Request(origin+'/admin/callback?code=test&state='+state,{headers:{cookie:stateCookie}}),env,fetcher);
  assert.equal(callback.status,302);
  return callback.headers.getSetCookie().find(s=>s.startsWith('__Host-frj-session=')).split(';')[0];
}
function req(path,cookie,body,headers={}) {return new Request(origin+'/admin/'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{origin,'content-type':'application/json','x-frj-admin':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});}

test('Admin fails closed without OAuth secret, and anonymous APIs require login',async()=>{
  const {env}=setup();
  assert.equal((await handleAdmin(new Request(origin+'/admin/api/status'),{...env,DISCORD_CLIENT_SECRET:''})).status,503);
  assert.equal((await handleAdmin(new Request(origin+'/admin/api/status'),env)).status,401);
  const page=await handleAdmin(new Request(origin+'/admin'),env);
  assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.doesNotMatch(await page.text(),/test-only-secret|test-only-bot/);
});
test('OAuth rejects forged state and users without approved roles',async()=>{
  const {env}=setup();let contacted=false;
  assert.equal((await handleAdmin(new Request(origin+'/admin/callback?code=x&state=x'),env,async()=>{contacted=true;})).status,400);
  assert.equal(contacted,false);
  const start=await handleAdmin(new Request(origin+'/admin/login'),env);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await handleAdmin(new Request(origin+'/admin/callback?code=x&state='+state,{headers:{cookie:start.headers.getSetCookie()[0].split(';')[0]}}),env,mockDiscord([]))).status,403);
});
test('Session roles are rechecked; CSRF and logout are enforced',async()=>{
  const {env}=setup(), cookie=await login(env);
  assert.equal((await handleAdmin(req('api/status',cookie),env,mockDiscord())).status,200);
  assert.equal((await handleAdmin(req('api/status',cookie),env,mockDiscord([]))).status,401);
  assert.equal((await handleAdmin(req('api/refresh-members',cookie,{}, {origin:'https://evil.example'}),env,mockDiscord())).status,403);
  assert.equal((await handleAdmin(req('api/refresh-members',cookie,{}, {'x-frj-admin':''}),env,mockDiscord())).status,403);
  assert.equal((await handleAdmin(req('logout',cookie,{}),env,mockDiscord())).status,200);
  assert.equal((await handleAdmin(req('api/status',cookie),env,mockDiscord())).status,401);
});
test('Expired sessions and hostile origins never authorize requests',async()=>{
  const {env,sql}=setup(), cookie=await login(env);
  assert.equal((await handleAdmin(new Request('https://evil.example/admin/api/status',{headers:{cookie}}),env,mockDiscord())).status,403);
  sql.exec('UPDATE admin_sessions SET expires_at=0');
  assert.equal((await handleAdmin(req('api/status',cookie),env,mockDiscord())).status,401);
  assert.equal((await handleAdmin(req('api/status','__Host-frj-session='+ 'a'.repeat(64)),env,mockDiscord())).status,401);
});
test('Settings are persistent, optimistic, permission checked, and reject writes during polling',async()=>{
  const {env,sql}=setup(), cookie=await login(env);
  const save=body=>handleAdmin(req('api/settings',cookie,body),env,mockDiscord());
  assert.equal((await save({channel_id:channelId,publishing:false,revision:0})).status,200);
  assert.equal((await settingsEnv(env)).ENTROPIA_PUBLISH_ENABLED,'false');
  assert.equal((await save({channel_id:channelId,publishing:true,revision:0})).status,409);
  assert.equal((await save({channel_id:channelId,publishing:true,revision:1})).status,200);
  assert.equal((await readBotSettings(env)).revision,2);
  assert.equal((await save({channel_id:'999999999999999999',publishing:true,revision:2})).status,400);
  sql.prepare('UPDATE entropia_poll_state SET lease_until=?').run(new Date(Date.now()+60000).toISOString());
  assert.equal((await save({channel_id:channelId,publishing:false,revision:2})).status,409);
  assert.equal((await handleAdmin(req('api/refresh-members',cookie,{}),env,mockDiscord())).status,409);
});
test('Extra roles can be granted, bootstrap role stays, everyone cannot be authorized',async()=>{
  const {env}=setup(), cookie=await login(env);
  const save=role_ids=>handleAdmin(req('api/roles',cookie,{role_ids}),env,mockDiscord());
  assert.equal((await save(['555555555555555555'])).status,200);
  const body=await (await handleAdmin(req('api/roles',cookie),env,mockDiscord())).json();
  assert.ok(body.selected.includes(roleId));
  assert.equal((await handleAdmin(req('api/status',cookie),env,mockDiscord(['555555555555555555']))).status,200);
  assert.equal((await save([guildId])).status,400);
  assert.equal((await save(['777777777777777777'])).status,400);
});
test('Bot channel permission calculation follows overwrite precedence',()=>{
  const guild={id:guildId,owner_id:'other'}, roles=[{id:guildId,permissions:'19456'}], member={roles:[roleId]};
  const ch={guild_id:guildId,type:0,permission_overwrites:[]};
  assert.equal(canPublish(ch,guild,roles,member,botId),true);
  ch.permission_overwrites=[{id:guildId,type:0,deny:'2048',allow:'0'}];
  assert.equal(canPublish(ch,guild,roles,member,botId),false);
  ch.permission_overwrites.push({id:roleId,type:0,deny:'0',allow:'2048'});
  assert.equal(canPublish(ch,guild,roles,member,botId),true);
  ch.permission_overwrites.push({id:botId,type:1,deny:'16384',allow:'0'});
  assert.equal(canPublish(ch,guild,roles,member,botId),false);
  assert.equal(canPublish({...ch,type:15},guild,roles,member,botId),false);
  assert.equal(canPublish({...ch,guild_id:'other'},guild,roles,member,botId),false);
});
test('Pause retains new globals and resume publishes them once using settings destination',async()=>{
  const {env,sql}=setup();const now=new Date('2026-09-26T10:00:00Z');
  sql.prepare('UPDATE entropia_poll_state SET roster_refreshed_at=?').run(now.toISOString());
  sql.prepare('INSERT INTO entropia_active_members(normalized_name,avatar_name,sync_token,synced_at) VALUES(?,?,?,?)').run('test avatar','Test Avatar','x',now.toISOString());
  sql.prepare('INSERT INTO bot_settings(singleton,channel_id,publishing) VALUES(1,?,0)').run(channelId);
  let posts=0;
  const fetcher=async(url,opts)=>{if(String(url).includes('/globals?'))return Response.json({items:[{id:99,avatarName:'Test Avatar',type:'Hunting',dateTime:now.toISOString(),globalValue:50}]});assert.ok(String(url).includes('/channels/'+channelId+'/messages'));assert.equal(opts.method,'POST');posts++;return Response.json({id:'message'});};
  await runEntropiaPoll(env,fetcher,{now});assert.equal(posts,0);
  assert.equal(sql.prepare('SELECT publish_status FROM entropia_polled_globals').get().publish_status,'pending');
  sql.exec('UPDATE bot_settings SET publishing=1');
  await runEntropiaPoll(env,fetcher,{now});await runEntropiaPoll(env,fetcher,{now});assert.equal(posts,1);
});
