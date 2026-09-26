const DISCORD_API_BASE = "https://discord.com/api/v10";
const ENTROPIA_API_DEFAULT = "https://api.entropiacentral.com";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_EXTERNAL_JSON_BYTES = 1024 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const SNOWFLAKE_PATTERN = /^\d{15,22}$/;
const POLL_STATE_ID = 1;
const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_INITIAL_LOOKBACK_MINUTES = 10;
const DEFAULT_OVERLAP_SECONDS = 300;
const DEFAULT_ROSTER_REFRESH_MINUTES = 360;
const MAX_DISCORD_POSTS_PER_RUN = 15;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function encodeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function asSqlBoolean(value) {
  return typeof value === "boolean" ? Number(value) : null;
}

function envFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function integerSetting(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function truncate(value, maximum) {
  const text = String(value ?? "").trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

export function normalizeAvatarName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function extractActiveMembers(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("Members API response must be an array");
  }
  const members = new Map();
  for (const entry of payload) {
    const avatarName = typeof entry?.nom === "string" ? entry.nom.trim() : "";
    const normalizedName = normalizeAvatarName(avatarName);
    if (!normalizedName || Number(entry?.niveau) <= 0) continue;
    members.set(normalizedName, {
      normalizedName,
      avatarName,
      memberId: typeof entry.id === "string" ? entry.id : null,
      grade: typeof entry.grade === "string" ? entry.grade : null,
    });
  }
  return [...members.values()];
}

async function readLimitedJsonResponse(response, maximumBytes = MAX_EXTERNAL_JSON_BYTES) {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > maximumBytes) {
    throw new Error(`External response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) {
    throw new Error("External response has no body");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response too large");
      throw new Error(`External response exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("External response is not valid JSON");
  }
}

async function digestBytes(value) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export async function constantTimeTokenMatches(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string" || !expected) {
    return false;
  }
  const [left, right] = await Promise.all([
    digestBytes(supplied),
    digestBytes(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function isAuthorized(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  return constantTimeTokenMatches(authorization.slice(7), env.SYNC_TOKEN);
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function validateSnowflake(value, field) {
  if (typeof value !== "string" || !SNOWFLAKE_PATTERN.test(value)) {
    throw new HttpError(400, `${field} must be a Discord snowflake`);
  }
  return value;
}

function validateRoleList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, `${field} must be an array with at most 100 roles`);
  }
  return [...new Set(value.map((roleId) => validateSnowflake(roleId, field)))];
}

function validateSyncPayload(payload, allowedGuildIds) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Body must be an object");
  }
  const guildId = validateSnowflake(payload.guildId, "guildId");
  const userId = validateSnowflake(payload.userId, "userId");
  if (allowedGuildIds.size && !allowedGuildIds.has(guildId)) {
    throw new HttpError(403, "Guild is not allowed");
  }

  let newNick;
  if (Object.hasOwn(payload, "newNick")) {
    if (payload.newNick !== null && typeof payload.newNick !== "string") {
      throw new HttpError(400, "newNick must be a string or null");
    }
    if (typeof payload.newNick === "string" && payload.newNick.length > 32) {
      throw new HttpError(400, "newNick must contain at most 32 characters");
    }
    newNick = payload.newNick;
  }

  const rolesToAdd = validateRoleList(payload.rolesToAdd, "rolesToAdd");
  const rolesToRemove = validateRoleList(payload.rolesToRemove, "rolesToRemove");
  const overlap = rolesToAdd.find((roleId) => rolesToRemove.includes(roleId));
  if (overlap) throw new HttpError(400, "A role cannot be added and removed together");

  return { guildId, userId, newNick, rolesToAdd, rolesToRemove };
}

async function discordRequest(path, init, env, fetcher) {
  const response = await fetcher(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${env.BOT_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "DiscordBot (FrenchJumper Cloudflare Worker, 1.0)",
      ...(init.headers || {}),
    },
  });
  if (response.ok) return response;

  const details = (await response.text()).slice(0, 1_000);
  console.error(JSON.stringify({
    event: "discord_api_error",
    path,
    status: response.status,
    details,
  }));
  throw new HttpError(502, "Discord API request failed", { discordStatus: response.status });
}

async function syncMember(request, env, fetcher) {
  if (!env.BOT_TOKEN || !env.SYNC_TOKEN) {
    return json({ success: false, error: "Service is not configured" }, 503);
  }
  if (!(await isAuthorized(request, env))) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const payload = await readJsonBody(request);
  const allowedGuildIds = new Set(
    String(env.ALLOWED_GUILD_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const operation = validateSyncPayload(payload, allowedGuildIds);
  const memberPath = `/guilds/${operation.guildId}/members/${operation.userId}`;

  if (operation.newNick !== undefined) {
    await discordRequest(memberPath, {
      method: "PATCH",
      body: JSON.stringify({ nick: operation.newNick }),
    }, env, fetcher);
  }
  for (const roleId of operation.rolesToAdd) {
    await discordRequest(`${memberPath}/roles/${roleId}`, { method: "PUT" }, env, fetcher);
  }
  for (const roleId of operation.rolesToRemove) {
    await discordRequest(`${memberPath}/roles/${roleId}`, { method: "DELETE" }, env, fetcher);
  }

  console.log(JSON.stringify({
    event: "member_sync",
    outcome: "success",
    guildId: operation.guildId,
    userId: operation.userId,
    rolesAdded: operation.rolesToAdd.length,
    rolesRemoved: operation.rolesToRemove.length,
    nicknameChanged: operation.newNick !== undefined,
  }));
  return json({ success: true });
}

async function checkDiscord(request, env, fetcher) {
  if (!env.BOT_TOKEN || !env.SYNC_TOKEN) {
    return json({ success: false, error: "Service is not configured" }, 503);
  }
  if (!(await isAuthorized(request, env))) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }
  const response = await discordRequest("/users/@me", { method: "GET" }, env, fetcher);
  const bot = await response.json();
  return json({
    success: true,
    bot: {
      id: bot.id,
      username: bot.username,
    },
  });
}

function entropiaDetail(global) {
  const value = Number(global.globalValue);
  const valueLabel = Number.isFinite(value) ? `${value.toLocaleString("fr-FR")} PED` : null;
  const type = String(global.type || "Global");
  let subject = "";
  if (type === "Hunting") subject = global.creatureName || "créature inconnue";
  else if (type === "Mining" || type === "Space Mining") subject = global.depositName || "ressource inconnue";
  else if (type === "Construction") subject = global.craftedItemName || "objet inconnu";
  else if (type === "Discovery") subject = global.discoveredItemName || "découverte inconnue";
  else if (type === "Rare Item") subject = global.rareItemName || "objet rare inconnu";
  else if (type === "Tiered Item") {
    const tier = Number(global.tieredItemTier);
    subject = `${global.tieredItemName || "objet"}${tier > 0 ? ` — tier ${tier}` : ""}`;
  } else if (type === "PvP") {
    const spree = Number(global.pvpSpree);
    subject = spree > 0 ? `${spree} élimination${spree > 1 ? "s" : ""}` : "action PvP";
  }
  return [type, subject, valueLabel].filter(Boolean).join(" • ");
}

function messageLabel(value) {
  return truncate(value, 200).replace(/[\\`*_{}\[\]()<>]/g, "\\$&");
}

function ecLink(label, route) {
  const text = messageLabel(label);
  if (typeof route !== "string" || !/^\/(avatars|teams|wiki|landareas)\//.test(route)) return text;
  const url = new URL(route, "https://www.entropiacentral.com");
  return `[${text}](${url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

const GLOBAL_CATEGORIES = new Map([
  ["hunting", ["Hunting", 0xff5733]],
  ["mining", ["Mining", 0x3498db]],
  ["construction", ["Construction", 0xffb900]],
  ["killing spree", ["PvP", 0xc0392b]],
  ["new items", ["Discovery", 0x2ecc71]],
  ["reached item tiers", ["Tiered Item", 0x9b59b6]],
  ["rare items", ["Rare Item", 0xe84393]],
  ["kill as creature", ["Kill as Creature", 0xa66e3f]],
  ["space mining", ["Space Mining", 0x5865f2]],
  ["fishing", ["Fishing", 0x1abc9c]],
]);
const GLOBAL_CATEGORY_ALIASES = new Map([
  ["pvp", "killing spree"], ["discovery", "new items"],
  ["tiered item", "reached item tiers"], ["rare item", "rare items"],
]);

export function buildDiscordGlobalMessage(global, comparisonMode = true) {
  const categoryKey = String(global.type || "").trim().toLowerCase();
  const [type, color] = GLOBAL_CATEGORIES.get(GLOBAL_CATEGORY_ALIASES.get(categoryKey) || categoryKey)
    || [global.type, 0x95a5a6];
  const avatarName = truncate(global.avatarName || "Avatar inconnu", 200);
  const prefix = global.isAth ? "🏆 **ATH ! RECORD ABSOLU !** 🏆\n" : global.isHof ? "⭐ **HOF !** " : "";
  const occurredAt = new Date(global.dateTime ?? NaN);
  const slug = (name) => encodeURIComponent(String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const avatar = global.isTeam
    ? `👥 ${global.teamSlug ? ecLink(avatarName, `/teams/${global.teamSlug}`) : messageLabel(avatarName)}`
    : ecLink(avatarName, `/avatars/${global.avatarSlug || slug(avatarName)}`);
  const subject = global.creatureName || global.depositName || global.craftedItemName
    || global.discoveredItemName || global.rareItemName || global.tieredItemName || "objet non précisé";
  const target = ecLink(subject, global.detailRoute);
  const actions = { Hunting: "a tué un", Mining: "a trouvé un gisement de", "Space Mining": "a trouvé un gisement spatial sur",
    Construction: "a fabriqué", Discovery: "a découvert un", "Rare Item": "a trouvé un objet rare :",
    "Tiered Item": "a amélioré", Fishing: "a pêché", "Kill as Creature": "a réalisé un global en tant que créature sur" };
  const value = Number(global.globalValue);
  let sentence = `${avatar} ${actions[type] || "a réalisé un global sur"} ${target}`;
  if (type === "PvP") sentence = `${avatar} a réalisé une série de **${Number(global.pvpSpree) || 0} éliminations en JcJ**`;
  else if (type === "Tiered Item") sentence += ` au palier **${Number(global.tieredItemTier) || 0}**`;
  else if (global.globalValue != null && Number.isFinite(value)) sentence += ` d’une valeur de **${value} PED**`;
  sentence += " !";
  if (global.landareaName) sentence += ` — Lieu : ${ecLink(global.landareaName, `/landareas/${slug(global.landareaName)}`)}`;

  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      description: `${prefix}${sentence}`,
      color,
      footer: { text: "Source : entropiacentral.com" },
      timestamp: Number.isNaN(occurredAt.getTime()) ? undefined : occurredAt.toISOString(),
    }],
  };
}

async function getPollState(env) {
  return env.DB.prepare(`
    SELECT cursor_at, roster_refreshed_at, lease_until,
           last_run_at, last_success_at, last_error, last_stats
    FROM entropia_poll_state
    WHERE singleton = ?1
  `).bind(POLL_STATE_ID).first();
}

async function acquirePollLease(env, now) {
  const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
  const result = await env.DB.prepare(`
    UPDATE entropia_poll_state
    SET lease_until = ?1, last_run_at = ?2
    WHERE singleton = ?3
      AND (lease_until IS NULL OR lease_until < ?2)
  `).bind(leaseUntil, now.toISOString(), POLL_STATE_ID).run();
  return result.meta.changes === 1;
}

async function releasePollLease(env) {
  await env.DB.prepare(
    "UPDATE entropia_poll_state SET lease_until = NULL WHERE singleton = ?1",
  ).bind(POLL_STATE_ID).run();
}

async function refreshMemberRoster(env, fetcher, now, force = false) {
  const state = await getPollState(env);
  const refreshMinutes = integerSetting(
    env.ENTROPIA_ROSTER_REFRESH_MINUTES,
    DEFAULT_ROSTER_REFRESH_MINUTES,
    15,
    1440,
  );
  const refreshedAt = state?.roster_refreshed_at
    ? new Date(state.roster_refreshed_at).getTime()
    : Number.NaN;
  if (!force && Number.isFinite(refreshedAt)
      && now.getTime() - refreshedAt < refreshMinutes * 60_000) {
    return { refreshed: false };
  }
  if (!env.MEMBERS_API_URL) throw new Error("MEMBERS_API_URL is not configured");

  const response = await fetcher(env.MEMBERS_API_URL, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Members API returned HTTP ${response.status}`);
  const members = extractActiveMembers(await readLimitedJsonResponse(response));
  if (members.length === 0) {
    throw new Error("Members API returned no active member; roster was not replaced");
  }

  const syncToken = now.toISOString();
  for (let offset = 0; offset < members.length; offset += 50) {
    const statements = members.slice(offset, offset + 50).map((member) => env.DB.prepare(`
      INSERT INTO entropia_active_members (
        normalized_name, avatar_name, member_id, grade, sync_token, synced_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(normalized_name) DO UPDATE SET
        avatar_name = excluded.avatar_name,
        member_id = excluded.member_id,
        grade = excluded.grade,
        sync_token = excluded.sync_token,
        synced_at = excluded.synced_at
    `).bind(
      member.normalizedName,
      member.avatarName,
      member.memberId,
      member.grade,
      syncToken,
    ));
    await env.DB.batch(statements);
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM entropia_active_members WHERE sync_token <> ?1",
    ).bind(syncToken),
    env.DB.prepare(`
      UPDATE entropia_poll_state
      SET roster_refreshed_at = ?1
      WHERE singleton = ?2
    `).bind(syncToken, POLL_STATE_ID),
  ]);
  return { refreshed: true, memberCount: members.length };
}

async function loadActiveMemberNames(env) {
  const result = await env.DB.prepare(
    "SELECT normalized_name FROM entropia_active_members",
  ).all();
  return new Set((result.results || []).map((row) => row.normalized_name));
}

async function fetchEntropiaGlobals(env, fetcher, fromDate, toDate) {
  const apiBase = String(env.ENTROPIA_API_BASE_URL || ENTROPIA_API_DEFAULT).replace(/\/$/, "");
  const pageSize = integerSetting(env.ENTROPIA_PAGE_SIZE, DEFAULT_PAGE_SIZE, 1, 30);
  const maxPages = integerSetting(env.ENTROPIA_MAX_PAGES, DEFAULT_MAX_PAGES, 1, 20);
  const globals = [];
  let truncated = false;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = new URL(`${apiBase}/globals`);
    url.searchParams.set("fromDate", fromDate.toISOString());
    url.searchParams.set("toDate", toDate.toISOString());
    url.searchParams.set("sortBy", "DateTime");
    url.searchParams.set("sortOrder", "asc");
    url.searchParams.set("pageNumber", String(pageNumber));
    url.searchParams.set("pageSize", String(pageSize));
    const response = await fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Entropia Central API returned HTTP ${response.status}`);
    const payload = await readLimitedJsonResponse(response);
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error("Entropia Central API returned an invalid page");
    }
    globals.push(...payload.items);
    if (payload.items.length < pageSize) break;
    if (pageNumber === maxPages) truncated = true;
  }
  return { globals, truncated, pageSize, maxPages };
}

export function matchesSocietyGlobal(global, activeMemberNames) {
  if (!Number.isInteger(global?.id)) return false;
  if (global.isTeam) return /frenchjumper|frj/i.test(String(global.avatarName || ""));
  return activeMemberNames.has(normalizeAvatarName(global.avatarName));
}

async function storeMatchedGlobals(env, globals, activeMemberNames, publishEnabled, now) {
  const matches = globals.filter((global) => matchesSocietyGlobal(global, activeMemberNames));
  let inserted = 0;
  for (let offset = 0; offset < matches.length; offset += 50) {
    const statements = matches.slice(offset, offset + 50).map((global) => env.DB.prepare(`
      INSERT OR IGNORE INTO entropia_polled_globals (
        global_id, avatar_name, global_type, value_ped, occurred_at,
        is_hof, is_ath, is_team, detail_route, payload,
        publish_status, detected_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
      )
    `).bind(
      global.id,
      global.avatarName || null,
      global.type || null,
      Number.isFinite(Number(global.globalValue)) ? Number(global.globalValue) : null,
      global.dateTime || null,
      asSqlBoolean(Boolean(global.isHof)),
      asSqlBoolean(Boolean(global.isAth)),
      asSqlBoolean(Boolean(global.isTeam)),
      global.detailRoute || null,
      JSON.stringify(global),
      publishEnabled ? "pending" : "observed",
      now.toISOString(),
    ));
    const results = await env.DB.batch(statements);
    inserted += results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0);
  }
  return { matched: matches.length, inserted };
}

async function publishPendingGlobals(env, fetcher, now) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is not configured");
  const channelId = validateSnowflake(env.ENTROPIA_DISCORD_CHANNEL_ID, "ENTROPIA_DISCORD_CHANNEL_ID");
  const result = await env.DB.prepare(`
    SELECT global_id, payload, publish_attempts
    FROM entropia_polled_globals
    WHERE publish_status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
    ORDER BY occurred_at, global_id
    LIMIT ?2
  `).bind(now.toISOString(), MAX_DISCORD_POSTS_PER_RUN).all();

  let published = 0;
  let failed = 0;
  for (const row of result.results || []) {
    try {
      const global = JSON.parse(row.payload);
      const response = await discordRequest(`/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify(buildDiscordGlobalMessage(global, true)),
      }, env, fetcher);
      const message = await response.json();
      await env.DB.prepare(`
        UPDATE entropia_polled_globals
        SET publish_status = 'published', discord_channel_id = ?1,
            discord_message_id = ?2, published_at = ?3,
            last_error = NULL, next_attempt_at = NULL
        WHERE global_id = ?4
      `).bind(channelId, message.id || null, now.toISOString(), row.global_id).run();
      published += 1;
    } catch (error) {
      const attempts = Number(row.publish_attempts || 0) + 1;
      const retryMinutes = Math.min(60, 2 ** attempts);
      const nextAttemptAt = new Date(now.getTime() + retryMinutes * 60_000).toISOString();
      await env.DB.prepare(`
        UPDATE entropia_polled_globals
        SET publish_attempts = ?1,
            publish_status = ?2,
            last_error = ?3,
            next_attempt_at = ?4
        WHERE global_id = ?5
      `).bind(
        attempts,
        attempts >= 5 ? "failed" : "pending",
        truncate(error instanceof Error ? error.message : String(error), 1000),
        attempts >= 5 ? null : nextAttemptAt,
        row.global_id,
      ).run();
      failed += 1;
    }
  }
  return { published, failed };
}

export async function runEntropiaPoll(env, fetcher = fetch, options = {}) {
  if (!envFlag(env.ENTROPIA_POLLING_ENABLED) && !options.force) {
    return { outcome: "disabled" };
  }
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  const now = options.now instanceof Date ? options.now : new Date();
  if (!(await acquirePollLease(env, now))) return { outcome: "locked" };

  try {
    const roster = await refreshMemberRoster(env, fetcher, now, Boolean(options.refreshRoster));
    const activeMemberNames = await loadActiveMemberNames(env);
    if (activeMemberNames.size === 0) throw new Error("Active member roster is empty");

    const state = await getPollState(env);
    const initialLookbackMinutes = integerSetting(
      env.ENTROPIA_INITIAL_LOOKBACK_MINUTES,
      DEFAULT_INITIAL_LOOKBACK_MINUTES,
      1,
      1440,
    );
    const overlapSeconds = integerSetting(
      env.ENTROPIA_OVERLAP_SECONDS,
      DEFAULT_OVERLAP_SECONDS,
      0,
      3600,
    );
    const savedCursor = state?.cursor_at ? new Date(state.cursor_at) : null;
    const cursorIsValid = savedCursor && !Number.isNaN(savedCursor.getTime());
    const fromDate = cursorIsValid
      ? new Date(savedCursor.getTime() - overlapSeconds * 1000)
      : new Date(now.getTime() - initialLookbackMinutes * 60_000);
    const fetched = await fetchEntropiaGlobals(env, fetcher, fromDate, now);
    const publishEnabled = envFlag(env.ENTROPIA_PUBLISH_ENABLED)
      && Boolean(env.ENTROPIA_DISCORD_CHANNEL_ID);
    const stored = await storeMatchedGlobals(
      env,
      fetched.globals,
      activeMemberNames,
      publishEnabled,
      now,
    );
    const publication = publishEnabled
      ? await publishPendingGlobals(env, fetcher, now)
      : { published: 0, failed: 0 };

    let nextCursor = now;
    if (fetched.truncated && fetched.globals.length) {
      const lastDate = new Date(fetched.globals.at(-1).dateTime);
      if (!Number.isNaN(lastDate.getTime())) nextCursor = lastDate;
    }
    const stats = {
      outcome: "success",
      rosterRefreshed: roster.refreshed,
      activeMembers: activeMemberNames.size,
      fetched: fetched.globals.length,
      matched: stored.matched,
      inserted: stored.inserted,
      published: publication.published,
      publishFailed: publication.failed,
      truncated: fetched.truncated,
      comparisonMode: true,
    };
    await env.DB.prepare(`
      UPDATE entropia_poll_state
      SET cursor_at = ?1, last_success_at = ?2,
          last_error = NULL, last_stats = ?3
      WHERE singleton = ?4
    `).bind(nextCursor.toISOString(), now.toISOString(), JSON.stringify(stats), POLL_STATE_ID).run();
    console.log(JSON.stringify({ event: "entropia_poll", ...stats }));
    return stats;
  } catch (error) {
    const message = truncate(error instanceof Error ? error.message : String(error), 1000);
    await env.DB.prepare(`
      UPDATE entropia_poll_state
      SET last_error = ?1
      WHERE singleton = ?2
    `).bind(message, POLL_STATE_ID).run();
    console.error(JSON.stringify({ event: "entropia_poll", outcome: "error", error: message }));
    throw error;
  } finally {
    await releasePollLease(env);
  }
}

async function entropiaStatus(request, env) {
  if (!env.SYNC_TOKEN || !(await isAuthorized(request, env))) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }
  const [state, counts] = await Promise.all([
    getPollState(env),
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM entropia_active_members) AS active_members,
        (SELECT COUNT(*) FROM entropia_polled_globals) AS detected_globals,
        (SELECT COUNT(*) FROM entropia_polled_globals WHERE publish_status = 'published') AS published_globals,
        (SELECT COUNT(*) FROM entropia_polled_globals WHERE publish_status = 'pending') AS pending_globals,
        (SELECT COUNT(*) FROM entropia_polled_globals WHERE publish_status = 'failed') AS failed_globals
    `).first(),
  ]);
  return json({
    success: true,
    configured: {
      polling: envFlag(env.ENTROPIA_POLLING_ENABLED),
      publishing: envFlag(env.ENTROPIA_PUBLISH_ENABLED),
      channel: Boolean(env.ENTROPIA_DISCORD_CHANNEL_ID),
      membersApi: Boolean(env.MEMBERS_API_URL),
    },
    state,
    counts,
  });
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

async function signatureMatches(rawBody, timestamp, signature, secret) {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const supplied = hexToBytes(signature.slice(7));
  if (!supplied) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + rawBody.byteLength);
  signed.set(prefix);
  signed.set(new Uint8Array(rawBody), prefix.length);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ supplied[index];
  }
  return difference === 0;
}

function timestampIsFresh(timestamp, nowMs = Date.now()) {
  if (!/^\d+(?:\.\d+)?$/.test(timestamp || "")) return false;
  const timestampSeconds = Number(timestamp);
  return Number.isFinite(timestampSeconds)
    && Math.abs(nowMs / 1000 - timestampSeconds) <= MAX_TIMESTAMP_SKEW_SECONDS;
}

async function storeEntropiaDelivery(env, deliveryId, payload) {
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO entropia_central_deliveries (delivery_id) VALUES (?1)",
  ).bind(deliveryId).run();
  if (claim.meta.changes === 0) return "duplicate";

  const data = payload.data || {};
  try {
    await env.DB.prepare(`
      INSERT INTO entropia_central_globals (
        delivery_id, event_name, sent_at, trigger_data, message,
        global_id, global_type, value_ped, is_hof, is_ath, is_team,
        occurred_at, society_name, avatar, creature, deposit,
        landarea, item, tier, payload
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
      )
    `).bind(
      deliveryId,
      payload.event,
      payload.sentAt || null,
      encodeJson(payload.trigger),
      payload.message || null,
      data.id ?? null,
      data.type || null,
      data.value ?? null,
      asSqlBoolean(data.isHof),
      asSqlBoolean(data.isAth),
      asSqlBoolean(data.isTeam),
      data.occurredAt || null,
      data.societyName || null,
      encodeJson(data.avatar),
      encodeJson(data.creature),
      encodeJson(data.deposit),
      encodeJson(data.landarea),
      encodeJson(data.item),
      data.tier ?? null,
      JSON.stringify(payload),
    ).run();
    return "stored";
  } catch (error) {
    await env.DB.prepare(
      "DELETE FROM entropia_central_deliveries WHERE delivery_id = ?1",
    ).bind(deliveryId).run();
    throw error;
  }
}

async function receiveEntropiaWebhook(request, env) {
  if (!env.ENTROPIA_CENTRAL_SIGNING_SECRET || !env.DB) {
    return json({ success: false, error: "Service is not configured" }, 503);
  }
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > 1024 * 1024) {
    return json({ success: false, error: "Request body too large" }, 413);
  }
  const timestamp = request.headers.get("x-ec-timestamp") || "";
  const signature = request.headers.get("x-ec-signature") || "";
  const deliveryId = request.headers.get("x-ec-delivery") || "";
  if (!(await signatureMatches(rawBody, timestamp, signature, env.ENTROPIA_CENTRAL_SIGNING_SECRET))) {
    return json({ success: false, error: "Invalid signature" }, 401);
  }
  if (!timestampIsFresh(timestamp)) {
    return json({ success: false, error: "Stale timestamp" }, 401);
  }
  if (!deliveryId || deliveryId.length > 200) {
    return json({ success: false, error: "Invalid delivery id" }, 400);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (!payload || payload.deliveryId !== deliveryId || typeof payload.event !== "string") {
    return json({ success: false, error: "Delivery id or event mismatch" }, 400);
  }

  const outcome = await storeEntropiaDelivery(env, deliveryId, payload);
  console.log(JSON.stringify({
    event: "entropia_central_webhook",
    deliveryId,
    eventName: payload.event,
    outcome,
  }));
  return json({ success: true, duplicate: outcome === "duplicate" });
}

export async function handleRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "frenchjumper-bot", runtime: "cloudflare-workers" });
    }
    if (request.method === "GET" && url.pathname === "/health/discord") {
      return await checkDiscord(request, env, fetcher);
    }
    if (request.method === "GET" && url.pathname === "/health/entropia") {
      return await entropiaStatus(request, env);
    }
    if (request.method === "POST" && url.pathname === "/sync") {
      return await syncMember(request, env, fetcher);
    }
    if (request.method === "POST" && url.pathname === "/admin/entropia/poll") {
      if (!env.SYNC_TOKEN || !(await isAuthorized(request, env))) {
        return json({ success: false, error: "Unauthorized" }, 401);
      }
      const stats = await runEntropiaPoll(env, fetcher, {
        force: true,
        refreshRoster: url.searchParams.get("refreshRoster") === "true",
      });
      return json({ success: true, stats });
    }
    if (request.method === "POST" && url.pathname === "/webhooks/entropia-central") {
      return await receiveEntropiaWebhook(request, env);
    }
    return json({ success: false, error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ success: false, error: error.message, details: error.details }, error.status);
    }
    console.error(JSON.stringify({
      event: "unhandled_error",
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ success: false, error: "Internal server error" }, 500);
  }
}

export { signatureMatches, timestampIsFresh, validateSyncPayload };

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runEntropiaPoll(env).catch((error) => {
      console.error(JSON.stringify({
        event: "entropia_scheduled_error",
        cron: controller.cron,
        error: error instanceof Error ? error.message : String(error),
      }));
    }));
  },
};
