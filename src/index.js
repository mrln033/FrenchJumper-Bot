const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const SNOWFLAKE_PATTERN = /^\d{15,22}$/;

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
    if (request.method === "POST" && url.pathname === "/sync") {
      return await syncMember(request, env, fetcher);
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
};
