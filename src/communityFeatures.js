const MAX_AUDIT_LOG = 120;
const MAX_ARTIFACTS = 80;
const MAX_CASES = 400;

export const DEFAULT_ARTIFACTS = [
  {
    id: "artifact-keeper-ledger",
    name: "Keeper Ledger",
    rarity: "Sacred",
    keeper: "Round Table",
    summary: "A running record of who guarded the artifact and who definitely blamed the wrong crumb."
  },
  {
    id: "horn-polish-codex",
    name: "Horn Polish Codex",
    rarity: "Rare",
    keeper: "Artifact Keeper",
    summary: "A ceremonial guide to keeping the suit sharp while pretending everything is under control."
  },
  {
    id: "bread-omen-stone",
    name: "Bread Omen Stone",
    rarity: "Unstable",
    keeper: "The Bakery Vault",
    summary: "Used to determine whether a loaf is ordinary or the start of a prophecy."
  }
];

export const SHOP_ITEMS = [
  { id: "chalk-horns", name: "Chalk Horns", cost: 120, description: "Adds a soft ceremonial flair to your profile.", type: "cosmetic" },
  { id: "bread-seal", name: "Bread Seal", cost: 160, description: "A stamped seal proving you once survived the bakery rites.", type: "badge" },
  { id: "white-fur-maintenance-kit", name: "White Fur Maintenance Kit", cost: 220, description: "Important if you enjoy dignity and lint control.", type: "utility" },
  { id: "ominous-candle-pack", name: "Ominous Candle Pack", cost: 260, description: "Four candles. All of them judgmental.", type: "utility" },
  { id: "round-table-pass", name: "Round Table Pass", cost: 340, description: "Not legally binding, but spiritually impressive.", type: "title", title: "Round Table Aspirant" },
  { id: "artifact-dust", name: "Artifact Dust", cost: 420, description: "Probably harmless. Definitely important.", type: "collectible" },
  { id: "ceremony-snack-bundle", name: "Ceremony Snack Bundle", cost: 540, description: "Snacks for rituals that run a little long.", type: "consumable" },
  { id: "doom-bell", name: "Doom Bell", cost: 760, description: "Rings once. Everyone gets nervous.", type: "collectible" }
];

export const COMMUNITY_DEFAULTS = {
  profiles: {},
  profileEdits: {},
  artifacts: DEFAULT_ARTIFACTS,
  auditLog: [],
  cases: [],
  analytics: {
    commands: {},
    totals: {
      commandsRun: 0,
      aiReplies: 0,
      applicationsOpened: 0,
      applicationsApproved: 0,
      applicationsDenied: 0,
      moderationActions: 0,
      casesOpened: 0,
      vouches: 0,
      artifactsRegistered: 0,
      shopPurchases: 0
    }
  },
  rituals: {
    currentEvent: "The artifact is humming softly and judging the bread economy.",
    seasonalMessage: "Current season: ceremonial optimism.",
    nextTrial: ""
  },
  questClaims: {},
  staffNotes: {}
};

function clone(value) {
  return structuredClone(value);
}

function mergeTotals(totals = {}) {
  return {
    ...clone(COMMUNITY_DEFAULTS.analytics.totals),
    ...(totals || {})
  };
}

export function communityState(config = {}) {
  const community = config.community || {};
  return {
    ...clone(COMMUNITY_DEFAULTS),
    ...community,
    profiles: { ...(community.profiles || {}) },
    profileEdits: { ...(community.profileEdits || {}) },
    artifacts: normalizeArtifacts(community.artifacts),
    auditLog: Array.isArray(community.auditLog) ? community.auditLog.slice(-MAX_AUDIT_LOG) : [],
    cases: normalizeCases(community.cases),
    analytics: {
      commands: { ...(community.analytics?.commands || {}) },
      totals: mergeTotals(community.analytics?.totals)
    },
    rituals: {
      ...clone(COMMUNITY_DEFAULTS.rituals),
      ...(community.rituals || {})
    },
    questClaims: { ...(community.questClaims || {}) },
    staffNotes: { ...(community.staffNotes || {}) }
  };
}

export function normalizeArtifacts(artifacts = []) {
  const source = Array.isArray(artifacts) && artifacts.length ? artifacts : DEFAULT_ARTIFACTS;
  return source
    .map((artifact, index) => ({
      id: String(artifact.id || `${String(artifact.name || "artifact").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`),
      name: String(artifact.name || "").trim().slice(0, 80),
      rarity: String(artifact.rarity || "Unknown").trim().slice(0, 40),
      keeper: String(artifact.keeper || "Unassigned").trim().slice(0, 80),
      summary: String(artifact.summary || "").trim().slice(0, 260)
    }))
    .filter((artifact) => artifact.name)
    .slice(0, MAX_ARTIFACTS);
}

export function normalizeCases(cases = []) {
  return (Array.isArray(cases) ? cases : [])
    .map((entry, index) => ({
      id: Math.max(Math.floor(Number(entry.id) || 0), index + 1),
      action: String(entry.action || "note").slice(0, 40),
      targetId: String(entry.targetId || ""),
      targetTag: String(entry.targetTag || "").slice(0, 80),
      moderatorId: String(entry.moderatorId || ""),
      moderatorTag: String(entry.moderatorTag || "").slice(0, 80),
      reason: String(entry.reason || "").slice(0, 260),
      status: String(entry.status || "open").slice(0, 20),
      durationMs: Math.max(Math.floor(Number(entry.durationMs) || 0), 0),
      createdAt: String(entry.createdAt || ""),
      updates: Array.isArray(entry.updates)
        ? entry.updates.map((update) => ({
            authorTag: String(update.authorTag || "").slice(0, 80),
            note: String(update.note || "").slice(0, 200),
            createdAt: String(update.createdAt || "")
          })).slice(0, 20)
        : []
    }))
    .filter((entry) => entry.id && entry.targetId)
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_CASES);
}

function normalizeInventory(inventory = {}) {
  return Object.fromEntries(
    Object.entries(inventory || {})
      .map(([itemId, amount]) => [String(itemId), Math.max(Math.floor(Number(amount) || 0), 0)])
      .filter(([, amount]) => amount > 0)
  );
}

export function profileFor(config = {}, userId, fallbackName = "") {
  const community = communityState(config);
  const stored = community.profiles?.[userId] || {};
  return {
    displayName: String(stored.displayName || fallbackName || "Unknown Chipkittle").slice(0, 80),
    title: String(stored.title || "Bread Initiate").slice(0, 80),
    bio: String(stored.bio || "No ceremonial biography has been recorded yet.").slice(0, 260),
    badges: Array.isArray(stored.badges) ? stored.badges.map((badge) => String(badge).slice(0, 40)).filter(Boolean).slice(0, 16) : [],
    manualAchievements: Array.isArray(stored.manualAchievements) ? stored.manualAchievements.map((badge) => String(badge).slice(0, 60)).filter(Boolean).slice(0, 20) : [],
    artifacts: Array.isArray(stored.artifacts) ? stored.artifacts.map((item) => String(item).slice(0, 80)).filter(Boolean).slice(0, 20) : [],
    inventory: normalizeInventory(stored.inventory),
    pronouns: String(stored.pronouns || "").slice(0, 40),
    favoriteArtifact: String(stored.favoriteArtifact || "").slice(0, 80),
    quote: String(stored.quote || "").slice(0, 140),
    publicVisible: Boolean(stored.publicVisible),
    approvedRoleIds: Array.isArray(stored.approvedRoleIds) ? stored.approvedRoleIds.map((roleId) => String(roleId)).filter(Boolean).slice(0, 50) : [],
    vouches: Array.isArray(stored.vouches) ? stored.vouches.map((entry) => ({
      from: String(entry.from || ""),
      name: String(entry.name || "").slice(0, 80),
      reason: String(entry.reason || "").slice(0, 160),
      createdAt: String(entry.createdAt || "")
    })).filter((entry) => entry.from) : [],
    reputation: Math.max(Math.floor(Number(stored.reputation) || 0), 0),
    lastUpdatedAt: String(stored.lastUpdatedAt || "")
  };
}

export function derivedAchievements(config = {}, userId, fallbackName = "") {
  const profile = profileFor(config, userId, fallbackName);
  const balance = Math.max(Math.floor(Number(config.economy?.balances?.[userId]) || 0), 0);
  const bank = Math.max(Math.floor(Number(config.economy?.bankBalances?.[userId]) || 0), 0);
  const stats = config.economy?.stats?.[userId] || {};
  const upgrades = config.economy?.upgrades?.[userId] || {};
  const achievements = [];

  if (balance >= 100) achievements.push("Bread Beginner");
  if (balance >= 1000) achievements.push("Bread Baron");
  if (balance >= 5000) achievements.push("Bakery Tyrant");
  if (bank >= 1000) achievements.push("Banked Bread");
  if (bank >= 10000) achievements.push("Vault Whisperer");
  if ((balance + bank) >= 25000) achievements.push("Bread Cathedral");
  if (Math.max(Number(stats.gamesPlayed) || 0, 0) >= 10) achievements.push("Casino Regular");
  if (Math.max(Number(stats.gamesWon) || 0, 0) >= 5) achievements.push("Loaded Dice Survivor");
  if (Math.max(Number(stats.biggestWin) || 0, 0) >= 1000) achievements.push("Big Crumb Energy");
  if (profile.vouches.length >= 1) achievements.push("Vouched");
  if (profile.vouches.length >= 5) achievements.push("Round Table Favorite");
  if (profile.artifacts.length >= 1) achievements.push("Artifact Bearer");
  if (Object.keys(profile.inventory).length >= 3) achievements.push("Well Equipped");
  if (Object.keys(profile.inventory).length >= 6) achievements.push("Artifact Hoarder");
  if (Object.values(upgrades).reduce((sum, level) => sum + Math.max(Number(level) || 0, 0), 0) >= 5) achievements.push("Upgrade Goblet");
  if (profile.badges.length >= 3) achievements.push("Decorated Horn");
  if (profile.publicVisible) achievements.push("Directory Denizen");
  if (profile.favoriteArtifact) achievements.push("Artifact Opinion Haver");

  return [...new Set([...profile.manualAchievements, ...achievements])];
}

async function updateCommunity(store, guildId, updater) {
  const config = store.getGuild(guildId);
  const current = communityState(config);
  const next = updater(current, config) || current;
  return store.updateGuild(guildId, {
    community: {
      ...current,
      ...next
    }
  });
}

export async function updateProfile(store, guildId, userId, updater, fallbackName = "") {
  return updateCommunity(store, guildId, (community) => {
    const existing = profileFor({ community }, userId, fallbackName);
    const nextProfile = updater(existing) || existing;
    return {
      ...community,
      profiles: {
        ...community.profiles,
        [userId]: {
          ...existing,
          ...nextProfile,
          lastUpdatedAt: new Date().toISOString()
        }
      }
    };
  });
}

export async function addAuditLog(store, guildId, entry) {
  return updateCommunity(store, guildId, (community) => ({
    ...community,
    auditLog: [
      {
        id: String(entry.id || `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        type: String(entry.type || "event").slice(0, 40),
        label: String(entry.label || "Community event").slice(0, 120),
        action: String(entry.action || entry.type || "event").slice(0, 40),
        details: String(entry.details || "").slice(0, 260),
        actor: String(entry.actor || "").slice(0, 80),
        targetId: String(entry.targetId || "").slice(0, 40),
        targetTag: String(entry.targetTag || "").slice(0, 80),
        moderatorId: String(entry.moderatorId || "").slice(0, 40),
        moderatorTag: String(entry.moderatorTag || entry.actor || "").slice(0, 80),
        createdAt: new Date().toISOString()
      },
      ...(community.auditLog || [])
    ].slice(0, MAX_AUDIT_LOG)
  }));
}

export async function deleteAuditLog(store, guildId, logId) {
  const targetId = String(logId || "");
  return updateCommunity(store, guildId, (community) => ({
    ...community,
    auditLog: (community.auditLog || []).filter((entry, index) => {
      const entryId = String(entry.id || `legacy-${index}`);
      return entryId !== targetId;
    })
  }));
}

export async function createCase(store, guildId, entry) {
  let createdCase = null;
  await updateCommunity(store, guildId, (community) => {
    const cases = normalizeCases(community.cases);
    const nextId = Math.max(0, ...cases.map((item) => item.id)) + 1;
    createdCase = {
      id: nextId,
      action: String(entry.action || "note").slice(0, 40),
      targetId: String(entry.targetId || ""),
      targetTag: String(entry.targetTag || "").slice(0, 80),
      moderatorId: String(entry.moderatorId || ""),
      moderatorTag: String(entry.moderatorTag || "").slice(0, 80),
      reason: String(entry.reason || "").slice(0, 260),
      status: String(entry.status || "open").slice(0, 20),
      durationMs: Math.max(Math.floor(Number(entry.durationMs) || 0), 0),
      createdAt: new Date().toISOString(),
      updates: []
    };
    return {
      ...community,
      cases: [createdCase, ...cases].slice(0, MAX_CASES),
      analytics: {
        ...community.analytics,
        totals: {
          ...community.analytics.totals,
          casesOpened: Math.max(Math.floor(Number(community.analytics.totals?.casesOpened) || 0) + 1, 1),
          moderationActions: Math.max(Math.floor(Number(community.analytics.totals?.moderationActions) || 0) + 1, 1)
        }
      }
    };
  });
  return createdCase;
}

export async function updateCase(store, guildId, caseId, updater) {
  let updatedCase = null;
  await updateCommunity(store, guildId, (community) => {
    const cases = normalizeCases(community.cases).map((entry) => {
      if (entry.id !== Number(caseId)) return entry;
      updatedCase = updater(entry) || entry;
      return updatedCase;
    });
    return {
      ...community,
      cases
    };
  });
  return updatedCase;
}

export function getCase(config = {}, caseId) {
  return normalizeCases(communityState(config).cases).find((entry) => entry.id === Number(caseId)) || null;
}

export function casesForUser(config = {}, userId) {
  return normalizeCases(communityState(config).cases).filter((entry) => entry.targetId === String(userId || ""));
}

export async function incrementMetric(store, guildId, metric, amount = 1) {
  return updateCommunity(store, guildId, (community) => ({
    ...community,
    analytics: {
      ...community.analytics,
      totals: {
        ...community.analytics.totals,
        [metric]: Math.max(Math.floor(Number(community.analytics.totals?.[metric]) || 0) + amount, 0)
      }
    }
  }));
}

export async function recordCommandUsage(store, guildId, commandName, category = "Other") {
  return updateCommunity(store, guildId, (community) => {
    const current = community.analytics.commands?.[commandName] || {};
    return {
      ...community,
      analytics: {
        ...community.analytics,
        commands: {
          ...community.analytics.commands,
          [commandName]: {
            count: Math.max(Math.floor(Number(current.count) || 0) + 1, 1),
            category: String(current.category || category || "Other"),
            lastUsedAt: new Date().toISOString()
          }
        },
        totals: {
          ...community.analytics.totals,
          commandsRun: Math.max(Math.floor(Number(community.analytics.totals?.commandsRun) || 0) + 1, 1)
        }
      }
    };
  });
}

export async function addArtifact(store, guildId, artifact) {
  return updateCommunity(store, guildId, (community) => ({
    ...community,
    artifacts: normalizeArtifacts([
      {
        id: artifact.id,
        name: artifact.name,
        rarity: artifact.rarity,
        keeper: artifact.keeper,
        summary: artifact.summary
      },
      ...(community.artifacts || [])
    ]),
    analytics: {
      ...community.analytics,
      totals: {
        ...community.analytics.totals,
        artifactsRegistered: Math.max(Math.floor(Number(community.analytics.totals?.artifactsRegistered) || 0) + 1, 1)
      }
    }
  }));
}

export function artifactOfTheDay(config = {}) {
  const artifacts = normalizeArtifacts(communityState(config).artifacts);
  if (!artifacts.length) return null;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  return artifacts[Math.abs(dayIndex) % artifacts.length];
}

export function shopCatalog() {
  return SHOP_ITEMS.map((item) => ({ ...item }));
}

export function shopItem(itemId = "") {
  return SHOP_ITEMS.find((item) => item.id === String(itemId || "").toLowerCase()) || null;
}

export async function purchaseShopItem(store, guildId, userId, fallbackName, itemId) {
  const config = store.getGuild(guildId);
  const item = shopItem(itemId);
  if (!item) return { ok: false, error: "That shop item does not exist." };

  const balance = Math.max(Math.floor(Number(config.economy?.balances?.[userId]) || 0), 0);
  if (balance < item.cost) {
    return { ok: false, error: `You need ${item.cost} bread for ${item.name}.` };
  }

  await store.updateGuild(guildId, {
    economy: {
      ...config.economy,
      balances: {
        ...(config.economy?.balances || {}),
        [userId]: balance - item.cost
      }
    }
  });

  await updateProfile(store, guildId, userId, (profile) => {
    const inventory = normalizeInventory(profile.inventory);
    inventory[item.id] = (inventory[item.id] || 0) + 1;
    const badges = [...profile.badges];
    if (item.type === "badge" && !badges.includes(item.name)) badges.push(item.name);
    const title = item.type === "title" && item.title ? item.title : profile.title;
    return {
      ...profile,
      displayName: profile.displayName || fallbackName,
      title,
      inventory,
      badges
    };
  }, fallbackName);
  await incrementMetric(store, guildId, "shopPurchases", 1);

  return { ok: true, item };
}

export function publicMemberCards(config = {}) {
  return (config.publicSite?.members || [])
    .map((member) => ({
      name: String(member.name || "").slice(0, 80),
      role: String(member.role || "").slice(0, 80),
      bio: String(member.bio || "").slice(0, 220),
      title: String(member.title || "").slice(0, 80),
      badges: Array.isArray(member.badges)
        ? member.badges.map((badge) => String(badge || "").slice(0, 40)).filter(Boolean).slice(0, 8)
        : String(member.badges || "").split(",").map((badge) => badge.trim()).filter(Boolean).slice(0, 8)
    }))
    .filter((member) => member.name)
    .slice(0, 60);
}

export function communitySnapshot(config = {}) {
  const community = communityState(config);
  const profiles = Object.values(community.profiles || {});
  const totals = mergeTotals(community.analytics?.totals);
  return {
    profiles: profiles.length,
    artifacts: normalizeArtifacts(community.artifacts).length,
    cases: normalizeCases(community.cases).length,
    auditEvents: community.auditLog.length,
    vouches: profiles.reduce((sum, profile) => sum + (Array.isArray(profile.vouches) ? profile.vouches.length : 0), 0),
    commandsRun: totals.commandsRun,
    aiReplies: totals.aiReplies,
    applicationsOpened: totals.applicationsOpened,
    applicationsApproved: totals.applicationsApproved,
    applicationsDenied: totals.applicationsDenied,
    moderationActions: totals.moderationActions,
    casesOpened: totals.casesOpened,
    artifactsRegistered: totals.artifactsRegistered,
    shopPurchases: totals.shopPurchases,
    suggestions: Array.isArray(community.suggestions) ? community.suggestions.length : 0
  };
}

export function topCommands(config = {}, limit = 8) {
  const commands = Object.entries(communityState(config).analytics.commands || {})
    .map(([name, info]) => ({
      name,
      category: String(info.category || "Other"),
      count: Math.max(Math.floor(Number(info.count) || 0), 0),
      lastUsedAt: String(info.lastUsedAt || "")
    }))
    .filter((command) => command.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return commands.slice(0, limit);
}

export function parseArtifactDirectory(value = "") {
  return normalizeArtifacts(
    String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = "", rarity = "", keeper = "", summary = ""] = line.split("|").map((part) => part.trim());
        return { name, rarity, keeper, summary };
      })
  );
}

export function artifactDirectoryText(artifacts = []) {
  return normalizeArtifacts(artifacts)
    .map((artifact) => [artifact.name, artifact.rarity, artifact.keeper, artifact.summary].join(" | "))
    .join("\n");
}

export function parseStaffNotes(value = "") {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [member = "", note = ""] = line.split("|").map((part) => part.trim());
      return { member, note };
    })
    .filter((entry) => entry.member && entry.note)
    .slice(0, 120);
}
