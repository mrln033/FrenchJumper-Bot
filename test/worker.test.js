import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDiscordGlobalMessage,
  constantTimeTokenMatches,
  extractActiveMembers,
  handleRequest,
  normalizeAvatarName,
  matchesSocietyGlobal,
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

  assert.equal(message.content, undefined);
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.match(message.embeds[0].description, /HOF.*French Jumper Member/);
  assert.match(message.embeds[0].description, /\*\*1234\.56 PED\*\*/);
  assert.match(message.embeds[0].description, /https:\/\/www.entropiacentral.com\/wiki\/creatures\/atrox-old-alpha/);
  assert.equal(message.embeds[0].footer.text, "Source : entropiacentral.com");
  assert.equal(message.embeds[0].timestamp, "2026-09-25T16:21:26.000Z");
  const ath = buildDiscordGlobalMessage({ avatarName: "Test", type: "Mining", globalValue: 100000, isAth: true, isHof: true });
  assert.match(ath.embeds[0].description, /ATH ! RECORD ABSOLU !/);
  assert.equal(ath.embeds[0].color, 0x3498db);
});

test("Discord colors identify activity independently of Global, HoF or ATH", () => {
  const colors = { Hunting: 0xff5733, Mining: 0x3498db, Construction: 0xffb900,
    "Killing Spree": 0xc0392b, "New Items": 0x2ecc71, "Reached Item Tiers": 0x9b59b6,
    "Rare Items": 0xe84393, "Kill as Creature": 0xa66e3f, "Space Mining": 0x5865f2, Fishing: 0x1abc9c };
  assert.equal(new Set(Object.values(colors)).size, 10);
  for (const [type, color] of Object.entries({ ...colors, Unknown: 0x95a5a6 })) {
    for (const flags of [{}, { isHof: true }, { isHof: true, isAth: true }]) {
      const message = buildDiscordGlobalMessage({ avatarName: "Test", type, ...flags });
      assert.equal(message.embeds[0].color, color, `${type}: ${JSON.stringify(flags)}`);
      assert.equal(buildDiscordGlobalMessage({ type: ` ${type.toUpperCase()} `, ...flags }).embeds[0].color, color);
    }
  }
});

test("API category aliases share their display category colors", () => {
  for (const [type, category] of [["PvP", "Killing Spree"], ["Discovery", "New Items"], ["Tiered Item", "Reached Item Tiers"], ["Rare item", "Rare Items"]]) {
    assert.equal(buildDiscordGlobalMessage({ type }).embeds[0].color,
      buildDiscordGlobalMessage({ type: category }).embeds[0].color);
  }
});

test("Society team matching is case insensitive and independent of membership", () => {
  const members = new Set(["active member"]);
  for (const avatarName of ["Frenchjumper Hunt", "FRENCHJUMPER", "fReNcHjUmPeR", "Team FRJ", "frj", "SuperFrJTeam"]) {
    assert.equal(matchesSocietyGlobal({ id: 1, isTeam: true, avatarName }, members), true);
  }
  for (const avatarName of ["Other team", "active member", "", null]) {
    assert.equal(matchesSocietyGlobal({ id: 1, isTeam: true, avatarName }, members), false);
  }
  assert.equal(matchesSocietyGlobal({ id: 1, avatarName: "ACTIVE MEMBER" }, members), true);
  assert.equal(matchesSocietyGlobal({ id: 1, avatarName: "FRJ outsider" }, members), false);
  assert.equal(matchesSocietyGlobal({ isTeam: true, avatarName: "FRJ" }, members), false);
  assert.equal(matchesSocietyGlobal(null, members), false);
});

test("Team embeds identify teams without linking to an avatar profile", () => {
  const team = { avatarName: "FRJ Hunt", isTeam: true, type: "Hunting", dateTime: "2026-09-26T06:00:00Z" };
  const embed = buildDiscordGlobalMessage({ ...team, teamSlug: "frj-hunt" }).embeds[0];
  assert.match(embed.description, /👥 \[FRJ Hunt\]\(https:\/\/www.entropiacentral.com\/teams\/frj-hunt\)/);
  assert.equal(embed.color, 0xff5733);
  assert.equal(embed.timestamp, "2026-09-26T06:00:00.000Z");
  assert.equal(embed.footer.text, "Source : entropiacentral.com");
  assert.doesNotMatch(buildDiscordGlobalMessage(team).embeds[0].description, /\/avatars\//);
});

test("Footer contains only source and timestamp always comes from the entry", () => {
  for (const comparison of [true, false]) {
    const embed = buildDiscordGlobalMessage({ dateTime: "2020-01-02T14:30:00+02:00" }, comparison).embeds[0];
    assert.deepEqual(embed.footer, { text: "Source : entropiacentral.com" });
    assert.equal(embed.timestamp, "2020-01-02T12:30:00.000Z");
    for (const dateTime of [undefined, null, "", "invalid"]) {
      assert.equal(buildDiscordGlobalMessage({ dateTime }, comparison).embeds[0].timestamp, undefined);
    }
  }
});

test("French narration preserves source names across categories", () => {
  for (const [type, field, action] of [
    ["Hunting", "creatureName", "a tué un"], ["Mining", "depositName", "a trouvé un gisement de"],
    ["Construction", "craftedItemName", "a fabriqué un"], ["New Items", "discoveredItemName", "a découvert un"],
    ["Rare Items", "rareItemName", "a trouvé un objet rare :"], ["Reached Item Tiers", "tieredItemName", "a amélioré un"],
    ["Space Mining", "depositName", "a trouvé un gisement spatial sur"], ["Fishing", "creatureName", "a pêché un"],
    ["Kill as Creature", "creatureName", "a réalisé un global en tant que"],
  ]) {
    const embed = buildDiscordGlobalMessage({ avatarName: "MiXeD Avatar É", type, [field]: "Original English Name",
      landareaName: "Original Land", globalValue: 64, tieredItemTier: 3 }).embeds[0];
    assert.ok(embed.description.includes("MiXeD Avatar É"));
    assert.ok(embed.description.includes("Original English Name"));
    assert.ok(embed.description.includes("Original Land"));
    assert.ok(embed.description.includes(`${action} Original English Name`));
    assert.ok(embed.description.includes(type === "Reached Item Tiers" ? "au palier **3**" : "d’une valeur de **64 PED**"));
  }
  assert.match(buildDiscordGlobalMessage({ type: "Killing Spree", pvpSpree: 12 }).embeds[0].description, /12 éliminations en JcJ/);
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
