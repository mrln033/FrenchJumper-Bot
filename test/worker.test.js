import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDiscordGlobalMessage,
  constantTimeTokenMatches,
  extractActiveMembers,
  handleRequest,
  normalizeAvatarName,
  runEntropiaPoll,
  signatureMatches,
  timestampIsFresh,
  validateSyncPayload,
} from "../src/index.js";

const guildId = "123456789012345678";
const userId = "223456789012345678";
const roleToAdd = "323456789012345678";
const roleToRemove = "423456789012345678";

test("health endpoint identifies the Cloudflare runtime", async () => {
  const response = await handleRequest(new Request("https://worker.test/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "frenchjumper-bot",
    runtime: "cloudflare-workers",
  });
});

test("sync requires authentication", async () => {
  const response = await handleRequest(new Request("https://worker.test/sync", {
    method: "POST",
    body: "{}",
  }), { BOT_TOKEN: "bot-token", SYNC_TOKEN: "sync-token" });
  assert.equal(response.status, 401);
});

test("protected Discord healthcheck validates the bot token without a mutation", async () => {
  const calls = [];
  const response = await handleRequest(new Request("https://worker.test/health/discord", {
    headers: { authorization: "Bearer sync-token" },
  }), {
    BOT_TOKEN: "bot-token",
    SYNC_TOKEN: "sync-token",
  }, async (url, init) => {
    calls.push({ url, method: init.method });
    return Response.json({ id: "523456789012345678", username: "FrenchJumper" });
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    bot: { id: "523456789012345678", username: "FrenchJumper" },
  });
  assert.deepEqual(calls, [{
    url: "https://discord.com/api/v10/users/@me",
    method: "GET",
  }]);
});

test("sync maps nickname and role changes to Discord REST calls", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    return new Response(null, { status: init.method === "PATCH" ? 200 : 204 });
  };
  const response = await handleRequest(new Request("https://worker.test/sync", {
    method: "POST",
    headers: {
      authorization: "Bearer sync-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      guildId,
      userId,
      newNick: "French Jumper",
      rolesToAdd: [roleToAdd],
      rolesToRemove: [roleToRemove],
    }),
  }), {
    BOT_TOKEN: "bot-token",
    SYNC_TOKEN: "sync-token",
    ALLOWED_GUILD_IDS: guildId,
  }, fetcher);

  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(({ method }) => method), ["PATCH", "PUT", "DELETE"]);
  assert.equal(JSON.parse(calls[0].body).nick, "French Jumper");
  assert.match(calls[1].url, new RegExp(`/roles/${roleToAdd}$`));
  assert.match(calls[2].url, new RegExp(`/roles/${roleToRemove}$`));
});

test("sync rejects a guild outside the allowlist", () => {
  assert.throws(
    () => validateSyncPayload({ guildId, userId }, new Set(["999999999999999999"])),
    /Guild is not allowed/,
  );
});

test("token comparison and timestamp validation are deterministic", async () => {
  assert.equal(await constantTimeTokenMatches("same", "same"), true);
  assert.equal(await constantTimeTokenMatches("wrong", "same"), false);
  assert.equal(timestampIsFresh("100", 100_000), true);
  assert.equal(timestampIsFresh("100", 401_000), false);
});

test("Entropia HMAC accepts the expected raw body", async () => {
  const timestamp = "1735689600";
  const body = new TextEncoder().encode('{"event":"test"}');
  const secret = "secret";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  const signature = `sha256=${[...signatureBytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;

  assert.equal(await signatureMatches(body.buffer, timestamp, signature, secret), true);
  assert.equal(await signatureMatches(body.buffer, timestamp, `sha256=${"0".repeat(64)}`, secret), false);
});

test("member roster keeps only active avatars and normalizes names", () => {
  const members = extractActiveMembers([
    { id: "one", nom: "  Enzo   Beau Goss  ", grade: "Chef", niveau: 6 },
    { id: "old", nom: "Ancien Joueur", grade: "Ancien Membre", niveau: 0 },
    { id: "duplicate", nom: "enzo beau goss", grade: "Chef", niveau: 6 },
  ]);

  assert.equal(normalizeAvatarName("  Éléonore   Test  "), "éléonore test");
  assert.equal(members.length, 1);
  assert.equal(members[0].normalizedName, "enzo beau goss");
  assert.equal(members[0].memberId, "duplicate");
});

test("Discord comparison message is safe and identifies the global", () => {
  const message = buildDiscordGlobalMessage({
    id: 30975817,
    avatarName: "French Jumper Member",
    globalValue: 1234.56,
    creatureName: "Atrox Old Alpha",
    landareaName: "Fort Ithaca",
    type: "Hunting",
    dateTime: "2026-09-25T16:21:26Z",
    isHof: true,
    isAth: false,
    detailRoute: "/wiki/creatures/atrox-old-alpha",
  });

  assert.match(message.content, /Comparaison automatique/);
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.match(message.embeds[0].title, /HOF.*French Jumper Member/);
  assert.match(message.embeds[0].fields[0].value, /1[\s\u202f]234,56 PED/);
  assert.match(message.embeds[0].footer.text, /30975817/);
});

test("Entropia polling stays inert while its feature flag is disabled", async () => {
  let fetched = false;
  const result = await runEntropiaPoll({ ENTROPIA_POLLING_ENABLED: "false" }, async () => {
    fetched = true;
    throw new Error("fetch should not be called");
  });

  assert.deepEqual(result, { outcome: "disabled" });
  assert.equal(fetched, false);
});
