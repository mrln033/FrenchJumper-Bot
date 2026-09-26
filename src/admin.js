import { ADMIN_HTML, ADMIN_JS } from './admin-ui.js';

const API = 'https://discord.com/api/v10';
const SESSION = '__Host-frj-session';
const STATE = '__Host-frj-state';
const idPattern = /^\d{15,22}$/;
const encoder = new TextEncoder();
const headers = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function reply(data, status = 200) { return Response.json(data, { status, headers }); }
function cookie(name, value, age) { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`; }
function cookies(request) { return Object.fromEntries((request.headers.get('cookie') || '').split(';').map(s => s.trim().split('='))); }
function random() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
async function hash(s) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s))), b => b.toString(16).padStart(2, '0')).join(''); }
function baseRoles(env) { return String(env.ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(s => idPattern.test(s)); }
async function roleIds(env) {
  const row = await env.DB.prepare('SELECT role_ids FROM admin_role_policy WHERE singleton=1').first();
  return [...new Set([...baseRoles(env), ...JSON.parse(row?.role_ids || '[]')])];
}
async function allowed(env, id, fetcher) {
  if (!idPattern.test(id || '')) return false;
  const [roles, member] = await Promise.all([roleIds(env), discord(`/guilds/${env.ADMIN_GUILD_ID}/members/${id}`, env, fetcher)]);
  return member.roles.some(r => roles.includes(r));
}
function configured(env) { return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.ADMIN_ORIGIN && baseRoles(env).length && String(env.ALLOWED_GUILD_IDS || '').split(',').map(s => s.trim()).includes(env.ADMIN_GUILD_ID)); }
function redirect(location, values = []) {
  const h = new Headers({ ...headers, location });
  for (const value of values) h.append('set-cookie', value);
  return new Response(null, { status: 302, headers: h });
}
async function stateSignature(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`frj-oauth:${value}`))), b => b.toString(16).padStart(2, '0')).join('');
}
async function equal(a, b) {
  const x = await hash(String(a)), y = await hash(String(b));
  let result = 0; for (let i = 0; i < x.length; i++) result |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return result === 0;
}
async function discord(path, env, fetcher, bearer) {
  const r = await fetcher(`${API}${path}`, { headers: { authorization: bearer ? `Bearer ${bearer}` : `Bot ${env.BOT_TOKEN}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Discord indisponible ou permissions insuffisantes.');
  return r.json();
}
export async function readBotSettings(env) {
  const row = await env.DB.prepare('SELECT channel_id, publishing, revision, updated_at FROM bot_settings WHERE singleton=1').first();
  return row || { channel_id: env.ENTROPIA_DISCORD_CHANNEL_ID || '', publishing: env.ENTROPIA_PUBLISH_ENABLED === 'true' ? 1 : 0, revision: 0, updated_at: null };
}
export async function settingsEnv(env) {
  const s = await readBotSettings(env);
  return { ...env, ENTROPIA_DISCORD_CHANNEL_ID: s.channel_id, ENTROPIA_PUBLISH_ENABLED: s.publishing ? 'true' : 'false' };
}
// Discord overwrites: everyone, combined roles, then member-specific.
export function canPublish(channel, guild, roles, member, botId) {
  if (channel.guild_id !== guild.id || ![0, 5].includes(channel.type)) return false;
  if (guild.owner_id === botId) return true;
  const owned = new Set([guild.id, ...member.roles]);
  let p = roles.filter(r => owned.has(r.id)).reduce((v, r) => v | BigInt(r.permissions), 0n);
  if (p & 8n) return true;
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find(o => o.id === guild.id);
  if (everyone) p = (p & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let deny = 0n, allow = 0n;
  for (const o of overwrites.filter(o => o.type === 0 && o.id !== guild.id && owned.has(o.id))) { deny |= BigInt(o.deny); allow |= BigInt(o.allow); }
  p = (p & ~deny) | allow;
  const personal = overwrites.find(o => o.type === 1 && o.id === botId);
  if (personal) p = (p & ~BigInt(personal.deny)) | BigInt(personal.allow);
  const needed = 1024n | 2048n | 16384n;
  return (p & needed) === needed;
}
async function availableChannels(env, fetcher) {
  const guildId = env.ADMIN_GUILD_ID;
  if (!String(env.ALLOWED_GUILD_IDS || '').split(',').map(s => s.trim()).includes(guildId)) throw new Error('Serveur non autorisé.');
  const bot = await discord('/users/@me', env, fetcher);
  const [guild, roles, member, channels] = await Promise.all([
    discord(`/guilds/${guildId}`, env, fetcher), discord(`/guilds/${guildId}/roles`, env, fetcher),
    discord(`/guilds/${guildId}/members/${bot.id}`, env, fetcher), discord(`/guilds/${guildId}/channels`, env, fetcher),
  ]);
  return channels.filter(c => canPublish({ ...c, guild_id: guildId }, guild, roles, member, bot.id)).map(c => ({ id: c.id, name: c.name }));
}
async function session(request, env, fetcher) {
  const token = cookies(request)[SESSION];
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  const row = await env.DB.prepare('SELECT user_id FROM admin_sessions WHERE token_hash=?1 AND expires_at>?2').bind(await hash(token), Date.now()).first();
  return row && await allowed(env, row.user_id, fetcher) ? row : null;
}
export async function handleAdmin(request, env, fetcher = fetch) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/admin')) return null;
  if (path === '/admin' && request.method === 'GET') return new Response(ADMIN_HTML, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
  if (path === '/admin/app.js' && request.method === 'GET') return new Response(ADMIN_JS, { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } });
  if (!configured(env)) return reply({ error: 'Connexion Discord non configurée. Contacte l’administrateur.' }, 503);
  if (url.origin !== env.ADMIN_ORIGIN) return reply({ error: 'Origine non autorisée.' }, 403);
  try {
    if (path === '/admin/login' && request.method === 'GET') {
      const state = `${random()}.${Date.now()}`;
      const signed = `${state}.${await stateSignature(state, env.DISCORD_CLIENT_SECRET)}`;
      const login = new URL('https://discord.com/oauth2/authorize');
      login.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify', redirect_uri: `${env.ADMIN_ORIGIN}/admin/callback`, state }).toString();
      return redirect(login.href, [cookie(STATE, signed, 600)]);
    }
    if (path === '/admin/callback' && request.method === 'GET') {
      const saved = cookies(request)[STATE] || '', parts = saved.split('.'), state = url.searchParams.get('state');
      if (parts.length !== 3 || !state || !await equal(state, `${parts[0]}.${parts[1]}`)
        || !await equal(parts[2], await stateSignature(state, env.DISCORD_CLIENT_SECRET))
        || !Number.isFinite(Number(parts[1])) || Date.now() - Number(parts[1]) > 600000 || Number(parts[1]) > Date.now()
        || !url.searchParams.get('code')) return reply({ error: 'Connexion expirée ou invalide. Recommence depuis /admin.' }, 400);
      const r = await fetcher('https://discord.com/api/oauth2/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${env.ADMIN_ORIGIN}/admin/callback` }),
      });
      if (!r.ok) return reply({ error: 'Autorisation Discord refusée. Recommence la connexion.' }, 401);
      const token = await r.json();
      if (typeof token.access_token !== 'string' || !token.access_token) return reply({ error: 'Réponse OAuth Discord invalide.' }, 502);
      const user = await discord('/users/@me', env, fetcher, token.access_token);
      if (!await allowed(env, user.id, fetcher)) return reply({ error: 'Ce compte Discord ne possède pas de rôle autorisé sur le serveur.' }, 403);
      const sid = random();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<=?1').bind(Date.now()),
        env.DB.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES(?1,?2,?3)').bind(await hash(sid), user.id, Date.now() + 3600000),
      ]);
      return redirect('/admin', [cookie(STATE, '', 0), cookie(SESSION, sid, 3600)]);
    }
    const user = await session(request, env, fetcher);
    if (!user) return reply({ error: 'Connexion requise.' }, 401);
    if (request.method !== 'GET' && (request.headers.get('origin') !== env.ADMIN_ORIGIN || request.headers.get('x-frj-admin') !== '1')) return reply({ error: 'Requête non autorisée.' }, 403);
    if (path === '/admin/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?1').bind(await hash(cookies(request)[SESSION])).run();
      return new Response('{}', { headers: { ...headers, 'content-type': 'application/json', 'set-cookie': cookie(SESSION, '', 0) } });
    }
    if (path === '/admin/api/status' && request.method === 'GET') {
      const [settings, state, members, recent] = await Promise.all([
        readBotSettings(env), env.DB.prepare('SELECT last_run_at,last_success_at,last_error,roster_refreshed_at FROM entropia_poll_state WHERE singleton=1').first(),
        env.DB.prepare('SELECT COUNT(*) AS total FROM entropia_active_members').first(),
        env.DB.prepare('SELECT avatar_name,value_ped,occurred_at,publish_status FROM entropia_polled_globals ORDER BY occurred_at DESC LIMIT 15').all(),
      ]);
      return reply({ settings, state, members: members.total, recent: recent.results, userId: user.user_id, polling: env.ENTROPIA_POLLING_ENABLED === 'true' });
    }
    if (path === '/admin/api/channels' && request.method === 'GET') return reply({ channels: await availableChannels(env, fetcher) });
    if (path === '/admin/api/roles' && request.method === 'GET') {
      const [roles, selected] = await Promise.all([discord(`/guilds/${env.ADMIN_GUILD_ID}/roles`, env, fetcher), roleIds(env)]);
      return reply({ roles: roles.filter(r => r.id !== env.ADMIN_GUILD_ID && !r.managed).map(r => ({ id: r.id, name: r.name })), selected, fixed: baseRoles(env) });
    }
    if (path === '/admin/api/refresh-members' && request.method === 'POST') {
      const result = await env.DB.prepare("UPDATE entropia_poll_state SET roster_refreshed_at=NULL WHERE singleton=1 AND (lease_until IS NULL OR lease_until<?1)").bind(new Date().toISOString()).run();
      if (!result.meta.changes) return reply({ error: 'Un cycle est en cours. Réessaie dans quelques secondes.' }, 409);
      console.log(JSON.stringify({ event: 'admin_refresh_members', userId: user.user_id }));
      return reply({ message: 'Actualisation demandée au prochain cycle (environ deux minutes).' });
    }
    if (['/admin/api/settings', '/admin/api/roles'].includes(path) && request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'JSON requis.' }, 415);
      const reader = request.body?.getReader(); let text = '', size = 0;
      if (!reader) return reply({ error: 'Corps requis.' }, 400);
      const decoder = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2048) { await reader.cancel(); return reply({ error: 'Corps trop volumineux.' }, 413); } text += decoder.decode(value, { stream: true }); }
      let body; try { body = JSON.parse(text + decoder.decode()); } catch { return reply({ error: 'JSON invalide.' }, 400); }
      if (path === '/admin/api/roles') {
        if (!Array.isArray(body?.role_ids) || body.role_ids.length > 20 || !body.role_ids.every(id => typeof id === 'string' && idPattern.test(id))) return reply({ error: 'Liste de rôles invalide (20 maximum).' }, 400);
        const available = await discord(`/guilds/${env.ADMIN_GUILD_ID}/roles`, env, fetcher);
        if (!body.role_ids.every(id => available.some(r => r.id === id && !r.managed && r.id !== env.ADMIN_GUILD_ID))) return reply({ error: 'Rôle inconnu ou non autorisable.' }, 400);
        const selected = [...new Set([...baseRoles(env), ...body.role_ids])];
        await env.DB.prepare('INSERT INTO admin_role_policy(singleton,role_ids,updated_by,updated_at) VALUES(1,?1,?2,?3) ON CONFLICT(singleton) DO UPDATE SET role_ids=excluded.role_ids,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(JSON.stringify(selected), user.user_id, new Date().toISOString()).run();
        console.log(JSON.stringify({ event: 'admin_roles', userId: user.user_id, roleIds: selected }));
        return reply({ message: 'Rôles autorisés enregistrés. Le rôle de secours reste autorisé.' });
      }
      if (!body || !idPattern.test(body.channel_id) || typeof body.publishing !== 'boolean' || !Number.isInteger(body.revision) || body.revision < 0) return reply({ error: 'Paramètres invalides.' }, 400);
      const channels = await availableChannels(env, fetcher);
      if (!channels.some(c => c.id === body.channel_id)) return reply({ error: 'Salon inaccessible : vérifier Voir le salon, Envoyer des messages et Intégrer des liens.' }, 400);
      const now = new Date().toISOString();
      const result = await env.DB.prepare(`INSERT INTO bot_settings(singleton,channel_id,publishing,revision,updated_by,updated_at)
        SELECT 1,?1,?2,1,?3,?4 WHERE ?5=0 AND NOT EXISTS(SELECT 1 FROM entropia_poll_state WHERE lease_until>?4)
        ON CONFLICT(singleton) DO UPDATE SET channel_id=?1,publishing=?2,revision=revision+1,updated_by=?3,updated_at=?4
        WHERE revision=?5 AND NOT EXISTS(SELECT 1 FROM entropia_poll_state WHERE lease_until>?4)`).bind(body.channel_id, Number(body.publishing), user.user_id, now, body.revision).run();
      // Existing rows need a separate optimistic UPDATE when revision > 0.
      let changed = result.meta.changes;
      if (!changed && body.revision > 0) {
        const update = await env.DB.prepare('UPDATE bot_settings SET channel_id=?1,publishing=?2,revision=revision+1,updated_by=?3,updated_at=?4 WHERE singleton=1 AND revision=?5 AND NOT EXISTS(SELECT 1 FROM entropia_poll_state WHERE lease_until>?4)').bind(body.channel_id, Number(body.publishing), user.user_id, now, body.revision).run();
        changed = update.meta.changes;
      }
      if (!changed) return reply({ error: 'Un cycle est en cours ou les réglages ont changé. Actualise et réessaie.' }, 409);
      console.log(JSON.stringify({ event: 'admin_settings', userId: user.user_id, channelId: body.channel_id, publishing: body.publishing }));
      return reply({ message: 'Réglages enregistrés. Application au prochain cycle.' });
    }
    return reply({ error: 'Route inconnue.' }, 404);
  } catch {
    console.error(JSON.stringify({ event: 'admin_error', path }));
    return reply({ error: 'Opération impossible. Vérifie la connexion Discord et les permissions du bot, puis réessaie.' }, 502);
  }
}
