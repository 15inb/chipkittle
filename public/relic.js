import { clamp, createGameServices, distanceSq, rand, safeName, escapeHtml } from "./game-common.js";

const canvas = document.getElementById("relicCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
const overlay = document.getElementById("relicOverlay");
const startButton = document.getElementById("relicStart");
const practiceButton = document.getElementById("relicPractice");
const playerName = document.getElementById("relicPlayerName");
const leaderboardList = document.getElementById("relicLeaderboard");
const leaderboardStatus = document.getElementById("relicLeaderboardStatus");
const claimCard = document.getElementById("relicClaim");
const loadout = document.getElementById("relicLoadout");
const objectives = document.getElementById("relicObjectives");
const statusText = document.getElementById("relicStatus");
const difficultyText = document.getElementById("relicDifficulty");
const intel = document.getElementById("relicIntel");
const intelLabel = document.getElementById("relicIntelLabel");
const essenceCounter = document.getElementById("relicEssence");
const metaUpgradeList = document.getElementById("relicMetaUpgrades");
const loadoutOptions = document.getElementById("relicLoadoutOptions");
const loadoutStatus = document.getElementById("relicLoadoutStatus");
const permanentPowers = document.getElementById("relicPermanentPowers");
const upgradeModal = document.getElementById("relicUpgradeModal");
const upgradeGrid = document.getElementById("relicUpgradeGrid");
const fullscreenButton = document.getElementById("relicFullscreen");
const toastLayer = document.getElementById("relicToastLayer");
const eventBanner = document.getElementById("relicEventBanner");
const eventKicker = document.getElementById("relicEventKicker");
const eventTitle = document.getElementById("relicEventTitle");

const hud = {
  wave: document.getElementById("hudWave"),
  health: document.getElementById("hudHealth"),
  bread: document.getElementById("hudBread"),
  score: document.getElementById("hudScore"),
  relic: document.getElementById("hudRelic"),
  dash: document.getElementById("hudDash"),
  combo: document.getElementById("hudCombo")
};

const services = createGameServices("relic", {
  leaderboardList,
  leaderboardStatus,
  claimCard,
  playerName,
  emptyText: "No relic sieges yet."
});

const WORLD = { width: 3200, height: 2200 };
const VIEW = { width: 1280, height: 720 };
const META_KEY = "chipkittle-relic-meta";
const LOADOUT_KEY = "chipkittle-relic-loadout";
const keys = new Set();
const GAMEPLAY_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift", "q", "p", "escape", "m"]);
const pointer = { x: VIEW.width / 2, y: VIEW.height / 2, down: false, worldX: 0, worldY: 0 };
const camera = { x: 0, y: 0, shake: 0, trauma: 0 };
const pools = {
  particles: [],
  enemies: [],
  projectiles: [],
  enemyShots: [],
  pickups: [],
  texts: [],
  hazards: []
};

const metaUpgradeCatalog = [
  { id: "vitality", name: "Fur Density", description: "+18 max health per level.", max: 8, baseCost: 20, step: 14 },
  { id: "damage", name: "Horn Voltage", description: "+3 shot damage per level.", max: 10, baseCost: 24, step: 16 },
  { id: "speed", name: "Panic Footwork", description: "+14 movement speed per level.", max: 8, baseCost: 18, step: 13 },
  { id: "magnet", name: "Bread Gravity", description: "+22 pickup range per level.", max: 8, baseCost: 18, step: 12 },
  { id: "relic", name: "Relic Familiarity", description: "Relic burst charges sooner.", max: 7, baseCost: 28, step: 18 },
  { id: "crit", name: "Unwise Confidence", description: "+2% critical chance per level.", max: 6, baseCost: 30, step: 20 }
];

const startingPerkCatalog = {
  none: { id: "none", name: "No Starting Perk", rarity: "common", role: "Pure run", description: "Start clean and let the den decide your build.", apply() {} },
  overcharge: { id: "overcharge", name: "Opening Overcharge", rarity: "rare", role: "Aggressive opener", description: "Start with short overcharge and extra early tempo.", apply() { player.overcharge = Math.max(player.overcharge, 6); state.fireCooldown = 0; } },
  relicseed: { id: "relicseed", name: "Relic Seed", rarity: "rare", role: "Ability build", description: "Begin with 35% relic charge and a lower burst cooldown.", apply() { player.relic = Math.max(player.relic, player.relicMax * 0.35); state.relicCooldown = 0; } },
  breadmagnet: { id: "breadmagnet", name: "Bread Magnet Charm", rarity: "rare", role: "Economy utility", description: "Start with stronger pickup range and slightly better bread flow.", apply() { player.magnet += 115; state.flags.add("starter-bread-magnet"); } },
  shieldstarter: { id: "shieldstarter", name: "Keeper's Advance", rarity: "epic", role: "Defensive opener", requiresPower: "keeper-oath", description: "Start shielded and trigger a small pulse on your first shield break.", apply() { player.shield += 42; state.flags.add("reactive-armor"); } },
  voltstarter: { id: "voltstarter", name: "Storm Primer", rarity: "epic", role: "Chain opener", requiresPower: "storm-memory", description: "Shots chain to one extra target from wave one.", apply() { player.chainTargets += 1; state.flags.add("storm-bridge"); } }
};

const permanentPowerCatalog = [
  { id: "dash-core", name: "Dash Core", rarity: "rare", threshold: 10, description: "Dash recovers faster and gives a longer invulnerability blink.", apply() { player.dash += 0.22; state.flags.add("dash-core"); } },
  { id: "keeper-oath", name: "Keeper Oath", rarity: "rare", threshold: 20, description: "Unlocks Keeper's Advance and adds a small shield to every run.", apply() { player.shield += 18; } },
  { id: "storm-memory", name: "Storm Memory", rarity: "epic", threshold: 30, description: "Unlocks Storm Primer and adds one passive chain target.", apply() { player.chainTargets += 1; } },
  { id: "blood-bakery", name: "Blood Bakery", rarity: "epic", threshold: 40, description: "Gain light lifesteal on weapon hits.", apply() { state.flags.add("meta-lifesteal"); } },
  { id: "black-horn", name: "Black Horn Doctrine", rarity: "legendary", threshold: 50, description: "Crit chance rises, but enemy pressure pays more score.", apply() { player.crit += 0.06; state.flags.add("black-horn-doctrine"); } },
  { id: "endless-satchel", name: "Endless Satchel", rarity: "legendary", threshold: 60, description: "Bread, relic shards, and hearts pull from much farther away.", apply() { player.magnet += 145; } }
];

const RUN_MODIFIERS = [
  { id: "rush", name: "Panic Migration", detail: "Enemies move faster, but every wave pays more score.", speed: 1.12, score: 1.16 },
  { id: "glass", name: "Glass Fur Treaty", detail: "You and the den both hit harder. Mistakes matter.", playerDamage: 1.18, enemyDamage: 1.2, score: 1.18 },
  { id: "lowgrav", name: "Low Gravity Crumbs", detail: "Projectiles fly faster and knockback gets sillier.", projectileSpeed: 1.14, knockback: 1.25 },
  { id: "scarcity", name: "Thin Bread Weather", detail: "Fewer drops, stronger relic charge.", bread: 0.82, relic: 1.2, score: 1.1 },
  { id: "overgrowth", name: "Green Overgrowth", detail: "Hazards appear more often, but pickups pull farther.", hazards: 1.35, magnet: 1.22 },
  { id: "bloodmoon", name: "Blood Moon Audit", detail: "More elite enemies appear. They pay better.", elite: 1.55, score: 1.2 }
];

const ENEMY_BIASES = [
  { id: "swarm", name: "Swarm-heavy", detail: "More wisps, skitters, splitters, and fast trash.", boost: ["wisp", "skitter", "splitter", "mite"] },
  { id: "ranged", name: "Ranged pressure", detail: "More spitters, snipers, and bombardiers.", boost: ["spitter", "sniper", "bombardier"] },
  { id: "armored", name: "Armored procession", detail: "More brutes, guardians, and bulwarks.", boost: ["brute", "guardian", "bulwark"] },
  { id: "support", name: "Support cult", detail: "More healers and buffers mixed into normal waves.", boost: ["healer", "buffer", "guardian"] },
  { id: "volatile", name: "Volatile crumbs", detail: "More mines, chargers, and messy area denial.", boost: ["mine", "charger", "bombardier"] }
];

const WAVE_EVENTS = [
  { id: "standard", name: "Standard Siege", detail: "No special event. Suspiciously normal.", tone: "rare", weight: 34 },
  { id: "bonus", name: "Bread Surge", detail: "Extra bread drops, but the den sends more bodies.", tone: "rare", weight: 9, rewardBoost: 1.25 },
  { id: "elite", name: "Elite Audit", detail: "More elite and affixed enemies. Better score and relic payouts.", tone: "epic", weight: 11, rewardBoost: 1.28 },
  { id: "chaos", name: "Chaos Rule", detail: "A temporary mutator changes this wave's rules.", tone: "legendary", weight: 8, rewardBoost: 1.35 },
  { id: "shop", name: "Keeper Cache", detail: "Shorter wave, better upgrade odds after clearing.", tone: "epic", weight: 6, rewardBoost: 1.1 },
  { id: "ambush", name: "Ambush Pattern", detail: "Fast enemies arrive in packs from weird angles.", tone: "epic", weight: 8, rewardBoost: 1.22 }
];

const WAVE_MUTATORS = [
  { id: "limited-vision", name: "Tunnel Vision", detail: "The arena darkens. Stay close to your own glow." },
  { id: "double-edge", name: "Double-Edge Rite", detail: "All damage is higher this wave." },
  { id: "static-field", name: "Static Field", detail: "Projectiles move faster, enemy shots included." },
  { id: "crumbquake", name: "Crumbquake", detail: "Hazards pulse harder and more often." },
  { id: "greedy-cache", name: "Greedy Cache", detail: "More bread drops, but enemies are tougher." }
];

const ENEMY_AFFIXES = [
  { id: "swift", name: "Swift", color: "#79eaff" },
  { id: "armored", name: "Armored", color: "#a6ffd9" },
  { id: "volatile", name: "Volatile", color: "#ffdf6e" },
  { id: "regenerating", name: "Regen", color: "#b7ff4f" },
  { id: "vicious", name: "Vicious", color: "#ff8f8f" }
];

let meta = loadMetaProgress();
let activeLoadoutTab = "weapon";

function normalizeKey(key = "") {
  return String(key || "").toLowerCase();
}

function isTextInputTarget(target) {
  const tagName = target?.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || Boolean(target?.isContentEditable);
}

function weightedChoice(entries = [], weightKey = "weight") {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry[weightKey]) || 0), 0);
  if (total <= 0) return entries[0] || null;
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= Math.max(0, Number(entry[weightKey]) || 0);
    if (roll <= 0) return entry;
  }
  return entries.at(-1) || null;
}

function runMultiplier(key, fallback = 1) {
  return (state.runModifiers || []).reduce((value, modifier) => value * (Number(modifier[key]) || 1), fallback);
}

function currentWaveEvent(wave = state.wave) {
  return state.waveEvents?.[wave] || null;
}

function currentMutator(id = "") {
  return state.activeMutator?.id === id;
}

function focusGameCanvas() {
  canvas.focus?.({ preventScroll: true });
}

const audio = {
  context: null,
  enabled: true,
  ensure() {
    if (!this.enabled) return null;
    if (!this.context) {
      this.context = new AudioContext();
    }
    if (this.context.state === "suspended") this.context.resume().catch(() => {});
    return this.context;
  },
  tone(frequency = 220, duration = 0.06, type = "sine", gain = 0.035) {
    const context = this.ensure();
    if (!context) return;
    const osc = context.createOscillator();
    const amp = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, context.currentTime);
    amp.gain.setValueAtTime(gain, context.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    osc.connect(amp).connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + duration);
  },
  shoot() { this.tone(340 + Math.random() * 70, 0.045, "triangle", 0.018); },
  hit() { this.tone(150, 0.075, "sawtooth", 0.025); },
  pickup() { this.tone(620, 0.05, "sine", 0.022); },
  relic() { this.tone(110, 0.32, "sawtooth", 0.045); this.tone(660, 0.24, "triangle", 0.026); },
  wave() { this.tone(250, 0.12, "triangle", 0.024); setTimeout(() => this.tone(420, 0.16, "triangle", 0.024), 80); },
  upgrade() { this.tone(520, 0.08, "triangle", 0.026); setTimeout(() => this.tone(760, 0.12, "sine", 0.024), 70); },
  achievement() { this.tone(392, 0.12, "triangle", 0.03); setTimeout(() => this.tone(784, 0.18, "sine", 0.032), 90); }
};

const state = {
  mode: "menu",
  practice: false,
  lastTime: 0,
  time: 0,
  wave: 1,
  waveTimer: 0,
  spawnTimer: 0,
  bossSpawned: false,
  waveClearing: false,
  upgradePending: false,
  waveDamageTaken: 0,
  bossAttackTimer: 0,
  escalationTimer: 0,
  score: 0,
  bread: 0,
  combo: 1,
  comboTimer: 0,
  kills: 0,
  upgrades: [],
  weaponLevels: {},
  armorLevels: {},
  runModifiers: [],
  enemyBias: null,
  waveEvents: {},
  activeMutator: null,
  nextRewardBoost: 0,
  skippedRewards: 0,
  roundModifierOffset: 0,
  flags: new Set(),
  achievements: new Set(),
  milestones: new Set(),
  pauseLatch: false,
  fireCooldown: 0,
  relicCooldown: 0,
  difficulty: 1,
  biome: "Outer Den",
  roundModifier: "Standard",
  flash: 0,
  muteLatch: false,
  gameOverHandled: false
};

const player = {
  x: WORLD.width / 2,
  y: WORLD.height / 2,
  vx: 0,
  vy: 0,
  radius: 28,
  health: 120,
  maxHealth: 120,
  armor: 0,
  speed: 360,
  dash: 1,
  dashCooldown: 0,
  invulnerable: 0,
  damage: 18,
  damageBonus: 0,
  fireRate: 0.16,
  projectileSpeed: 820,
  multiShot: 1,
  magnet: 150,
  relic: 0,
  relicMax: 100,
  crit: 0.08,
  regen: 0,
  shield: 0,
  overcharge: 0,
  statusPower: 1,
  explosionRadius: 86,
  chainTargets: 1,
  weapon: "thorn-smg",
  armorSuit: "ritual-fleece"
};

const weaponCatalog = {
  "thorn-smg": { id: "thorn-smg", name: "Thorn SMG", rarity: "common", role: "Fast pressure", tags: ["rapid", "crit"], fireRate: 0.09, damage: 12, projectileSpeed: 880, multiShot: 1, spread: 0.045, life: 0.7, radius: 5, pierce: 0, recoil: 0.045, color: "#dcffd4", description: "Very fast, low-damage needles. Loves crits, chains, and close-range panic." },
  "rail-horn": { id: "rail-horn", name: "Rail Horn", rarity: "rare", role: "Precision burst", tags: ["rail", "pierce", "crit"], fireRate: 0.56, damage: 74, projectileSpeed: 1380, multiShot: 1, spread: 0, life: 0.52, radius: 8, pierce: 3, recoil: 0.13, color: "#fff29b", description: "Slow, surgical shots that punch through lines. Misses feel bad. Hits feel illegal." },
  "crumb-shotgun": { id: "crumb-shotgun", name: "Crumb Shotgun", rarity: "rare", role: "Close burst", tags: ["spread", "knockback"], fireRate: 0.42, damage: 16, projectileSpeed: 760, multiShot: 7, spread: 0.12, life: 0.42, radius: 5, pierce: 0, recoil: 0.18, color: "#ffcf8a", description: "Huge cone, short range, heavy knockback. Rewards brave nonsense." },
  "loaf-launcher": { id: "loaf-launcher", name: "Loaf Launcher", rarity: "epic", role: "Area control", tags: ["explosive", "burn"], fireRate: 0.68, damage: 46, projectileSpeed: 560, multiShot: 1, spread: 0.015, life: 1.05, radius: 10, pierce: 0, recoil: 0.2, explosionRadius: 110, color: "#ff9b5c", description: "Slow bread grenades that explode and ignite packs. Terrible for subtle people." },
  "spore-sprayer": { id: "spore-sprayer", name: "Spore Sprayer", rarity: "epic", role: "Status control", tags: ["poison", "slow", "rapid"], fireRate: 0.14, damage: 9, projectileSpeed: 720, multiShot: 2, spread: 0.08, life: 0.76, radius: 6, pierce: 0, recoil: 0.055, color: "#b7ff4f", description: "Low-impact shots that poison and slow enemies. Wins by making the room miserable." },
  "storm-relic": { id: "storm-relic", name: "Storm Relic", rarity: "legendary", role: "Chain lightning", tags: ["chain", "shock"], fireRate: 0.24, damage: 28, projectileSpeed: 940, multiShot: 1, spread: 0.025, life: 0.72, radius: 7, pierce: 0, recoil: 0.09, color: "#85ffd2", description: "Reliable shots that arc between enemies. Gets disgusting with status and crit builds." }
};

const armorCatalog = {
  "ritual-fleece": { id: "ritual-fleece", name: "Ritual Fleece", rarity: "common", role: "Balanced", maxHealth: 0, armor: 0, speed: 1, dash: 1, regen: 0, shield: 0, description: "No tradeoff. The default ceremonial fuzz." },
  "stone-yak-plate": { id: "stone-yak-plate", name: "Stone Yak Plate", rarity: "rare", role: "Tank", maxHealth: 85, armor: 8, speed: 0.84, dash: 0.82, regen: 0.4, shield: 20, description: "Much harder to kill, but slower and less able to escape bad rooms." },
  "glassrunner-pelt": { id: "glassrunner-pelt", name: "Glassrunner Pelt", rarity: "rare", role: "Mobility", maxHealth: -20, armor: -1, speed: 1.22, dash: 1.35, regen: 0, shield: 0, description: "Fragile, fast, dash-heavy. Built for players who do not plan to get touched." },
  "keeper-reactor": { id: "keeper-reactor", name: "Keeper Reactor", rarity: "epic", role: "Reactive shield", maxHealth: 25, armor: 3, speed: 0.96, dash: 1, regen: 0.25, shield: 45, flag: "reactive-armor", description: "Starts shielded and retaliates when the shield breaks." },
  "ember-molt": { id: "ember-molt", name: "Ember Molt", rarity: "epic", role: "Sustain burn", maxHealth: 35, armor: 1, speed: 1.04, dash: 1, regen: 1.8, shield: 0, flag: "ember-armor", description: "Regenerates and improves burn builds, but offers modest direct protection." },
  "void-husk": { id: "void-husk", name: "Void Husk", rarity: "legendary", role: "Risk shield", maxHealth: -45, armor: 5, speed: 1.08, dash: 1.18, regen: 0, shield: 90, flag: "void-husk", description: "Huge shield and speed, low health. Perfect until it suddenly is not." }
};

let selectedLoadout = loadLoadout();

function defaultLoadout() {
  return { weapon: "thorn-smg", armor: "ritual-fleece", perk: "none" };
}

function loadLoadout() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOADOUT_KEY) || "{}");
    return {
      weapon: weaponCatalog[parsed.weapon] ? parsed.weapon : "thorn-smg",
      armor: armorCatalog[parsed.armor] ? parsed.armor : "ritual-fleece",
      perk: startingPerkCatalog[parsed.perk] ? parsed.perk : "none"
    };
  } catch {
    return defaultLoadout();
  }
}

function saveLoadout() {
  localStorage.setItem(LOADOUT_KEY, JSON.stringify(selectedLoadout));
  if (loadoutStatus) {
    loadoutStatus.textContent = "Saved";
    window.clearTimeout(saveLoadout.timer);
    saveLoadout.timer = window.setTimeout(() => {
      loadoutStatus.textContent = "Ready";
    }, 1200);
  }
}

function hasPermanentPower(powerId) {
  return Boolean(meta.powerUps?.[powerId]);
}

function isPerkUnlocked(perk) {
  return !perk?.requiresPower || hasPermanentPower(perk.requiresPower);
}

function currentWeapon() {
  return weaponCatalog[player.weapon] || weaponCatalog["thorn-smg"];
}

function currentArmor() {
  return armorCatalog[player.armorSuit] || armorCatalog["ritual-fleece"];
}

function equipWeapon(weaponId) {
  const weapon = weaponCatalog[weaponId];
  if (!weapon) return;
  player.weapon = weapon.id;
  const level = state.weaponLevels[weapon.id] || 0;
  player.damage = weapon.damage + (player.damageBonus || 0) + level * Math.max(4, Math.round(weapon.damage * 0.12));
  player.fireRate = Math.max(0.045, weapon.fireRate * (1 - level * 0.035));
  player.projectileSpeed = weapon.projectileSpeed;
  player.multiShot = weapon.multiShot;
  showToast("Weapon equipped", `${weapon.name}: ${weapon.role}`, weapon.rarity);
  for (let i = 0; i < 24; i += 1) particle(player.x, player.y, rand(-220, 220), rand(-220, 220), rand(0.2, 0.55), weapon.color, rand(2, 5));
}

function equipArmor(armorId) {
  const armor = armorCatalog[armorId];
  if (!armor) return;
  const previousArmor = currentArmor();
  const previousMaxHealth = player.maxHealth;
  const previousLevel = state.armorLevels[previousArmor.id] || 0;
  const level = state.armorLevels[armor.id] || 0;
  player.armorSuit = armor.id;
  player.maxHealth = Math.max(70, player.maxHealth - previousArmor.maxHealth - previousLevel * 18 + armor.maxHealth + level * 18);
  player.health = Math.min(player.maxHealth, Math.max(30, player.health + player.maxHealth - previousMaxHealth));
  player.armor = Math.round(Math.max(-2, armor.armor + level * 2));
  player.speed = player.speed / (previousArmor.speed || 1) * armor.speed;
  player.dash = player.dash / (previousArmor.dash || 1) * armor.dash;
  player.regen += armor.regen + level * 0.2 - previousArmor.regen - previousLevel * 0.2;
  player.shield = Math.max(player.shield, armor.shield + level * 12);
  for (const suit of Object.values(armorCatalog)) {
    if (suit.flag) state.flags.delete(suit.flag);
  }
  if (armor.flag) state.flags.add(armor.flag);
  showToast("Armor equipped", `${armor.name}: ${armor.role}`, armor.rarity);
  for (let i = 0; i < 22; i += 1) particle(player.x, player.y, rand(-170, 170), rand(-170, 170), rand(0.26, 0.66), armor.rarity === "legendary" ? "#fff29b" : "#85ffd2", rand(2, 5));
}

function upgradeCurrentArmor() {
  const armor = currentArmor();
  state.armorLevels[armor.id] = (state.armorLevels[armor.id] || 0) + 1;
  player.maxHealth += 18;
  player.health = Math.min(player.maxHealth, player.health + 18);
  player.armor += armor.id === "glassrunner-pelt" ? 0 : 2;
  player.shield += armor.id === "keeper-reactor" || armor.id === "void-husk" ? 26 : 10;
  if (armor.id === "glassrunner-pelt") {
    player.speed += 22;
    player.dash += 0.12;
  }
  if (armor.id === "ember-molt") player.regen += 0.8;
}

const upgrades = [
  ...Object.values(weaponCatalog).filter((weapon) => weapon.id !== "thorn-smg").map((weapon) => ({
    id: `weapon-${weapon.id}`,
    name: weapon.name,
    rarity: weapon.rarity,
    type: "Weapon",
    description: `${weapon.role}: ${weapon.description}`,
    apply() {
      equipWeapon(weapon.id);
    }
  })),
  ...Object.values(armorCatalog).filter((armor) => armor.id !== "ritual-fleece").map((armor) => ({
    id: `armor-${armor.id}`,
    name: armor.name,
    rarity: armor.rarity,
    type: "Armor",
    description: `${armor.role}: ${armor.description}`,
    apply() {
      equipArmor(armor.id);
    }
  })),
  {
    id: "horns",
    name: "Hollow Horn Voltage",
    rarity: "rare",
    description: "Projectiles hit harder and have a higher crit chance.",
    apply() {
      player.damage += 8;
      player.crit += 0.05;
    }
  },
  {
    id: "regen",
    name: "Warm Den Ember",
    rarity: "rare",
    description: "Slowly regenerate health while you avoid damage.",
    apply() {
      player.regen += 1.6;
    }
  },
  {
    id: "pierce",
    name: "Artifact Splintering",
    rarity: "epic",
    description: "Normal shots pierce one extra enemy.",
    apply() {
      state.flags.add("piercing-shots");
    }
  },
  {
    id: "weapon-tuning",
    name: "Weapon Tuning Fork",
    rarity: "rare",
    type: "Weapon upgrade",
    description: "Your current weapon gains damage, faster handling, and stronger recoil personality.",
    apply() {
      const weapon = currentWeapon();
      state.weaponLevels[weapon.id] = (state.weaponLevels[weapon.id] || 0) + 1;
      equipWeapon(weapon.id);
    }
  },
  {
    id: "status-engine",
    name: "Status Engine",
    rarity: "epic",
    type: "Synergy",
    description: "Poison, burn, slow, and shock effects last longer and hit harder.",
    apply() {
      player.statusPower += 0.45;
      state.flags.add("status-engine");
    }
  },
  {
    id: "combustion-logic",
    name: "Combustion Logic",
    rarity: "legendary",
    type: "Synergy",
    description: "Burning enemies sometimes explode when hit. Loaf Launcher becomes deeply impolite.",
    apply() {
      player.explosionRadius += 34;
      state.flags.add("burn-explodes");
    }
  },
  {
    id: "storm-bridge",
    name: "Storm Bridge",
    rarity: "epic",
    type: "Synergy",
    description: "Chain and shock effects jump to more enemies. Crits add extra arcs.",
    apply() {
      player.chainTargets += 2;
      state.flags.add("storm-bridge");
    }
  },
  {
    id: "armor-reinforce",
    name: "Armor Rite",
    rarity: "rare",
    type: "Armor upgrade",
    description: "Improve your current armor identity: tanks block, scouts move, reactors shield.",
    apply() {
      upgradeCurrentArmor();
    }
  },
  {
    id: "danger-dividend",
    name: "Danger Dividend",
    rarity: "epic",
    type: "Economy",
    description: "Wave clears pay more bread and essence, but messy waves cost extra.",
    apply() {
      state.flags.add("danger-dividend");
    }
  },
  {
    id: "glass-cannon",
    name: "Glass Cannon Doctrine",
    rarity: "epic",
    type: "Tradeoff",
    description: "+40% weapon damage, but max health drops by 20%. Great for Rail Horn and speed builds.",
    apply() {
      player.damage *= 1.4;
      player.maxHealth = Math.max(55, Math.floor(player.maxHealth * 0.8));
      player.health = Math.min(player.health, player.maxHealth);
      state.flags.add("tradeoff-glass-cannon");
    }
  },
  {
    id: "wild-trigger",
    name: "Wild Trigger Finger",
    rarity: "rare",
    type: "Tradeoff",
    description: "+32% fire rate, but shots spread wider. Strong on status guns, risky on precision builds.",
    apply() {
      player.fireRate *= 0.68;
      state.flags.add("wild-spread");
    }
  },
  {
    id: "blood-loaf",
    name: "Blood Loaf Compact",
    rarity: "epic",
    type: "Tradeoff",
    description: "Weapon hits heal you, but base damage drops. Tank and rapid-fire builds love this.",
    apply() {
      player.damage *= 0.86;
      state.flags.add("weapon-lifesteal");
    }
  },
  {
    id: "volatile-loaves",
    name: "Volatile Loaves",
    rarity: "legendary",
    type: "Tradeoff",
    description: "All shots can create small explosions, but blasts near you cause self-damage.",
    apply() {
      player.explosionRadius += 24;
      state.flags.add("volatile-loaves");
    }
  },
  {
    id: "speed-tax",
    name: "Speed Tax Exemption",
    rarity: "rare",
    type: "Tradeoff",
    description: "+30% movement speed and faster dash recovery, but max health drops by 15%.",
    apply() {
      player.speed *= 1.3;
      player.dash += 0.28;
      player.maxHealth = Math.max(60, Math.floor(player.maxHealth * 0.85));
      player.health = Math.min(player.health, player.maxHealth);
    }
  },
  {
    id: "heavy-barrel",
    name: "Heavy Barrel Blessing",
    rarity: "rare",
    type: "Weapon upgrade",
    description: "Shots hit harder and knock enemies back, but fire rate slows slightly.",
    apply() {
      player.damage *= 1.26;
      player.fireRate *= 1.14;
      state.flags.add("heavy-barrel");
    }
  },
  {
    id: "chain-gland",
    name: "Chain Gland",
    rarity: "epic",
    type: "Weapon upgrade",
    description: "Non-chain weapons gain a weak shock jump. Storm Relic gains two more jumps.",
    apply() {
      player.chainTargets += currentWeapon().tags.includes("chain") ? 2 : 1;
      state.flags.add("chain-gland");
    }
  },
  {
    id: "spore-cloud",
    name: "Spore Cloud Payload",
    rarity: "epic",
    type: "Weapon upgrade",
    description: "Poison and slow effects spread to nearby enemies on kill.",
    apply() {
      player.statusPower += 0.25;
      state.flags.add("spore-cloud");
    }
  },
  {
    id: "shield-siphon",
    name: "Shield Siphon",
    rarity: "rare",
    type: "Survivability",
    description: "Kills slowly refill shields. Reactive and Void armor scale especially well.",
    apply() {
      state.flags.add("shield-siphon");
    }
  },
  {
    id: "relic-capacitor",
    name: "Relic Capacitor",
    rarity: "epic",
    type: "Utility",
    description: "Relic burst charges faster, and using it briefly overcharges your weapon.",
    apply() {
      player.relicMax = Math.max(48, player.relicMax - 18);
      state.flags.add("relic-capacitor");
    }
  },
  {
    id: "magnet-sprint",
    name: "Magnet Sprint",
    rarity: "common",
    type: "Utility",
    description: "Pickup range and movement speed rise together. Simple, useful, greedy.",
    apply() {
      player.magnet += 95;
      player.speed += 28;
    }
  },
  {
    id: "ward",
    name: "Keeper Ward",
    rarity: "epic",
    description: "Taking a hit triggers a short knockback pulse.",
    apply() {
      state.flags.add("hit-ward");
    }
  },
  {
    id: "fur",
    name: "Dense Ritual Fur",
    rarity: "common",
    description: "Gain armor and 35 maximum health.",
    apply() {
      player.armor += 3;
      player.maxHealth += 35;
      player.health = Math.min(player.maxHealth, player.health + 35);
    }
  },
  {
    id: "paws",
    name: "Panic Paws",
    rarity: "common",
    description: "Move faster and recharge dash sooner.",
    apply() {
      player.speed += 48;
      player.dash += 0.16;
    }
  },
  {
    id: "loaf",
    name: "Loaf Magnet",
    rarity: "common",
    description: "Pull bread and relic shards from much farther away.",
    apply() {
      player.magnet += 90;
    }
  },
  {
    id: "burst",
    name: "Relic Overbite",
    rarity: "epic",
    description: "Relic burst recharges faster and hits a larger area.",
    apply() {
      player.relicMax = Math.max(55, player.relicMax - 12);
    }
  },
  {
    id: "triple",
    name: "Three Bad Ideas",
    rarity: "rare",
    description: "Fire an extra projectile in a spread.",
    apply() {
      player.multiShot = Math.min(5, player.multiShot + 1);
      player.fireRate += 0.015;
    }
  },
  {
    id: "bakery",
    name: "Questionable Bakery",
    rarity: "rare",
    description: "Bread pickups heal you slightly.",
    apply() {
      state.flags.add("bakery-heal");
    }
  },
  {
    id: "echo",
    name: "Den Echo",
    rarity: "legendary",
    description: "Kills have a chance to release a shock ring.",
    apply() {
      state.flags.add("death-echo");
    }
  },
  {
    id: "glass",
    name: "Glass Relic Contract",
    rarity: "epic",
    description: "Huge damage and score boost, but incoming damage hurts more.",
    apply() {
      player.damage += 18;
      player.crit += 0.04;
      state.flags.add("glass-contract");
    }
  },
  {
    id: "greed",
    name: "Bread Greed Spiral",
    rarity: "legendary",
    description: "Score and bread drops scale harder while shields decay faster.",
    apply() {
      state.flags.add("greed-spiral");
    }
  }
];

const enemyTypes = {
  mite: { hp: 32, speed: 135, radius: 18, damage: 9, value: 22, color: "#9cf66f", role: "baseline chaser" },
  brute: { hp: 92, speed: 82, radius: 30, damage: 18, value: 56, color: "#f1c964", role: "health check" },
  wisp: { hp: 22, speed: 190, radius: 14, damage: 7, value: 30, color: "#79eaff", role: "mobility check" },
  spitter: { hp: 48, speed: 112, radius: 20, damage: 10, value: 46, color: "#c68cff", role: "ranged pressure" },
  guardian: { hp: 150, speed: 58, radius: 35, damage: 20, value: 82, color: "#85ffd2", role: "area pulse" },
  charger: { hp: 76, speed: 118, radius: 23, damage: 18, value: 62, color: "#ffb35c", role: "telegraphed dash" },
  splitter: { hp: 64, speed: 105, radius: 24, damage: 12, value: 58, color: "#b7ff4f", role: "target priority" },
  healer: { hp: 70, speed: 92, radius: 22, damage: 8, value: 72, color: "#ff8fd8", role: "support heal" },
  mine: { hp: 30, speed: 42, radius: 18, damage: 28, value: 38, color: "#ffdf6e", role: "area denial" },
  skitter: { hp: 20, speed: 250, radius: 12, damage: 6, value: 32, color: "#d7ff91", role: "fast swarm" },
  bulwark: { hp: 118, speed: 74, radius: 28, damage: 16, value: 88, color: "#a6ffd9", shield: 72, role: "shield wall" },
  sniper: { hp: 42, speed: 82, radius: 17, damage: 15, value: 78, color: "#ffef9b", role: "line shot" },
  buffer: { hp: 86, speed: 88, radius: 24, damage: 7, value: 92, color: "#ffb3f3", role: "support rage" },
  bombardier: { hp: 96, speed: 68, radius: 25, damage: 17, value: 102, color: "#ff9b5c", role: "lobbed hazards" },
  leech: { hp: 68, speed: 146, radius: 21, damage: 10, value: 84, color: "#b06cff", role: "sustain counter" },
  phantom: { hp: 46, speed: 168, radius: 19, damage: 11, value: 96, color: "#b7c8ff", role: "evasive phase" },
  fragment: { hp: 18, speed: 155, radius: 14, damage: 5, value: 10, color: "#d7ff91", role: "split add" },
  miniboss: { hp: 340, speed: 72, radius: 44, damage: 24, value: 220, color: "#ff6fb4", role: "mid-wave spike" },
  boss: { hp: 720, speed: 64, radius: 54, damage: 26, value: 480, color: "#ff7373", role: "boss phase" },
  superboss: { hp: 2400, speed: 58, radius: 72, damage: 34, value: 1800, color: "#9cff74", shield: 420, role: "super-boss trial" }
};

const DIFFICULTY_MODEL = {
  softStartWave: 1,
  layeredStartWave: 6,
  surgeStartWave: 12,
  endlessStartWave: 18,
  doomStartWave: 26,
  spawnFloor: 0.075,
  baseWaveSeconds: 22,
  baseEnemyCap: 22,
  enemyCapPower: 1.16,
  healthPower: 1.18,
  surgePower: 1.34,
  doomPower: 1.55,
  maxDrawMinimapEnemies: 140,
  maxParticles: 620,
  maxFloatingTexts: 150,
  telegraphFloor: 0.42,
  specialCooldownFloor: 0.34
};

const ROUND_MODIFIERS = [
  {
    id: "standard",
    name: "Standard",
    detail: "No extra curse. Suspiciously polite.",
    enemyCap: 0,
    spawn: 1,
    health: 1,
    speed: 1,
    hazards: 1,
    score: 1
  },
  {
    id: "swarm",
    name: "Swarm Rite",
    detail: "More weak bodies, less time to breathe.",
    enemyCap: 8,
    spawn: 0.82,
    health: 0.93,
    speed: 1.05,
    hazards: 0.9,
    score: 1.08
  },
  {
    id: "iron",
    name: "Iron Fur",
    detail: "Enemies are tougher, but worth more.",
    enemyCap: -4,
    spawn: 1.08,
    health: 1.22,
    speed: 0.96,
    hazards: 0.85,
    score: 1.16
  },
  {
    id: "sparks",
    name: "Green Sparks",
    detail: "Projectiles and hazards get jumpy.",
    enemyCap: 1,
    spawn: 0.96,
    health: 1,
    speed: 1.04,
    hazards: 1.45,
    score: 1.18
  },
  {
    id: "hunt",
    name: "Hunter Moon",
    detail: "Fast enemies pressure your positioning.",
    enemyCap: 2,
    spawn: 0.9,
    health: 0.98,
    speed: 1.16,
    hazards: 1,
    score: 1.22
  }
];

function lateWavePressure(wave = state.wave) {
  if (wave <= DIFFICULTY_MODEL.layeredStartWave) return 0;
  return ((wave - DIFFICULTY_MODEL.layeredStartWave) / 5) ** 1.28;
}

function roundModifierFor(wave = state.wave) {
  if (wave < 4) return ROUND_MODIFIERS[0];
  return ROUND_MODIFIERS[(wave - 1 + (state.roundModifierOffset || 0)) % ROUND_MODIFIERS.length];
}

function difficultyProfile(wave = state.wave) {
  const soft = Math.max(0, wave - DIFFICULTY_MODEL.softStartWave);
  const layered = Math.max(0, wave - DIFFICULTY_MODEL.layeredStartWave);
  const surge = Math.max(0, wave - DIFFICULTY_MODEL.surgeStartWave);
  const endless = Math.max(0, wave - DIFFICULTY_MODEL.endlessStartWave);
  const doom = Math.max(0, wave - DIFFICULTY_MODEL.doomStartWave);
  const modifier = roundModifierFor(wave);
  const event = currentWaveEvent(wave);
  const eventElite = event?.id === "elite" ? 1.85 : event?.id === "ambush" ? 1.18 : 1;
  const eventSpawn = event?.id === "bonus" || event?.id === "ambush" ? 0.82 : event?.id === "shop" ? 1.24 : 1;
  const eventHealth = event?.id === "elite" ? 1.18 : 1;
  const risk = state.skippedRewards || 0;
  const riskSpawn = Math.max(0.7, 1 - risk * 0.08);
  const riskHealth = 1 + risk * 0.08;
  const riskReward = 1 + risk * 0.16;
  const mutatorDamage = currentMutator("double-edge") ? 1.28 : 1;
  const mutatorProjectile = currentMutator("static-field") ? 1.22 : 1;
  const mutatorHazards = currentMutator("crumbquake") ? 1.42 : 1;
  const smoothCurve = wave ** DIFFICULTY_MODEL.healthPower;
  const layeredCurve = layered ** 1.22;
  const surgeCurve = surge ** DIFFICULTY_MODEL.surgePower;
  const endlessCurve = endless ** 1.18;
  const doomCurve = doom ** DIFFICULTY_MODEL.doomPower;
  const chaos = 1 + layeredCurve * 0.018 + surgeCurve * 0.024 + doomCurve * 0.018;

  const threat = 1 + smoothCurve * 0.045 + layeredCurve * 0.032 + surgeCurve * 0.038 + endlessCurve * 0.028 + doomCurve * 0.026;
  const telegraphMultiplier = Math.max(
    DIFFICULTY_MODEL.telegraphFloor,
    1 - layered * 0.018 - surge * 0.011 - doom * 0.006
  );
  const specialCooldownMultiplier = Math.max(
    DIFFICULTY_MODEL.specialCooldownFloor,
    1 - layered * 0.022 - surge * 0.014 - doom * 0.008
  );
  const enemyCap = Math.max(
    14,
    Math.floor(DIFFICULTY_MODEL.baseEnemyCap + soft * 1.7 + layeredCurve * 0.9 + surgeCurve * 0.42 + doomCurve * 0.18 + modifier.enemyCap)
  );

  return {
    wave,
    modifier,
    chaos,
    doom,
    threat,
    healthScale: (1 + smoothCurve * 0.052 + layeredCurve * 0.04 + surgeCurve * 0.034 + endlessCurve * 0.033 + doomCurve * 0.024) * modifier.health * eventHealth * riskHealth * (currentMutator("greedy-cache") ? 1.16 : 1),
    speedScale: (1 + soft * 0.013 + layeredCurve * 0.009 + surgeCurve * 0.0075 + doomCurve * 0.0038) * modifier.speed * runMultiplier("speed"),
    damageScale: (1 + Math.max(0, wave - 7) * 0.026 + surgeCurve * 0.007 + doomCurve * 0.006) * runMultiplier("enemyDamage") * mutatorDamage,
    spawnInterval: Math.max(
      DIFFICULTY_MODEL.spawnFloor,
      (1.08 / (1 + soft * 0.055 + layeredCurve * 0.025 + surgeCurve * 0.021 + doomCurve * 0.014)) * modifier.spawn * eventSpawn * riskSpawn
    ),
    enemyCap,
    burstCount: Math.max(1, Math.floor(1 + layered / 8 + surgeCurve * 0.035 + doomCurve * 0.025)),
    hazardRate: (0.018 + soft * 0.004 + layeredCurve * 0.0037 + surgeCurve * 0.0032 + doomCurve * 0.0028) * modifier.hazards * runMultiplier("hazards") * mutatorHazards,
    extraSpawnChance: 0.08 + layered * 0.025 + surgeCurve * 0.009 + doomCurve * 0.006,
    supportChance: Math.max(0, (wave - 7) * 0.025 + surgeCurve * 0.006 + doomCurve * 0.004),
    eliteChance: Math.max(0, ((wave - 9) * 0.018 + surgeCurve * 0.006 + doomCurve * 0.004) * eventElite * runMultiplier("elite")),
    incomingDamageMultiplier: (1 + Math.max(0, wave - 16) * 0.012 + doomCurve * 0.01) * mutatorDamage,
    sustainMultiplier: Math.max(0.32, 1 - Math.max(0, wave - 18) * 0.012 - doomCurve * 0.004),
    bossCount: Math.max(1, Math.floor(1 + Math.max(0, wave - 16) / 12 + doom / 8)),
    minibossCount: Math.max(1, Math.floor(1 + Math.max(0, wave - 9) / 9 + doom / 7)),
    telegraphMultiplier,
    specialCooldownMultiplier,
    projectileSpeedScale: (1 + soft * 0.01 + layeredCurve * 0.008 + surgeCurve * 0.006 + doomCurve * 0.003) * mutatorProjectile,
    bossPatternScale: 1 + layeredCurve * 0.035 + surgeCurve * 0.032 + doomCurve * 0.022,
    scoreMultiplier: (1 + soft * 0.035 + layered * 0.028 + surgeCurve * 0.018 + endlessCurve * 0.026 + doomCurve * 0.02) * modifier.score * runMultiplier("score") * (event?.rewardBoost || 1) * riskReward,
    waveLength: (DIFFICULTY_MODEL.baseWaveSeconds + Math.sqrt(wave) * 4.2 + layeredCurve * 0.34 + surgeCurve * 0.16 + doomCurve * 0.08) * (event?.id === "shop" ? 0.72 : 1)
  };
}

function loadMetaProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return {
      essence: Math.max(0, Math.floor(Number(parsed.essence) || 0)),
      powerUps: Object.fromEntries(permanentPowerCatalog.map((power) => [power.id, Boolean(parsed.powerUps?.[power.id])])),
      bestRound: Math.max(0, Math.floor(Number(parsed.bestRound) || 0)),
      upgrades: Object.fromEntries(metaUpgradeCatalog.map((item) => [
        item.id,
        clamp(Math.floor(Number(parsed.upgrades?.[item.id]) || 0), 0, item.max)
      ]))
    };
  } catch {
    return {
      essence: 0,
      powerUps: Object.fromEntries(permanentPowerCatalog.map((power) => [power.id, false])),
      bestRound: 0,
      upgrades: Object.fromEntries(metaUpgradeCatalog.map((item) => [item.id, 0]))
    };
  }
}

function saveMetaProgress() {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function metaCost(item) {
  const level = meta.upgrades[item.id] || 0;
  return item.baseCost + item.step * level + Math.floor(level ** 1.6 * 8);
}

function renderMetaUpgrades() {
  essenceCounter.textContent = Math.floor(meta.essence).toLocaleString();
  metaUpgradeList.innerHTML = metaUpgradeCatalog.map((item) => {
    const level = meta.upgrades[item.id] || 0;
    const maxed = level >= item.max;
    const cost = metaCost(item);
    const affordable = meta.essence >= cost;
    return `
      <div class="relic-meta-row">
        <span>
          <strong>${item.name} ${level}/${item.max}</strong>
          <small>${escapeHtml(item.description)}</small>
        </span>
        <button type="button" data-meta-upgrade="${item.id}" ${maxed || !affordable ? "disabled" : ""}>${maxed ? "Maxed" : `${cost} essence`}</button>
      </div>
    `;
  }).join("");
}

function buyMetaUpgrade(upgradeId) {
  const item = metaUpgradeCatalog.find((entry) => entry.id === upgradeId);
  if (!item) return;
  const level = meta.upgrades[item.id] || 0;
  const cost = metaCost(item);
  if (level >= item.max || meta.essence < cost) return;
  meta.essence -= cost;
  meta.upgrades[item.id] = level + 1;
  saveMetaProgress();
  renderMetaUpgrades();
  announce(`${item.name} upgraded. Permanent weirdness increased.`, "#fff29b");
  showToast("Permanent upgrade", `${item.name} is now level ${meta.upgrades[item.id]}.`, "legendary");
  audio.upgrade();
}

function renderLoadoutPicker() {
  if (!loadoutOptions) return;
  if (!isPerkUnlocked(startingPerkCatalog[selectedLoadout.perk])) {
    selectedLoadout.perk = "none";
    saveLoadout();
  }
  const collections = {
    weapon: Object.values(weaponCatalog),
    armor: Object.values(armorCatalog),
    perk: Object.values(startingPerkCatalog)
  };
  const selected = activeLoadoutTab === "weapon" ? selectedLoadout.weapon : activeLoadoutTab === "armor" ? selectedLoadout.armor : selectedLoadout.perk;
  loadoutOptions.innerHTML = collections[activeLoadoutTab].map((item) => {
    const id = item.id;
    const locked = activeLoadoutTab === "perk" && !isPerkUnlocked(item);
    const selectedClass = selected === id ? " is-selected" : "";
    const lockedText = locked ? `Requires ${permanentPowerCatalog.find((power) => power.id === item.requiresPower)?.name || "a permanent power"}` : item.description;
    return `
      <button type="button" class="relic-loadout-card rarity-${item.rarity || "common"}${selectedClass}" data-loadout-kind="${activeLoadoutTab}" data-loadout-id="${id}" title="${escapeHtml(lockedText)}" ${locked ? "disabled" : ""}>
        <span>${safeName(item.role || item.type || "Loadout")}</span>
        <strong>${safeName(item.name)}</strong>
        <small>${escapeHtml(lockedText)}</small>
      </button>
    `;
  }).join("");

  document.querySelectorAll("[data-loadout-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.loadoutTab === activeLoadoutTab);
  });

  const unlocked = permanentPowerCatalog.filter((power) => hasPermanentPower(power.id));
  if (permanentPowers) {
    permanentPowers.innerHTML = unlocked.length
      ? unlocked.map((power) => `<span class="rarity-${power.rarity}"><b>${safeName(power.name)}</b> ${escapeHtml(power.description)}</span>`).join("")
      : "Reach round 10 to awaken the first permanent power.";
  }
}

function applyStartingPerk(perkId) {
  const perk = startingPerkCatalog[perkId] || startingPerkCatalog.none;
  if (!isPerkUnlocked(perk)) return startingPerkCatalog.none.apply();
  perk.apply();
  if (perk.id !== "none") state.upgrades.push(`Start: ${perk.name}`);
}

function applyPermanentPowers() {
  for (const power of permanentPowerCatalog) {
    if (hasPermanentPower(power.id)) {
      power.apply();
      state.upgrades.push(`Permanent: ${power.name}`);
    }
  }
}

function awardPermanentPowers(roundReached) {
  const previousBest = Math.max(Number(meta.bestRound) || 0, 0);
  meta.bestRound = Math.max(previousBest, roundReached);
  const newlyUnlocked = [];
  for (const power of permanentPowerCatalog) {
    if (roundReached >= power.threshold && !hasPermanentPower(power.id)) {
      meta.powerUps[power.id] = true;
      newlyUnlocked.push(power);
    }
  }
  if (newlyUnlocked.length || meta.bestRound !== previousBest) {
    saveMetaProgress();
    renderLoadoutPicker();
  }
  return newlyUnlocked;
}

function applyMetaUpgrades() {
  const levels = meta.upgrades || {};
  player.maxHealth += (levels.vitality || 0) * 18;
  player.health = player.maxHealth;
  player.damageBonus = (levels.damage || 0) * 3;
  player.damage += player.damageBonus;
  player.speed += (levels.speed || 0) * 14;
  player.magnet += (levels.magnet || 0) * 22;
  player.relicMax = Math.max(62, player.relicMax - (levels.relic || 0) * 4);
  player.crit += (levels.crit || 0) * 0.02;
}

function chooseRunModifiers() {
  return [...RUN_MODIFIERS]
    .sort(() => Math.random() - 0.5)
    .slice(0, 2);
}

function chooseEnemyBias() {
  return ENEMY_BIASES[Math.floor(rand(0, ENEMY_BIASES.length))] || ENEMY_BIASES[0];
}

function applyRunProfile() {
  player.damage *= runMultiplier("playerDamage");
  player.projectileSpeed *= runMultiplier("projectileSpeed");
  player.magnet *= runMultiplier("magnet");
  if (runMultiplier("knockback") > 1) state.flags.add("run-knockback");
}

function randomWaveEvent(wave = state.wave) {
  if (wave <= 2) return WAVE_EVENTS[0];
  if (wave >= 15 && wave % 15 === 0) return { id: "superboss", name: "Super Boss Trial", detail: "The Grand Antler Auditor arrives this wave.", tone: "legendary", rewardBoost: 1.45 };
  if (wave % 4 === 0) return { id: "boss", name: "Boss Wave", detail: "A boss anchors the wave. Extra rewards if you survive.", tone: "legendary", rewardBoost: 1.18 };
  if (wave % 3 === 0) return { id: "miniboss", name: "Mini-boss Spike", detail: "A smaller problem with a large attitude.", tone: "epic", rewardBoost: 1.1 };
  const pressure = lateWavePressure(wave);
  return weightedChoice(WAVE_EVENTS.map((event) => ({
    ...event,
    weight: event.weight + (event.id === "chaos" ? pressure * 0.9 : 0) + (event.id === "elite" ? pressure * 0.55 : 0)
  }))) || WAVE_EVENTS[0];
}

function waveEventFor(wave = state.wave) {
  state.waveEvents ||= {};
  if (!state.waveEvents[wave]) state.waveEvents[wave] = randomWaveEvent(wave);
  return state.waveEvents[wave];
}

function chooseWaveMutator() {
  return WAVE_MUTATORS[Math.floor(rand(0, WAVE_MUTATORS.length))] || WAVE_MUTATORS[0];
}

function beginWaveVariation(wave = state.wave) {
  const event = waveEventFor(wave);
  state.activeMutator = event.id === "chaos" ? chooseWaveMutator() : null;
  state.nextRewardBoost = Math.max(state.nextRewardBoost || 0, event.rewardBoost || 1);
  const detail = state.activeMutator ? `${event.detail} ${state.activeMutator.name}: ${state.activeMutator.detail}` : event.detail;
  showEvent(event.name, detail, event.tone || "rare");
  showToast(event.name, detail, event.tone || "rare");
}

function resetRun(practice = false) {
  keys.clear();
  focusGameCanvas();
  Object.assign(state, {
    mode: "playing",
    practice,
    lastTime: performance.now(),
    time: 0,
    wave: 1,
    waveTimer: 0,
    spawnTimer: 0,
    bossSpawned: false,
    waveClearing: false,
    upgradePending: false,
    waveDamageTaken: 0,
    bossAttackTimer: 0,
    escalationTimer: 0,
    score: 0,
    bread: 0,
    combo: 1,
    comboTimer: 0,
    kills: 0,
    upgrades: [],
    weaponLevels: {},
    armorLevels: {},
    runModifiers: chooseRunModifiers(),
    enemyBias: chooseEnemyBias(),
    waveEvents: {},
    activeMutator: null,
    nextRewardBoost: 1,
    skippedRewards: 0,
    roundModifierOffset: Math.floor(rand(0, ROUND_MODIFIERS.length)),
    flags: new Set(),
    achievements: new Set(),
    milestones: new Set(),
    fireCooldown: 0,
    relicCooldown: 0,
    difficulty: practice ? 0.78 : 1,
    biome: "Outer Den",
    roundModifier: "Standard",
    flash: 0,
    muteLatch: false,
    gameOverHandled: false
  });
  Object.assign(player, {
    x: WORLD.width / 2,
    y: WORLD.height / 2,
    vx: 0,
    vy: 0,
    health: 120,
    maxHealth: 120,
    armor: 0,
    speed: 360,
    dash: 1,
    dashCooldown: 0,
    invulnerable: 1.2,
    damage: 18,
    damageBonus: 0,
    fireRate: 0.16,
    projectileSpeed: 820,
    multiShot: 1,
    magnet: 150,
    relic: 0,
    relicMax: 100,
    crit: 0.08,
    regen: 0,
    shield: 0,
    overcharge: 0,
    statusPower: 1,
    explosionRadius: 86,
    chainTargets: 1,
    weapon: "thorn-smg",
    armorSuit: "ritual-fleece"
  });
  applyMetaUpgrades();
  applyPermanentPowers();
  equipWeapon(selectedLoadout.weapon);
  equipArmor(selectedLoadout.armor);
  applyStartingPerk(selectedLoadout.perk);
  applyRunProfile();
  for (const list of Object.values(pools)) list.length = 0;
  for (let i = 0; i < 30; i += 1) spawnPickup(rand(240, WORLD.width - 240), rand(220, WORLD.height - 220), "bread", 1);
  overlay.classList.add("is-hidden");
  services.resetClaimState("Finish this run to create a Discord bread claim.");
  beginWaveVariation(1);
  updateSidebar();
  announce("Wave 1: keep the fur attached.", "#d7ff91");
  showToast("Run profile", `${state.runModifiers.map((item) => item.name).join(" + ")}. ${state.enemyBias.name}.`, "epic");
  audio.ensure();
  audio.wave();
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(180, Math.floor(rect.height || rect.width * 9 / 16));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  VIEW.width = width;
  VIEW.height = height;
}

function screenToWorld(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = event.clientX - rect.left;
  pointer.y = event.clientY - rect.top;
  pointer.worldX = pointer.x + camera.x;
  pointer.worldY = pointer.y + camera.y;
}

function chooseEnemyAffix(type, profile = difficultyProfile()) {
  if (["fragment", "boss", "miniboss", "superboss"].includes(type)) return null;
  const event = currentWaveEvent();
  let chance = 0.035 + Math.min(0.28, Math.max(0, state.wave - 6) * 0.012) + profile.doom * 0.006;
  if (event?.id === "elite") chance += 0.16;
  if (state.runModifiers.some((modifier) => modifier.id === "bloodmoon")) chance += 0.08;
  if (Math.random() > chance) return null;
  return ENEMY_AFFIXES[Math.floor(rand(0, ENEMY_AFFIXES.length))] || null;
}

function spawnEnemy(type = "mite") {
  const spec = enemyTypes[type] || enemyTypes.mite;
  const profile = difficultyProfile();
  const healthScale = profile.healthScale * (state.practice ? 0.78 : 1);
  const speedScale = profile.speedScale;
  const damageScale = profile.damageScale;
  const side = Math.floor(rand(0, 4));
  let x = 0;
  let y = 0;
  if (side === 0) {
    x = rand(120, WORLD.width - 120);
    y = -80;
  } else if (side === 1) {
    x = WORLD.width + 80;
    y = rand(120, WORLD.height - 120);
  } else if (side === 2) {
    x = rand(120, WORLD.width - 120);
    y = WORLD.height + 80;
  } else {
    x = -80;
    y = rand(120, WORLD.height - 120);
  }
  const elite = !["fragment", "boss", "miniboss", "superboss"].includes(type) && Math.random() < profile.eliteChance;
  const affix = chooseEnemyAffix(type, profile);
  const affixId = affix?.id || "";
  const affixHealth = affixId === "armored" ? 1.26 : affixId === "regenerating" ? 1.14 : 1;
  const affixSpeed = affixId === "swift" ? 1.34 : affixId === "vicious" ? 1.08 : 1;
  const affixDamage = affixId === "vicious" ? 1.28 : affixId === "volatile" ? 1.12 : 1;
  const affixValue = affix ? 1.38 : 1;
  const baseShield = (spec.shield || 0) * healthScale * (elite ? 1.35 : 1);
  const shield = baseShield + (affixId === "armored" ? spec.hp * healthScale * 0.55 : 0);
  pools.enemies.push({
    type,
    elite,
    x,
    y,
    vx: 0,
    vy: 0,
    affix: affixId,
    affixName: affix?.name || "",
    affixColor: affix?.color || "",
    hp: spec.hp * healthScale * (elite ? 1.7 : 1) * affixHealth,
    maxHp: spec.hp * healthScale * (elite ? 1.7 : 1) * affixHealth,
    shield,
    maxShield: shield,
    speed: spec.speed * speedScale * (elite ? 1.08 : 1) * affixSpeed,
    radius: spec.radius * (elite ? 1.12 : 1),
    damage: spec.damage * damageScale * (elite ? 1.18 : 1) * affixDamage,
    value: Math.floor(spec.value * (elite ? 2.2 : 1) * affixValue),
    color: spec.color,
    hitFlash: 0,
    attackCooldown: 0,
    specialCooldown: rand(1.2, 3.4) * profile.specialCooldownMultiplier,
    beamCooldown: rand(1.8, 3.4) * profile.specialCooldownMultiplier,
    phaseIndex: 0,
    state: "idle",
    stateTimer: 0,
    chargeX: 0,
    chargeY: 0,
    phase: rand(0, Math.PI * 2)
  });
}

function spawnEnemyShot(x, y, angle, speed = 360, damage = 10, color = "#c68cff", radius = 8) {
  pools.enemyShots.push({
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius,
    damage,
    color,
    life: 3.2
  });
}

function spawnPickup(x, y, type = "bread", amount = 1) {
  const pickupRadii = {
    bread: 10,
    relic: 13,
    heart: 14,
    shield: 14,
    overcharge: 15
  };
  pools.pickups.push({
    x,
    y,
    vx: rand(-40, 40),
    vy: rand(-40, 40),
    type,
    amount,
    radius: pickupRadii[type] || 10,
    life: 30,
    phase: rand(0, Math.PI * 2)
  });
}

function spawnHazard() {
  const profile = difficultyProfile();
  pools.hazards.push({
    x: rand(260, WORLD.width - 260),
    y: rand(240, WORLD.height - 240),
    radius: rand(48, 82 + profile.threat * 3.2),
    life: rand(6.2, 10.5),
    pulse: rand(0, Math.PI * 2)
  });
}

function fireProjectile() {
  if (state.fireCooldown > 0 || state.mode !== "playing") return;
  const weapon = currentWeapon();
  const dx = pointer.worldX - player.x;
  const dy = pointer.worldY - player.y;
  const angle = Math.atan2(dy, dx);
  const count = player.multiShot;
  const spreadPenalty = state.flags.has("wild-spread") ? 2.35 : 1;
  const spread = (count === 1 ? weapon.spread : weapon.spread + count * 0.012) * spreadPenalty;
  const damageMultiplier = player.overcharge > 0 ? 1.45 : 1;
  for (let i = 0; i < count; i += 1) {
    const offset = (i - (count - 1) / 2) * spread;
    const a = angle + offset + rand(-weapon.spread, weapon.spread) * 0.22;
    const crit = Math.random() < player.crit;
    pools.projectiles.push({
      x: player.x + Math.cos(a) * 34,
      y: player.y + Math.sin(a) * 34,
      vx: Math.cos(a) * player.projectileSpeed,
      vy: Math.sin(a) * player.projectileSpeed,
      radius: weapon.radius + (crit ? 2 : 0),
      damage: player.damage * damageMultiplier * (crit ? 2.15 : 1),
      life: weapon.life,
      crit,
      pierce: (weapon.pierce || 0) + (crit ? 1 : 0) + (state.flags.has("piercing-shots") ? 1 : 0),
      tags: weapon.tags,
      color: weapon.color,
      explosionRadius: weapon.explosionRadius || player.explosionRadius,
      knockback: ((weapon.tags.includes("knockback") ? 1.9 : 1) + (state.flags.has("heavy-barrel") ? 0.45 : 0)) * runMultiplier("knockback")
    });
  }
  state.fireCooldown = Math.max(0.06, player.fireRate);
  camera.trauma = Math.max(camera.trauma, weapon.recoil);
  audio.shoot();
}

function relicBurst() {
  if (player.relic < player.relicMax || state.relicCooldown > 0 || state.mode !== "playing") return;
  player.relic = 0;
  state.relicCooldown = 1.2;
  if (state.flags.has("relic-capacitor")) player.overcharge = Math.max(player.overcharge, 4.5);
  state.flash = 0.38;
  camera.trauma = Math.max(camera.trauma, 0.42);
  showEvent("Relic burst", "The creature objected loudly", "legendary");
  audio.relic();
  const radius = 260 + (100 - player.relicMax) * 3;
  for (const enemy of pools.enemies) {
    const d = Math.sqrt(distanceSq(player, enemy));
    if (d < radius) {
      const damage = 130 + state.wave * 16;
      damageEnemy(enemy, damage);
      const push = (radius - d) / radius * 380;
      const nx = (enemy.x - player.x) / Math.max(1, d);
      const ny = (enemy.y - player.y) / Math.max(1, d);
      enemy.vx += nx * push;
      enemy.vy += ny * push;
      floatingText(enemy.x, enemy.y - enemy.radius, "RELIC", "#9cff74");
    }
  }
  for (let i = 0; i < 70; i += 1) {
    const angle = rand(0, Math.PI * 2);
    const speed = rand(160, 720);
    particle(player.x, player.y, Math.cos(angle) * speed, Math.sin(angle) * speed, rand(0.45, 1.1), "#89ff6f", rand(2, 7));
  }
}

function particle(x, y, vx, vy, life, color, size = 3) {
  if (pools.particles.length > DIFFICULTY_MODEL.maxParticles) pools.particles.splice(0, pools.particles.length - DIFFICULTY_MODEL.maxParticles);
  pools.particles.push({ x, y, vx, vy, life, maxLife: life, color, size });
}

function floatingText(x, y, text, color = "#f3fff1") {
  if (pools.texts.length > DIFFICULTY_MODEL.maxFloatingTexts) pools.texts.splice(0, pools.texts.length - DIFFICULTY_MODEL.maxFloatingTexts);
  pools.texts.push({ x, y, text, color, life: 1.1, maxLife: 1.1 });
}

function announce(text, color = "#f3fff1") {
  floatingText(player.x, player.y - 70, text, color);
  statusText.textContent = text;
}

function rarityLabel(rarity = "common") {
  return {
    common: "Common",
    rare: "Rare",
    epic: "Epic",
    legendary: "Legendary"
  }[rarity] || "Common";
}

function showToast(title, detail, tone = "common") {
  if (!toastLayer) return;
  const toast = document.createElement("div");
  toast.className = `relic-toast rarity-${tone}`;
  toast.innerHTML = `<strong>${safeName(title)}</strong><span>${escapeHtml(detail)}</span>`;
  toastLayer.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 260);
  }, 3400);
}

function showEvent(kicker, title, tone = "rare") {
  if (!eventBanner || !eventKicker || !eventTitle) return;
  eventKicker.textContent = kicker;
  eventTitle.textContent = title;
  eventBanner.className = `relic-event-banner rarity-${tone}`;
  eventBanner.hidden = false;
  window.clearTimeout(showEvent.timer);
  showEvent.timer = window.setTimeout(() => {
    eventBanner.hidden = true;
  }, 2200);
}

function chooseUpgradeOptions() {
  const rarityScore = { common: 1, rare: 2, epic: 3, legendary: 4 };
  const rewardLift = Math.max(0, (state.nextRewardBoost || 1) - 1) + (state.skippedRewards || 0) * 0.18;
  return [...upgrades]
    .filter((upgrade) => !upgrade.id.startsWith("weapon-") || upgrade.id !== `weapon-${player.weapon}`)
    .filter((upgrade) => !upgrade.id.startsWith("armor-") || upgrade.id !== `armor-${player.armorSuit}`)
    .sort(() => Math.random() - 0.5)
    .map((upgrade) => {
      const rarity = rarityScore[upgrade.rarity] || 1;
      const lateWaveLift = Math.min(0.72, state.wave / 22);
      const buildMatch = upgrade.type === "Synergy" ? 0.14 : upgrade.type === "Weapon upgrade" || upgrade.type === "Armor upgrade" ? 0.08 : 0;
      return { upgrade, roll: Math.random() + buildMatch + lateWaveLift * (rarity - 1) * 0.24 + rewardLift * (rarity - 1) * 0.34 };
    })
    .sort((a, b) => b.roll - a.roll)
    .slice(0, 3)
    .map((entry) => entry.upgrade);
}

function openUpgradeModal() {
  if (state.mode === "upgrade" || state.upgradePending) return;
  state.upgradePending = true;
  state.mode = "upgrade";
  const options = chooseUpgradeOptions();
  const rewardButtons = options.map((upgrade, index) => `
    <button type="button" class="rarity-${upgrade.rarity || "common"}" data-upgrade="${upgrade.id}" value="${index}">
      <span>${safeName(upgrade.type || "Relic")} · ${rarityLabel(upgrade.rarity)}</span>
      <b>${upgrade.name}</b>
      <small>${escapeHtml(upgrade.description)}</small>
    </button>
  `).join("");
  upgradeGrid.innerHTML = `${rewardButtons}
    <button type="button" class="rarity-legendary" data-run-choice="skip-reward">
      <span>Risk Contract · Future Reward</span>
      <b>Skip This Relic</b>
      <small>Take no upgrade now. The next wave gets nastier, but the following relic choices roll hotter.</small>
    </button>`;
  showEvent("Choose a relic", "The den offers three bad ideas", "epic");
  upgradeModal.showModal();
}

function applyUpgrade(upgradeId) {
  const upgrade = upgrades.find((item) => item.id === upgradeId);
  if (!upgrade) return;
  upgrade.apply();
  state.upgrades.push(upgrade.name);
  state.nextRewardBoost = 1;
  state.skippedRewards = 0;
  state.flags.delete("risk-contract-active");
  state.mode = "playing";
  state.wave += 1;
  state.waveTimer = 0;
  state.spawnTimer = 0;
  state.bossSpawned = false;
  state.escalationTimer = 0;
  state.waveClearing = false;
  state.upgradePending = false;
  state.waveDamageTaken = 0;
  upgradeModal.close();
  beginWaveVariation(state.wave);
  updateSidebar();
  announce(`Wave ${state.wave}: ${upgrade.name}`, "#d7ff91");
  showToast("Relic equipped", upgrade.name, upgrade.rarity || "rare");
  audio.upgrade();
}

function skipUpgradeReward() {
  state.skippedRewards += 1;
  state.nextRewardBoost = Math.max(state.nextRewardBoost || 1, 1.3 + state.skippedRewards * 0.22);
  state.flags.add("risk-contract-active");
  state.mode = "playing";
  state.wave += 1;
  state.waveTimer = 0;
  state.spawnTimer = 0;
  state.bossSpawned = false;
  state.escalationTimer = 0;
  state.waveClearing = false;
  state.upgradePending = false;
  state.waveDamageTaken = 0;
  upgradeModal.close();
  beginWaveVariation(state.wave);
  updateSidebar();
  announce(`Wave ${state.wave}: risk contract`, "#fff29b");
  showToast("Risk contract signed", "No relic now. Next reward odds improve, but the den gets meaner.", "legendary");
  audio.wave();
}

function update(dt) {
  if (keys.has("m")) {
    if (!state.muteLatch) {
      audio.enabled = !audio.enabled;
      state.muteLatch = true;
      announce(audio.enabled ? "Audio on." : "Audio muted.", "#d7ff91");
    }
  } else {
    state.muteLatch = false;
  }

  if (keys.has("p") || keys.has("escape")) {
    if (!state.pauseLatch && state.mode === "playing") {
      state.mode = "paused";
      overlay.classList.remove("is-hidden");
      overlay.querySelector("h2").textContent = "Paused.";
      overlay.querySelector("span").textContent = "Press P again when the creature is ready.";
    } else if (!state.pauseLatch && state.mode === "paused") {
      state.mode = "playing";
      overlay.classList.add("is-hidden");
    }
    state.pauseLatch = true;
  } else {
    state.pauseLatch = false;
  }

  if (state.mode !== "playing") return;

  state.time += dt;
  state.waveTimer += dt;
  state.spawnTimer -= dt;
  state.fireCooldown -= dt;
  state.relicCooldown -= dt;
  state.flash = Math.max(0, state.flash - dt);
  player.overcharge = Math.max(0, player.overcharge - dt);
  if (state.flags.has("greed-spiral") && player.shield > 0) {
    player.shield = Math.max(0, player.shield - dt * (2 + state.wave * 0.18));
  }
  const profile = difficultyProfile();
  if (profile.doom > 0 && player.shield > 0) {
    player.shield = Math.max(0, player.shield - dt * profile.doom * 0.34);
  }
  player.dashCooldown -= dt;
  player.invulnerable -= dt;
  if (player.regen > 0 && player.invulnerable <= 0 && player.health > 0) {
    player.health = Math.min(player.maxHealth, player.health + player.regen * dt);
  }
  state.comboTimer -= dt;
  if (state.comboTimer <= 0) state.combo = 1;

  updatePlayer(dt);
  updateWave(dt);
  updateEnemies(dt);
  updateProjectiles(dt);
  updateEnemyShots(dt);
  updatePickups(dt);
  updateHazards(dt);
  updateParticles(dt);
  checkMilestones();
  updateCamera(dt);
  updateHud();

  if (player.health <= 0 && !state.gameOverHandled) endRun();
}

function updatePlayer(dt) {
  let ax = 0;
  let ay = 0;
  let padDash = false;
  if (keys.has("w") || keys.has("arrowup")) ay -= 1;
  if (keys.has("s") || keys.has("arrowdown")) ay += 1;
  if (keys.has("a") || keys.has("arrowleft")) ax -= 1;
  if (keys.has("d") || keys.has("arrowright")) ax += 1;
  const pad = navigator.getGamepads?.()[0];
  if (pad) {
    const gx = Math.abs(pad.axes[0] || 0) > 0.18 ? pad.axes[0] : 0;
    const gy = Math.abs(pad.axes[1] || 0) > 0.18 ? pad.axes[1] : 0;
    if (gx || gy) {
      ax = gx;
      ay = gy;
    }
    const aimX = Math.abs(pad.axes[2] || 0) > 0.18 ? pad.axes[2] : 0;
    const aimY = Math.abs(pad.axes[3] || 0) > 0.18 ? pad.axes[3] : 0;
    if (aimX || aimY) {
      pointer.worldX = player.x + aimX * 240;
      pointer.worldY = player.y + aimY * 240;
      if (pad.buttons[7]?.pressed || pad.buttons[0]?.pressed) fireProjectile();
    }
    padDash = Boolean(pad.buttons[1]?.pressed);
    if (pad.buttons[2]?.pressed) relicBurst();
  }
  const length = Math.hypot(ax, ay) || 1;
  ax /= length;
  ay /= length;

  if ((keys.has(" ") || keys.has("shift") || padDash) && player.dashCooldown <= 0 && (ax || ay)) {
    player.vx += ax * 880;
    player.vy += ay * 880;
    player.invulnerable = state.flags.has("dash-core") ? 0.34 : 0.24;
    player.dashCooldown = Math.max(0.28, (state.flags.has("dash-core") ? 0.76 : 0.9) - player.dash * 0.08);
    camera.trauma = Math.max(camera.trauma, 0.18);
    for (let i = 0; i < 18; i += 1) particle(player.x, player.y, rand(-180, 180), rand(-180, 180), rand(0.25, 0.52), "#f4fff1", rand(2, 5));
  }

  const targetVx = ax * player.speed;
  const targetVy = ay * player.speed;
  player.vx += (targetVx - player.vx) * Math.min(1, dt * 9);
  player.vy += (targetVy - player.vy) * Math.min(1, dt * 9);
  player.x = clamp(player.x + player.vx * dt, 70, WORLD.width - 70);
  player.y = clamp(player.y + player.vy * dt, 70, WORLD.height - 70);

  if (pointer.down) fireProjectile();
  if (keys.has("q")) relicBurst();
}

function weightedEnemyType(profile = difficultyProfile()) {
  const wave = profile.wave;
  const pressure = lateWavePressure(wave);
  const event = currentWaveEvent(wave);
  const biasTypes = new Set(state.enemyBias?.boost || []);
  const eventBoosts = {
    ambush: new Set(["wisp", "skitter", "charger", "splitter"]),
    elite: new Set(["brute", "guardian", "bulwark", "healer", "buffer"]),
    bonus: new Set(["mite", "wisp", "splitter"]),
    chaos: new Set(["phantom", "bombardier", "mine", "sniper"])
  }[event?.id] || new Set();
  const weights = [
    ["mite", 28],
    ["wisp", wave >= 2 ? 12 + pressure * 0.7 : 0],
    ["brute", wave >= 3 ? 12 + wave * 0.35 : 0],
    ["spitter", wave >= 4 ? 10 + pressure * 0.9 : 0],
    ["charger", wave >= 5 ? 8 + pressure * 1.0 : 0],
    ["splitter", wave >= 6 ? 7 + pressure * 0.7 : 0],
    ["guardian", wave >= 7 ? 5 + pressure * 0.75 : 0],
    ["healer", wave >= 8 ? 4 + pressure * 0.55 : 0],
    ["mine", wave >= 9 ? 5 + pressure * 0.65 : 0],
    ["skitter", wave >= 10 ? 12 + pressure * 1.2 : 0],
    ["bulwark", wave >= 12 ? 5 + pressure * 0.7 : 0],
    ["sniper", wave >= 13 ? 6 + pressure * 0.9 : 0],
    ["buffer", wave >= 15 ? 4 + pressure * 0.65 : 0],
    ["bombardier", wave >= 16 ? 5 + pressure * 0.75 : 0],
    ["leech", wave >= 18 ? 5 + pressure * 0.65 : 0],
    ["phantom", wave >= 20 ? 5 + pressure * 0.62 : 0]
  ].map(([type, weight]) => [
    type,
    weight * (biasTypes.has(type) ? 1.65 : 1) * (eventBoosts.has(type) ? 1.45 : 1)
  ]);
  const total = weights.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  let roll = Math.random() * total;
  for (const [type, weight] of weights) {
    roll -= Math.max(0, weight);
    if (roll <= 0) return type;
  }
  return "mite";
}

function updateWave(dt) {
  waveEventFor(state.wave);
  const profile = difficultyProfile();
  const pressure = lateWavePressure();
  const waveLength = profile.waveLength;
  state.difficulty = (state.practice ? 0.78 : 1) * profile.threat;
  state.biome = state.wave > 8 ? "Broken Archive" : state.wave > 4 ? "Green Furnace" : "Outer Den";
  state.roundModifier = profile.modifier.name;
  if (state.waveTimer < 0.2 && !state.waveClearing && !state.milestones.has(`wave-start-${state.wave}`)) {
    state.milestones.add(`wave-start-${state.wave}`);
    showEvent(`Wave ${state.wave}`, profile.modifier.name, state.wave >= 12 ? "legendary" : state.wave >= 6 ? "epic" : "rare");
    showToast(profile.modifier.name, profile.modifier.detail, state.wave >= 12 ? "legendary" : "rare");
  }
  if (!state.waveClearing && state.waveTimer >= waveLength) {
    state.waveClearing = true;
    state.spawnTimer = 999;
    announce(`Wave ${state.wave} clearing: finish the leftovers.`, "#d7ff91");
    showEvent("Wave clearing", `Finish ${pools.enemies.length} leftovers`, "rare");
  }
  const enemyCap = profile.enemyCap;
  if (!state.waveClearing && state.spawnTimer <= 0 && pools.enemies.length < enemyCap) {
    const burst = Math.min(profile.burstCount + (Math.random() < profile.extraSpawnChance ? 1 : 0), Math.max(1, enemyCap - pools.enemies.length));
    for (let i = 0; i < burst; i += 1) spawnEnemy(weightedEnemyType(profile));
    if (state.wave > 8 && Math.random() < profile.supportChance) spawnEnemy(Math.random() < 0.48 ? "healer" : Math.random() < 0.72 ? "buffer" : "spitter");
    if (state.wave > 14 && Math.random() < 0.16 + pressure * 0.035) spawnEnemy(Math.random() < 0.45 ? "charger" : Math.random() < 0.72 ? "skitter" : "splitter");
    if (state.wave > 22 && Math.random() < 0.08 + profile.doom * 0.012) spawnEnemy(Math.random() < 0.5 ? "phantom" : "leech");
    state.spawnTimer = profile.spawnInterval / Math.max(0.78, state.difficulty);
  }
  if (state.wave > 2 && Math.random() < dt * profile.hazardRate) spawnHazard();
  if (state.wave > 13 && Math.random() < dt * (pressure * 0.025 + profile.doom * 0.018)) spawnHazard();
  if (state.wave >= 9 && !state.waveClearing && state.waveTimer > waveLength * 0.52 && !state.milestones.has(`skill-check-${state.wave}`)) {
    state.milestones.add(`skill-check-${state.wave}`);
    showEvent("Skill check", state.wave >= 18 ? "Mixed elites incoming" : "Hazard burst incoming", state.wave >= 14 ? "legendary" : "epic");
    showToast("Skill check", "Move cleanly. Damage now costs bonus bread.", "epic");
    for (let i = 0; i < 2 + Math.floor(state.wave / 4) + Math.floor(profile.doom / 2); i += 1) spawnHazard();
    if (state.wave >= 18) {
      for (let i = 0; i < Math.max(2, Math.floor(profile.chaos)); i += 1) spawnEnemy(i % 2 ? "sniper" : "skitter");
    }
    camera.trauma = Math.max(camera.trauma, 0.24);
    audio.wave();
  }
  if (state.wave >= 15 && state.wave % 15 === 0 && !state.bossSpawned && state.waveTimer > 6) {
    spawnEnemy("superboss");
    const superBoss = pools.enemies[pools.enemies.length - 1];
    superBoss.x = WORLD.width / 2 + rand(-120, 120);
    superBoss.y = -120;
    superBoss.vy = 160;
    superBoss.specialCooldown = 1.2;
    superBoss.beamCooldown = 2.4;
    state.bossSpawned = true;
    state.bossAttackTimer = 1.2;
    state.flash = Math.max(state.flash, 0.42);
    announce("SUPER BOSS: The Grand Antler Auditor has arrived.", "#9cff74");
    showEvent("Super Boss", "Grand Antler Auditor protocol", "legendary");
    showToast("Super Boss every 15 waves", "This one has shields, phase spikes, summons, and deeply personal bullet patterns.", "legendary");
    for (let i = 0; i < 4 + Math.floor(state.wave / 15); i += 1) spawnHazard();
    camera.trauma = Math.max(camera.trauma, 0.42);
    audio.wave();
  }
  if (state.wave > 3 && state.wave % 3 === 0 && state.wave % 4 !== 0 && !state.bossSpawned && state.waveTimer > 7) {
    for (let i = 0; i < profile.minibossCount; i += 1) spawnEnemy("miniboss");
    state.bossSpawned = true;
    announce("Mini-boss entering the den. Horrible posture.", "#ff9bd6");
    showEvent(profile.minibossCount > 1 ? "Mini-boss pack" : "Mini-boss", "Horrible posture detected", "epic");
    showToast("Mini-boss entered", profile.minibossCount > 1 ? `${profile.minibossCount} problems arrived together.` : "Clear it for stronger drops and essence.", "epic");
    audio.wave();
  }
  if (state.wave % 4 === 0 && !state.bossSpawned && state.waveTimer > 8) {
    for (let i = 0; i < profile.bossCount; i += 1) spawnEnemy("boss");
    if (state.wave >= 20) {
      for (let i = 0; i < Math.floor(profile.bossCount / 2) + 1; i += 1) spawnEnemy("miniboss");
    }
    state.bossSpawned = true;
    state.bossAttackTimer = 2;
    announce("Boss thing detected. Deeply rude.", "#ff9797");
    showEvent(profile.bossCount > 1 ? "Boss convergence" : "Boss wave", "Deeply rude thing detected", "legendary");
    showToast("Boss thing detected", profile.bossCount > 1 ? `${profile.bossCount} boss things. The den made choices.` : "Break it before the arena becomes a problem.", "legendary");
    audio.wave();
  }
  if (state.wave >= 16 && state.bossSpawned && state.waveTimer > waveLength * 0.68 && state.escalationTimer <= 0 && pools.enemies.some((enemy) => enemy.type === "superboss" || enemy.type === "boss" || enemy.type === "miniboss")) {
    state.escalationTimer = 999;
    showEvent("Phase spike", "The boss called friends", "legendary");
    const adds = 2 + Math.floor(state.wave / 5) + Math.floor(profile.doom / 2);
    for (let i = 0; i < adds; i += 1) spawnEnemy(["charger", "spitter", "buffer", "bombardier", "skitter"][i % 5]);
    camera.trauma = Math.max(camera.trauma, 0.28);
  }
  if (state.waveClearing && pools.enemies.length === 0) {
    if (state.waveDamageTaken <= 0) {
      const bonusBread = Math.max(3, Math.floor(state.wave * (state.flags.has("danger-dividend") ? 2.2 : 1.5)));
      const bonusScore = Math.floor((350 + state.wave * (state.flags.has("danger-dividend") ? 130 : 90)) * profile.scoreMultiplier);
      state.bread += bonusBread;
      state.score += bonusScore;
      unlockAchievement("Untouched Fur", "Cleared a wave without taking damage.");
      announce(`Perfect wave: +${bonusBread} bread`, "#fff29b");
      showToast("Perfect wave", `+${bonusBread} bread and +${bonusScore.toLocaleString()} score`, "legendary");
    }
    if (state.wave >= 9 && state.waveDamageTaken > 0) {
      const penalty = Math.min(state.bread, Math.floor(state.waveDamageTaken / (state.flags.has("danger-dividend") ? 15 : 22)));
      if (penalty > 0) {
        state.bread -= penalty;
        showToast("Messy wave penalty", `-${penalty} bread for taking ${Math.ceil(state.waveDamageTaken)} damage`, "epic");
      }
    }
    openUpgradeModal();
  }
}

function awardMilestone(id, title, detail, tone = "rare", apply = () => {}) {
  if (state.milestones.has(id)) return;
  state.milestones.add(id);
  apply();
  showToast(title, detail, tone);
  showEvent(title, detail, tone);
  audio.achievement();
}

function checkMilestones() {
  if (state.wave >= 3) {
    awardMilestone("wave-3", "Den warmed up", "+250 score for reaching wave 3", "rare", () => {
      state.score += 250;
    });
  }
  if (state.wave >= 6) {
    awardMilestone("wave-6", "Green Furnace", "+3 bread and +600 score", "epic", () => {
      state.bread += 3;
      state.score += 600;
    });
  }
  if (state.wave >= 10) {
    awardMilestone("wave-10", "Archive breaker", "+8 bread, +1,200 score, relic overcharge", "legendary", () => {
      state.bread += 8;
      state.score += 1200;
      player.overcharge = Math.max(player.overcharge, 5);
      unlockAchievement("Archive Breaker", "Reached wave 10 in one run.");
    });
  }
  if (state.kills >= 100) {
    awardMilestone("kills-100", "One hundred problems", "+5 bread for cleaning the den", "epic", () => {
      state.bread += 5;
    });
  }
  if (state.score >= 10000) {
    awardMilestone("score-10000", "Score ritual", "Overcharge triggered for big-number behavior", "legendary", () => {
      player.overcharge = Math.max(player.overcharge, 8);
    });
  }
}

function updateEnemies(dt) {
  for (let i = pools.enemies.length - 1; i >= 0; i -= 1) {
    const enemy = pools.enemies[i];
    if (enemy.status) {
      if (enemy.status.poison > 0) {
        enemy.hp -= (7 + state.wave * 0.45) * player.statusPower * dt;
        enemy.status.poison -= dt;
        if (Math.random() < dt * 8) particle(enemy.x, enemy.y, rand(-45, 45), rand(-80, -15), 0.38, "#b7ff4f", 3);
      }
      if (enemy.status.burn > 0) {
        enemy.hp -= (11 + state.wave * 0.35) * player.statusPower * dt;
        enemy.status.burn -= dt;
        if (Math.random() < dt * 10) particle(enemy.x, enemy.y, rand(-55, 55), rand(-90, -20), 0.34, "#ff9b5c", 4);
      }
      if (enemy.status.slow > 0) enemy.status.slow -= dt;
      if (enemy.status.shock > 0) enemy.status.shock -= dt;
    }
    if (enemy.affix === "regenerating" && enemy.hp > 0 && enemy.hp < enemy.maxHp) {
      enemy.hp = Math.min(enemy.maxHp, enemy.hp + (2.8 + state.wave * 0.32) * dt);
      if (Math.random() < dt * 4) particle(enemy.x, enemy.y, rand(-36, 36), rand(-54, -12), 0.38, enemy.affixColor || "#b7ff4f", 3);
    }
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const dist = Math.hypot(dx, dy) || 1;
    const wobble = Math.sin(state.time * 3 + enemy.phase) * (enemy.type === "wisp" ? 0.65 : 0.18);
    const nx = dx / dist;
    const ny = dy / dist;
    const statusSpeed = enemy.status?.slow > 0 ? 0.56 : 1;
    let desireX = nx;
    let desireY = ny;
    if ((enemy.type === "spitter" || enemy.type === "sniper" || enemy.type === "bombardier") && dist < 430) {
      desireX = -nx;
      desireY = -ny;
    }
    if (enemy.type === "phantom") {
      desireX = nx * 0.72 + Math.cos(state.time * 2.6 + enemy.phase) * 0.7;
      desireY = ny * 0.72 + Math.sin(state.time * 2.1 + enemy.phase) * 0.7;
    }
    if (enemy.enraged > 0) enemy.enraged -= dt;
    const rageSpeed = enemy.enraged > 0 ? 1.22 : 1;
    enemy.vx += (desireX * enemy.speed * statusSpeed * rageSpeed - ny * enemy.speed * wobble - enemy.vx) * Math.min(1, dt * 2.8);
    enemy.vy += (desireY * enemy.speed * statusSpeed * rageSpeed + nx * enemy.speed * wobble - enemy.vy) * Math.min(1, dt * 2.8);
    enemy.x += enemy.vx * dt;
    enemy.y += enemy.vy * dt;
    enemy.hitFlash -= dt;
    enemy.attackCooldown -= dt;
    enemy.specialCooldown -= dt;
    enemy.stateTimer -= dt;

    if (enemy.type === "charger") {
      if (enemy.state === "idle" && enemy.specialCooldown <= 0 && dist < 680) {
        enemy.state = "telegraph";
        enemy.stateTimer = 0.72 * difficultyProfile().telegraphMultiplier;
        enemy.chargeX = nx;
        enemy.chargeY = ny;
        enemy.specialCooldown = rand(3.4, 4.7) * difficultyProfile().specialCooldownMultiplier;
        floatingText(enemy.x, enemy.y - enemy.radius - 8, "!", "#ffdf6e");
      } else if (enemy.state === "telegraph" && enemy.stateTimer <= 0) {
        enemy.state = "charging";
        enemy.stateTimer = 0.42 * difficultyProfile().telegraphMultiplier;
        enemy.vx = enemy.chargeX * 780 * difficultyProfile().speedScale;
        enemy.vy = enemy.chargeY * 780 * difficultyProfile().speedScale;
        camera.trauma = Math.max(camera.trauma, 0.12);
      } else if (enemy.state === "charging" && enemy.stateTimer <= 0) {
        enemy.state = "idle";
      }
    }

    if (enemy.type === "mine" && dist < 110 && enemy.specialCooldown <= 0) {
      enemy.hp = 0;
      shockwave(enemy.x, enemy.y, 170, 58);
      for (let p = 0; p < 28; p += 1) particle(enemy.x, enemy.y, rand(-320, 320), rand(-320, 320), rand(0.22, 0.6), enemy.color, rand(3, 8));
      camera.trauma = Math.max(camera.trauma, 0.34);
    }

    if (enemy.type === "spitter" && enemy.specialCooldown <= 0 && dist < 760) {
      const angle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
      const profile = difficultyProfile();
      spawnEnemyShot(enemy.x, enemy.y, angle, (390 + state.wave * 8) * profile.projectileSpeedScale, enemy.damage, enemy.color, 8);
      enemy.specialCooldown = rand(1.4, 2.5) * profile.specialCooldownMultiplier;
      enemy.vx -= nx * 120;
      enemy.vy -= ny * 120;
    }

    if (enemy.type === "sniper" && enemy.specialCooldown <= 0 && dist < 980) {
      const profile = difficultyProfile();
      enemy.state = "aiming";
      enemy.stateTimer = 0.52 * profile.telegraphMultiplier;
      enemy.chargeX = nx;
      enemy.chargeY = ny;
      enemy.specialCooldown = rand(2.2, 3.4) * profile.specialCooldownMultiplier;
      floatingText(enemy.x, enemy.y - enemy.radius - 10, "LINE", "#ffef9b");
    } else if (enemy.type === "sniper" && enemy.state === "aiming" && enemy.stateTimer <= 0) {
      enemy.state = "idle";
      const profile = difficultyProfile();
      const angle = Math.atan2(enemy.chargeY, enemy.chargeX);
      for (let s = -1; s <= 1; s += 1) {
        if (s !== 0 && profile.chaos < 1.7) continue;
        spawnEnemyShot(enemy.x, enemy.y, angle + s * 0.055, 720 * profile.projectileSpeedScale, enemy.damage * 1.12, enemy.color, 7);
      }
      camera.trauma = Math.max(camera.trauma, 0.1);
    }

    if (enemy.type === "bombardier" && enemy.specialCooldown <= 0 && dist < 900) {
      const profile = difficultyProfile();
      pools.hazards.push({
        x: clamp(player.x + rand(-190, 190), 160, WORLD.width - 160),
        y: clamp(player.y + rand(-190, 190), 160, WORLD.height - 160),
        radius: rand(46, 74 + profile.doom * 2),
        life: rand(3.8, 5.6),
        pulse: rand(0, Math.PI * 2)
      });
      enemy.specialCooldown = rand(2.8, 4.1) * profile.specialCooldownMultiplier;
      floatingText(enemy.x, enemy.y - enemy.radius - 10, "LOB", "#ff9b5c");
    }

    if (enemy.type === "guardian" && enemy.specialCooldown <= 0) {
      const profile = difficultyProfile();
      shockwave(enemy.x, enemy.y, 118 + lateWavePressure() * 7, 24 + lateWavePressure() * 4);
      enemy.specialCooldown = rand(4.2, 5.8) * profile.specialCooldownMultiplier;
    }

    if (enemy.type === "healer" && enemy.specialCooldown <= 0) {
      healNearbyEnemies(enemy);
      enemy.specialCooldown = rand(3.2, 4.8) * difficultyProfile().specialCooldownMultiplier;
    }

    if (enemy.type === "buffer" && enemy.specialCooldown <= 0) {
      enrageNearbyEnemies(enemy);
      enemy.specialCooldown = rand(3.1, 4.6) * difficultyProfile().specialCooldownMultiplier;
    }

    if (enemy.type === "leech" && enemy.specialCooldown <= 0 && dist < 150) {
      const drain = (8 + state.wave * 0.55) * difficultyProfile().incomingDamageMultiplier;
      const shieldDrain = Math.min(player.shield, drain * 0.8);
      player.shield -= shieldDrain;
      player.health -= Math.max(0, drain - shieldDrain) * 0.28;
      state.waveDamageTaken += Math.max(0, drain - shieldDrain) * 0.28;
      enemy.hp = Math.min(enemy.maxHp, enemy.hp + drain * 1.1);
      enemy.specialCooldown = rand(1.2, 2) * difficultyProfile().specialCooldownMultiplier;
      floatingText(enemy.x, enemy.y - enemy.radius - 10, "LEECH", "#b06cff");
    }

    if (enemy.type === "phantom" && enemy.specialCooldown <= 0) {
      enemy.phased = 0.82 * difficultyProfile().telegraphMultiplier;
      enemy.specialCooldown = rand(3.4, 5.2) * difficultyProfile().specialCooldownMultiplier;
      floatingText(enemy.x, enemy.y - enemy.radius - 10, "PHASE", "#b7c8ff");
    }
    if (enemy.phased > 0) enemy.phased -= dt;

    if (enemy.type === "miniboss" && enemy.specialCooldown <= 0) {
      miniBossPattern(enemy);
      enemy.specialCooldown = rand(2.4, 3.6) * difficultyProfile().specialCooldownMultiplier;
    }

    if (enemy.type === "boss" && enemy.specialCooldown <= 0) {
      bossPattern(enemy);
      enemy.specialCooldown = Math.max(0.72, (3.4 - state.wave * 0.04) * difficultyProfile().specialCooldownMultiplier);
    }

    if (enemy.type === "superboss") {
      const healthRatio = clamp(enemy.hp / enemy.maxHp, 0, 1);
      const nextPhase = healthRatio < 0.28 ? 3 : healthRatio < 0.55 ? 2 : healthRatio < 0.78 ? 1 : 0;
      if (nextPhase > enemy.phaseIndex) {
        enemy.phaseIndex = nextPhase;
        superBossPhaseSpike(enemy, nextPhase);
      }
      if (enemy.specialCooldown <= 0) {
        superBossPattern(enemy);
        enemy.specialCooldown = Math.max(0.48, (2.55 - enemy.phaseIndex * 0.26 - state.wave * 0.018) * difficultyProfile().specialCooldownMultiplier);
      }
      if (enemy.beamCooldown <= 0) {
        superBossBeam(enemy);
        enemy.beamCooldown = Math.max(1.05, (4.2 - enemy.phaseIndex * 0.38) * difficultyProfile().specialCooldownMultiplier);
      }
    }

    if (dist < enemy.radius + player.radius && enemy.attackCooldown <= 0 && player.invulnerable <= 0) {
      let damage = Math.max(2, enemy.damage * difficultyProfile().incomingDamageMultiplier - player.armor);
      if (state.flags.has("glass-contract")) damage *= 1.22;
      if (player.shield > 0) {
        const shieldBefore = player.shield;
        const blocked = Math.min(player.shield, damage);
        player.shield -= blocked;
        damage -= blocked;
        floatingText(player.x, player.y - 54, `BLOCK ${Math.round(blocked)}`, "#85ffd2");
        if (shieldBefore > 0 && player.shield <= 0 && state.flags.has("reactive-armor")) shockwave(player.x, player.y, 185, 42 + state.wave * 2);
      }
      player.health -= damage;
      state.waveDamageTaken += damage;
      player.invulnerable = 0.3;
      enemy.attackCooldown = Math.max(0.32, 0.62 * difficultyProfile().specialCooldownMultiplier);
      camera.trauma = Math.max(camera.trauma, 0.32);
      audio.hit();
      if (state.flags.has("hit-ward")) shockwave(player.x, player.y, 130, 18 + state.wave * 2);
      if (damage > 0) floatingText(player.x, player.y - 34, `-${Math.round(damage)}`, "#ff9b9b");
      for (let p = 0; p < 16; p += 1) particle(player.x, player.y, rand(-260, 260), rand(-260, 260), rand(0.25, 0.55), "#ff7373", rand(2, 6));
    }

    if (enemy.hp <= 0) killEnemy(enemy, i);
  }
}

function bossPattern(enemy) {
  const base = Math.atan2(player.y - enemy.y, player.x - enemy.x);
  const pressure = lateWavePressure();
  const profile = difficultyProfile();
  const count = Math.floor(10 + state.wave * 0.72 + pressure * 3.2 * profile.bossPatternScale);
  for (let i = 0; i < count; i += 1) {
    const angle = base + (i - count / 2) * Math.max(0.055, 0.18 - pressure * 0.006);
    spawnEnemyShot(enemy.x, enemy.y, angle, (285 + state.wave * 9 + pressure * 18) * profile.projectileSpeedScale, enemy.damage * 0.72, "#ff8f8f", 10 + pressure * 0.35);
  }
  if (Math.random() < 0.55 + pressure * 0.045) {
    pools.hazards.push({
      x: clamp(player.x + rand(-160, 160), 180, WORLD.width - 180),
      y: clamp(player.y + rand(-160, 160), 180, WORLD.height - 180),
      radius: rand(74, 112 + pressure * 8),
      life: rand(4.2, 6.2 + pressure * 0.35),
      pulse: rand(0, Math.PI * 2)
    });
  }
  if (!state.waveClearing && pressure > 1.1 && Math.random() < 0.38 + profile.doom * 0.018) {
    spawnEnemy(["healer", "charger", "buffer", "sniper"][Math.floor(rand(0, 4))]);
  }
  camera.trauma = Math.max(camera.trauma, 0.16);
}

function superBossPattern(enemy) {
  const profile = difficultyProfile();
  const pressure = lateWavePressure();
  const phase = enemy.phaseIndex || 0;
  const base = Math.atan2(player.y - enemy.y, player.x - enemy.x);
  const ringCount = 18 + phase * 7 + Math.floor(state.wave / 10) + Math.floor(pressure * 2.4);
  const ringOffset = state.time * (0.45 + phase * 0.16);
  for (let i = 0; i < ringCount; i += 1) {
    const angle = ringOffset + i * Math.PI * 2 / ringCount;
    spawnEnemyShot(enemy.x, enemy.y, angle, (235 + phase * 42 + pressure * 13) * profile.projectileSpeedScale, enemy.damage * 0.5, "#9cff74", 8 + phase);
  }
  const aimedCount = 3 + phase;
  for (let i = 0; i < aimedCount; i += 1) {
    const angle = base + (i - (aimedCount - 1) / 2) * 0.12;
    spawnEnemyShot(enemy.x, enemy.y, angle, (470 + phase * 54 + state.wave * 4) * profile.projectileSpeedScale, enemy.damage * 0.82, "#fff29b", 9 + phase * 0.7);
  }
  if (!state.waveClearing) {
    const addTypes = phase >= 2 ? ["bulwark", "sniper", "buffer", "charger"] : ["spitter", "charger", "skitter", "mine"];
    const addCount = 1 + phase + Math.floor(Math.max(0, state.wave - 15) / 30);
    for (let i = 0; i < addCount; i += 1) spawnEnemy(addTypes[(i + Math.floor(rand(0, addTypes.length))) % addTypes.length]);
  }
  if (Math.random() < 0.72) {
    pools.hazards.push({
      x: clamp(player.x + rand(-220, 220), 180, WORLD.width - 180),
      y: clamp(player.y + rand(-220, 220), 180, WORLD.height - 180),
      radius: rand(86, 132 + phase * 18 + pressure * 6),
      life: rand(4.2, 6.4 + phase * 0.35),
      pulse: rand(0, Math.PI * 2)
    });
  }
  camera.trauma = Math.max(camera.trauma, 0.2 + phase * 0.04);
}

function superBossBeam(enemy) {
  const profile = difficultyProfile();
  const base = Math.atan2(player.y - enemy.y, player.x - enemy.x);
  floatingText(enemy.x, enemy.y - enemy.radius - 12, "ANTLER LOCK", "#fff29b");
  const lanes = 5 + (enemy.phaseIndex || 0) * 2;
  for (let i = 0; i < lanes; i += 1) {
    const angle = base + (i - (lanes - 1) / 2) * 0.075;
    spawnEnemyShot(enemy.x, enemy.y, angle, 760 * profile.projectileSpeedScale, enemy.damage * 0.95, "#fff29b", 7);
  }
  shockwave(enemy.x, enemy.y, 148 + (enemy.phaseIndex || 0) * 26, 18 + state.wave * 0.9);
  camera.trauma = Math.max(camera.trauma, 0.26);
}

function superBossPhaseSpike(enemy, phase) {
  enemy.shield = Math.max(enemy.shield || 0, 180 + phase * 95 + state.wave * 7);
  enemy.maxShield = Math.max(enemy.maxShield || 0, enemy.shield);
  floatingText(enemy.x, enemy.y - enemy.radius - 18, `PHASE ${phase + 1}`, "#9cff74");
  showEvent("Super Boss phase", phase >= 3 ? "Final antler judgment" : "The auditor adapts", "legendary");
  showToast("Super Boss phase shift", "Shield restored, adds incoming, safe space officially reduced.", "legendary");
  for (let i = 0; i < 3 + phase * 2; i += 1) spawnHazard();
  for (let i = 0; i < 2 + phase; i += 1) spawnEnemy(["healer", "buffer", "bulwark", "sniper", "charger"][i % 5]);
  camera.trauma = Math.max(camera.trauma, 0.46);
  state.flash = Math.max(state.flash, 0.32);
}

function miniBossPattern(enemy) {
  const base = Math.atan2(player.y - enemy.y, player.x - enemy.x);
  const pressure = lateWavePressure();
  const profile = difficultyProfile();
  const count = 7 + Math.floor(pressure * 1.45 * profile.bossPatternScale);
  for (let i = 0; i < count; i += 1) {
    const angle = base + (i - (count - 1) / 2) * 0.24;
    spawnEnemyShot(enemy.x, enemy.y, angle, (330 + state.wave * 6 + pressure * 14) * profile.projectileSpeedScale, enemy.damage * 0.74, "#ff8fd8", 9 + pressure * 0.24);
  }
  if (!state.waveClearing && Math.random() < 0.5 + pressure * 0.08) {
    spawnEnemy(Math.random() < 0.35 ? "charger" : Math.random() < 0.58 ? "spitter" : Math.random() < 0.78 ? "splitter" : "skitter");
  }
  camera.trauma = Math.max(camera.trauma, 0.14);
}

function healNearbyEnemies(source) {
  let healed = 0;
  const pressure = lateWavePressure();
  for (const enemy of pools.enemies) {
    if (enemy === source || enemy.hp <= 0 || enemy.hp >= enemy.maxHp) continue;
    if (distanceSq(source, enemy) > (240 + pressure * 18) ** 2) continue;
    enemy.hp = Math.min(enemy.maxHp, enemy.hp + 34 + state.wave * 3 + pressure * 12);
    enemy.hitFlash = 0.1;
    healed += 1;
    particle(enemy.x, enemy.y, rand(-50, 50), rand(-90, -20), 0.55, "#ff8fd8", 4);
  }
  if (healed) {
    floatingText(source.x, source.y - source.radius - 10, `HEAL x${healed}`, "#ff8fd8");
  }
}

function enrageNearbyEnemies(source) {
  let buffed = 0;
  const pressure = lateWavePressure();
  for (const enemy of pools.enemies) {
    if (enemy === source || enemy.hp <= 0) continue;
    if (distanceSq(source, enemy) > (260 + pressure * 16) ** 2) continue;
    enemy.enraged = Math.max(enemy.enraged || 0, 4.2 + pressure * 0.18);
    enemy.hitFlash = 0.08;
    buffed += 1;
    particle(enemy.x, enemy.y, rand(-60, 60), rand(-90, -20), 0.5, "#ffb3f3", 4);
  }
  if (buffed) floatingText(source.x, source.y - source.radius - 10, `RAGE x${buffed}`, "#ffb3f3");
}

function killEnemy(enemy, index) {
  pools.enemies.splice(index, 1);
  state.kills += 1;
  state.combo = clamp(state.combo + 0.08, 1, 4);
  state.comboTimer = 2.5;
  const scoreGain = Math.floor(enemy.value * state.combo * difficultyProfile().scoreMultiplier * (state.flags.has("glass-contract") ? 1.18 : 1) * (state.flags.has("black-horn-doctrine") ? 1.08 : 1));
  state.score += scoreGain;
  const relicGain = enemy.type === "superboss" ? 60 : enemy.type === "boss" ? 32 : enemy.type === "miniboss" ? 22 : 8;
  player.relic = clamp(player.relic + relicGain * (state.flags.has("relic-capacitor") ? 1.22 : 1) * runMultiplier("relic"), 0, player.relicMax);
  if (state.kills === 25) unlockAchievement("First Furstorm", "25 curse-things removed.");
  if (state.combo >= 3) unlockAchievement("Combo Creature", "Reached a 3x score chain.");
  if (enemy.type === "boss") unlockAchievement("Boss Handler", "Defeated a boss wave.");
  if (enemy.type === "superboss") unlockAchievement("Grand Auditor Defeated", "Defeated a super boss wave.");
  if (enemy.type === "miniboss") unlockAchievement("Mini Problem", "Defeated a mini-boss.");
  audio.pickup();
  floatingText(enemy.x, enemy.y - enemy.radius, `+${scoreGain}`, enemy.color);
  const breadDrops = Math.ceil((enemy.type === "superboss" ? 18 : enemy.type === "boss" ? 10 : enemy.type === "miniboss" ? 7 : enemy.type === "brute" || enemy.type === "guardian" ? 3 : 1) * (state.flags.has("greed-spiral") ? 1.28 : 1) * (state.flags.has("starter-bread-magnet") ? 1.08 : 1) * runMultiplier("bread") * (currentMutator("greedy-cache") ? 1.35 : 1));
  for (let i = 0; i < breadDrops; i += 1) spawnPickup(enemy.x + rand(-24, 24), enemy.y + rand(-24, 24), "bread", enemy.type === "superboss" ? 8 : enemy.type === "boss" ? 5 : 1);
  if (enemy.type === "splitter") {
    for (let i = 0; i < 3; i += 1) {
      spawnEnemy("mite");
      const child = pools.enemies[pools.enemies.length - 1];
      child.x = enemy.x + rand(-18, 18);
      child.y = enemy.y + rand(-18, 18);
      child.hp *= 0.55;
      child.maxHp = child.hp;
      child.radius *= 0.82;
      child.value = Math.floor(child.value * 0.45);
      child.type = "fragment";
      child.color = "#d7ff91";
      child.damage = Math.max(3, child.damage * 0.55);
    }
  }
  if (Math.random() < 0.16 || enemy.type === "superboss" || enemy.type === "boss" || enemy.type === "miniboss") spawnPickup(enemy.x, enemy.y, "relic", enemy.type === "superboss" ? 34 : enemy.type === "boss" ? 18 : enemy.type === "miniboss" ? 14 : 8);
  if (state.flags.has("shield-siphon")) {
    player.shield = Math.min(160, player.shield + (enemy.type === "superboss" ? 28 : enemy.type === "boss" ? 16 : enemy.type === "miniboss" ? 10 : 3));
  }
  if (state.flags.has("spore-cloud") && (enemy.status?.poison > 0 || enemy.status?.slow > 0)) {
    for (const nearby of pools.enemies) {
      if (nearby !== enemy && distanceSq(enemy, nearby) < 180 ** 2) {
        applyStatus(nearby, "poison", 1.4);
        applyStatus(nearby, "slow", 1.2);
      }
    }
  }
  if (enemy.type === "superboss" || enemy.type === "boss" || enemy.type === "miniboss") {
    spawnPickup(enemy.x + rand(-28, 28), enemy.y + rand(-28, 28), "heart", enemy.type === "superboss" ? 54 : enemy.type === "boss" ? 36 : 24);
    spawnPickup(enemy.x + rand(-28, 28), enemy.y + rand(-28, 28), "shield", enemy.type === "superboss" ? 52 : enemy.type === "boss" ? 34 : 24);
    if (enemy.type === "superboss") spawnPickup(enemy.x, enemy.y, "overcharge", 28);
  } else if (Math.random() < 0.035) {
    spawnPickup(enemy.x, enemy.y, Math.random() < 0.5 ? "heart" : "overcharge", 16);
  }
  for (let i = 0; i < 20; i += 1) particle(enemy.x, enemy.y, rand(-220, 220), rand(-220, 220), rand(0.28, 0.8), enemy.color, rand(2, 6));
  if (state.flags.has("death-echo") && Math.random() < 0.22) {
    shockwave(enemy.x, enemy.y, 145, 48);
  }
  if (enemy.affix === "volatile") {
    shockwave(enemy.x, enemy.y, 150 + state.wave * 2, 36 + state.wave * 1.4);
    camera.trauma = Math.max(camera.trauma, 0.18);
    floatingText(enemy.x, enemy.y - enemy.radius - 18, "VOLATILE", enemy.affixColor || "#ffdf6e");
  }
}

function unlockAchievement(name, description) {
  if (state.achievements.has(name)) return;
  state.achievements.add(name);
  state.score += 250;
  announce(`${name}: ${description}`, "#fff29b");
  showToast("Achievement unlocked", `${name}: ${description}`, "legendary");
  audio.achievement();
  for (let i = 0; i < 34; i += 1) {
    const angle = rand(0, Math.PI * 2);
    particle(player.x, player.y, Math.cos(angle) * rand(130, 360), Math.sin(angle) * rand(130, 360), rand(0.4, 0.9), "#fff29b", rand(2, 5));
  }
}

function damageEnemy(enemy, amount) {
  let damage = amount * (currentMutator("double-edge") ? 1.2 : 1) * (enemy.phased > 0 ? 0.28 : 1);
  if (enemy.shield > 0) {
    const blocked = Math.min(enemy.shield, damage);
    enemy.shield -= blocked;
    damage -= blocked;
    if (blocked > 0 && Math.random() < 0.35) floatingText(enemy.x, enemy.y - enemy.radius - 10, "SHIELD", "#a6ffd9");
  }
  enemy.hp -= damage;
  enemy.hitFlash = Math.max(enemy.hitFlash || 0, 0.12);
  return damage;
}

function shockwave(x, y, radius, damage) {
  for (const enemy of pools.enemies) {
    const d = Math.sqrt(distanceSq({ x, y }, enemy));
    if (d < radius) {
      damageEnemy(enemy, damage);
    }
  }
  for (let i = 0; i < 30; i += 1) {
    const angle = (i / 30) * Math.PI * 2;
    particle(x, y, Math.cos(angle) * 260, Math.sin(angle) * 260, 0.44, "#d7ff91", 3);
  }
}

function applyStatus(enemy, type, amount) {
  enemy.status ??= {};
  enemy.status[type] = Math.max(enemy.status[type] || 0, amount * player.statusPower);
}

function explodeAt(x, y, radius, damage, color = "#ff9b5c") {
  for (const enemy of pools.enemies) {
    const d = Math.sqrt(distanceSq({ x, y }, enemy));
    if (d <= radius) {
      const falloff = 1 - d / Math.max(1, radius);
      damageEnemy(enemy, damage * (0.35 + falloff * 0.65));
      if (state.flags.has("ember-armor")) applyStatus(enemy, "burn", 1.8);
    }
  }
  if (state.flags.has("volatile-loaves") && distanceSq({ x, y }, player) < (radius * 0.78) ** 2 && player.invulnerable <= 0) {
    const selfDamage = Math.max(3, damage * 0.13 - player.armor * 0.4);
    player.health -= selfDamage;
    state.waveDamageTaken += selfDamage;
    floatingText(player.x, player.y - 34, `VOLATILE -${Math.round(selfDamage)}`, "#ff9b9b");
  }
  for (let i = 0; i < 26; i += 1) {
    const angle = rand(0, Math.PI * 2);
    particle(x, y, Math.cos(angle) * rand(80, 360), Math.sin(angle) * rand(80, 360), rand(0.22, 0.62), color, rand(3, 7));
  }
  camera.trauma = Math.max(camera.trauma, 0.16);
}

function chainFrom(source, damage, jumps, color = "#85ffd2") {
  let origin = source;
  const hit = new Set([source]);
  for (let jump = 0; jump < jumps; jump += 1) {
    const target = pools.enemies
      .filter((enemy) => !hit.has(enemy) && enemy.hp > 0 && distanceSq(origin, enemy) < 260 ** 2)
      .sort((a, b) => distanceSq(origin, a) - distanceSq(origin, b))[0];
    if (!target) return;
    damageEnemy(target, damage * (0.72 - jump * 0.08));
    applyStatus(target, "shock", 1.2);
    particle(origin.x, origin.y, (target.x - origin.x) * 4, (target.y - origin.y) * 4, 0.16, color, 5);
    hit.add(target);
    origin = target;
  }
}

function applyShotEffects(shot, enemy) {
  const tags = shot.tags || [];
  if (tags.includes("poison")) applyStatus(enemy, "poison", 3.2);
  if (tags.includes("slow")) applyStatus(enemy, "slow", 2.4);
  if (tags.includes("burn")) applyStatus(enemy, "burn", 2.7);
  if (tags.includes("shock") || tags.includes("chain")) {
    chainFrom(enemy, shot.damage * 0.55, player.chainTargets + (shot.crit ? 1 : 0), shot.color);
  }
  if (tags.includes("explosive")) {
    explodeAt(enemy.x, enemy.y, shot.explosionRadius || player.explosionRadius, shot.damage * 0.82, shot.color);
  }
  if (state.flags.has("volatile-loaves") && !tags.includes("explosive") && Math.random() < 0.34) {
    explodeAt(enemy.x, enemy.y, Math.max(54, player.explosionRadius * 0.58), shot.damage * 0.46, "#ffcf8a");
  }
  if (state.flags.has("chain-gland") && !tags.includes("chain") && Math.random() < 0.36) {
    chainFrom(enemy, shot.damage * 0.34, Math.max(1, Math.floor(player.chainTargets / 2)), "#85ffd2");
  }
  if (state.flags.has("burn-explodes") && enemy.status?.burn > 0 && Math.random() < 0.22) {
    explodeAt(enemy.x, enemy.y, player.explosionRadius * 0.72, shot.damage * 0.48, "#ffcf8a");
  }
}

function updateProjectiles(dt) {
  for (let i = pools.projectiles.length - 1; i >= 0; i -= 1) {
    const shot = pools.projectiles[i];
    shot.x += shot.vx * dt;
    shot.y += shot.vy * dt;
    shot.life -= dt;
    let remove = shot.life <= 0 || shot.x < -80 || shot.y < -80 || shot.x > WORLD.width + 80 || shot.y > WORLD.height + 80;
    for (const enemy of pools.enemies) {
      if (distanceSq(shot, enemy) < (shot.radius + enemy.radius) ** 2) {
        damageEnemy(enemy, shot.damage);
        enemy.vx += shot.vx * 0.055 * (shot.knockback || 1);
        enemy.vy += shot.vy * 0.055 * (shot.knockback || 1);
        applyShotEffects(shot, enemy);
        if (state.flags.has("weapon-lifesteal") || state.flags.has("meta-lifesteal")) {
          const healRate = (state.flags.has("weapon-lifesteal") ? 0.018 : 0.008) * difficultyProfile().sustainMultiplier;
          player.health = Math.min(player.maxHealth, player.health + Math.max(0.25, shot.damage * healRate));
        }
        floatingText(enemy.x, enemy.y - enemy.radius, shot.crit ? "CRIT" : Math.round(shot.damage), shot.crit ? "#fff29b" : "#f3fff1");
        for (let p = 0; p < 8; p += 1) particle(shot.x, shot.y, rand(-160, 160), rand(-160, 160), rand(0.18, 0.38), shot.crit ? "#fff29b" : shot.color || "#caffb8", rand(2, 4));
        if (shot.pierce > 0) shot.pierce -= 1;
        else remove = true;
        break;
      }
    }
    if (remove) {
      if (shot.tags?.includes("explosive") && shot.life <= 0) explodeAt(shot.x, shot.y, shot.explosionRadius || player.explosionRadius, shot.damage * 0.72, shot.color);
      pools.projectiles.splice(i, 1);
    }
  }
}

function updateEnemyShots(dt) {
  for (let i = pools.enemyShots.length - 1; i >= 0; i -= 1) {
    const shot = pools.enemyShots[i];
    shot.x += shot.vx * dt;
    shot.y += shot.vy * dt;
    shot.life -= dt;
    let remove = shot.life <= 0 || shot.x < -100 || shot.y < -100 || shot.x > WORLD.width + 100 || shot.y > WORLD.height + 100;
    if (!remove && distanceSq(shot, player) < (shot.radius + player.radius) ** 2) {
      if (player.invulnerable <= 0) {
        let damage = Math.max(2, shot.damage * difficultyProfile().incomingDamageMultiplier - player.armor * 0.6);
      if (state.flags.has("glass-contract")) damage *= 1.22;
      if (player.shield > 0) {
        const shieldBefore = player.shield;
        const blocked = Math.min(player.shield, damage);
        player.shield -= blocked;
        damage -= blocked;
        floatingText(player.x, player.y - 54, `BLOCK ${Math.round(blocked)}`, "#85ffd2");
        if (shieldBefore > 0 && player.shield <= 0 && state.flags.has("reactive-armor")) shockwave(player.x, player.y, 185, 42 + state.wave * 2);
      }
        player.health -= damage;
        state.waveDamageTaken += damage;
        player.invulnerable = 0.22;
        camera.trauma = Math.max(camera.trauma, 0.24);
        audio.hit();
        if (damage > 0) floatingText(player.x, player.y - 36, `-${Math.round(damage)}`, "#ff9b9b");
      }
      remove = true;
    }
    if (remove) pools.enemyShots.splice(i, 1);
  }
}

function updatePickups(dt) {
  for (let i = pools.pickups.length - 1; i >= 0; i -= 1) {
    const pickup = pools.pickups[i];
    const dx = player.x - pickup.x;
    const dy = player.y - pickup.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist < player.magnet) {
      const pull = (1 - dist / player.magnet) * 760;
      pickup.vx += (dx / dist) * pull * dt;
      pickup.vy += (dy / dist) * pull * dt;
    }
    pickup.vx *= 0.98;
    pickup.vy *= 0.98;
    pickup.x += pickup.vx * dt;
    pickup.y += pickup.vy * dt;
    pickup.phase += dt * 5;
    pickup.life -= dt;
    if (dist < pickup.radius + player.radius) {
      if (pickup.type === "bread") {
        state.bread += pickup.amount;
        state.score += pickup.amount * 4;
        if (state.flags.has("bakery-heal")) player.health = Math.min(player.maxHealth, player.health + 1.5 * pickup.amount);
        if (state.bread >= 100) unlockAchievement("Bread Liable", "Collected 100 bread in one run.");
      } else if (pickup.type === "relic") {
        player.relic = clamp(player.relic + pickup.amount, 0, player.relicMax);
      } else if (pickup.type === "heart") {
        player.health = Math.min(player.maxHealth, player.health + pickup.amount);
        floatingText(player.x, player.y - 44, `+${Math.round(pickup.amount)} HP`, "#ff8fd8");
      } else if (pickup.type === "shield") {
        player.shield = Math.min(90, player.shield + pickup.amount);
        floatingText(player.x, player.y - 44, `+${Math.round(pickup.amount)} SHIELD`, "#85ffd2");
        showToast("Keeper ward", `+${Math.round(pickup.amount)} shield`, "rare");
      } else if (pickup.type === "overcharge") {
        player.overcharge = Math.max(player.overcharge, 7);
        floatingText(player.x, player.y - 44, "OVERCHARGE", "#fff29b");
        showToast("Overcharge", "Damage boosted for a short ritual.", "legendary");
      }
      audio.pickup();
      pools.pickups.splice(i, 1);
    } else if (pickup.life <= 0) {
      pools.pickups.splice(i, 1);
    }
  }
}

function updateHazards(dt) {
  for (let i = pools.hazards.length - 1; i >= 0; i -= 1) {
    const hazard = pools.hazards[i];
    hazard.life -= dt;
    hazard.pulse += dt * 4;
    if (distanceSq(player, hazard) < hazard.radius ** 2 && player.invulnerable <= 0) {
      const damage = Math.max(3, 12 * difficultyProfile().incomingDamageMultiplier - player.armor) * dt;
      player.health -= damage;
      state.waveDamageTaken += damage;
    }
    if (hazard.life <= 0) pools.hazards.splice(i, 1);
  }
}

function updateParticles(dt) {
  for (const listName of ["particles", "texts"]) {
    const list = pools[listName];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      item.life -= dt;
      item.x += (item.vx || 0) * dt;
      item.y += (item.vy || -38) * dt;
      if (listName === "particles") {
        item.vx *= 0.96;
        item.vy *= 0.96;
      }
      if (item.life <= 0) list.splice(i, 1);
    }
  }
}

function updateCamera(dt) {
  camera.x = clamp(player.x - VIEW.width / 2, 0, WORLD.width - VIEW.width);
  camera.y = clamp(player.y - VIEW.height / 2, 0, WORLD.height - VIEW.height);
  camera.trauma = Math.max(0, camera.trauma - dt * 1.8);
  camera.shake = camera.trauma * camera.trauma * 22;
}

function updateHud() {
  hud.wave.textContent = state.wave;
  hud.health.textContent = `${Math.max(0, Math.ceil(player.health))}/${player.maxHealth}`;
  if (player.shield > 0) hud.health.textContent += ` +${Math.ceil(player.shield)}`;
  hud.bread.textContent = state.bread;
  hud.score.textContent = state.score.toLocaleString();
  hud.relic.textContent = `${Math.floor((player.relic / player.relicMax) * 100)}%`;
  hud.dash.textContent = player.dashCooldown <= 0 ? "Ready" : `${player.dashCooldown.toFixed(1)}s`;
  hud.combo.textContent = player.overcharge > 0 ? `x${state.combo.toFixed(1)} OC` : `x${state.combo.toFixed(1)}`;
  difficultyText.textContent = state.practice ? `Practice ${state.roundModifier}` : `Threat ${state.difficulty.toFixed(1)}x`;
  intelLabel.textContent = state.biome;
}

function updateSidebar() {
  const weapon = state.mode === "menu" || state.mode === "gameover" ? weaponCatalog[selectedLoadout.weapon] || currentWeapon() : currentWeapon();
  const armor = state.mode === "menu" || state.mode === "gameover" ? armorCatalog[selectedLoadout.armor] || currentArmor() : currentArmor();
  const perk = startingPerkCatalog[selectedLoadout.perk] || startingPerkCatalog.none;
  const event = currentWaveEvent();
  const mutator = state.activeMutator;
  const loadoutItems = [
    `${weapon.name} · ${weapon.role}`,
    `${armor.name} · ${armor.role}`,
    `Perk · ${perk.name}`,
    ...(state.runModifiers?.length ? [`Run · ${state.runModifiers.map((item) => item.name).join(" + ")}`] : []),
    ...state.upgrades.slice(-7)
  ];
  loadout.innerHTML = loadoutItems.map((item) => `<span>${safeName(item)}</span>`).join("");
  objectives.innerHTML = [
    state.waveClearing ? `Clear the remaining wave ${state.wave} enemies.` : `Survive wave ${state.wave}.`,
    event ? `${event.name}: ${event.detail}` : "The den is behaving. Suspicious.",
    mutator ? `${mutator.name}: ${mutator.detail}` : `Enemy composition: ${state.enemyBias?.name || "Unknown"}.`,
    state.waveClearing ? "Spawner paused. Upgrade appears when the arena is clean." : `${Math.max(0, Math.ceil(difficultyProfile().waveLength - state.waveTimer))} seconds until the wave starts clearing.`,
    `${pools.enemies.length} curse-things active.`,
    player.relic >= player.relicMax ? "Relic burst ready. Press Q." : "Charge relic burst with kills and shards."
  ].map((item) => `<li>${item}</li>`).join("");
  const boss = pools.enemies.find((enemy) => enemy.type === "superboss" || enemy.type === "boss");
  const pressure = lateWavePressure();
  intel.innerHTML = [
    `<span>Biome <b>${safeName(state.biome)}</b></span>`,
    `<span>Wave Event <b>${safeName(event?.name || "Standard Siege")}</b></span>`,
    `<span>Run Mix <b>${safeName(state.enemyBias?.name || "Normal")}</b></span>`,
    `<span>Mutator <b>${safeName(mutator?.name || "None")}</b></span>`,
    `<span>Reward Heat <b>${state.nextRewardBoost > 1 ? `${state.nextRewardBoost.toFixed(1)}x` : "Normal"}</b></span>`,
    `<span>Modifier <b>${safeName(state.roundModifier)}</b></span>`,
    `<span>Late Pressure <b>${pressure > 0 ? `${pressure.toFixed(1)}x` : "Calm"}</b></span>`,
    `<span>Enemy Cap <b>${difficultyProfile().enemyCap.toLocaleString()}</b></span>`,
    `<span>Doom <b>${difficultyProfile().doom > 0 ? `${difficultyProfile().doom.toFixed(1)}x` : "Sleeping"}</b></span>`,
    `<span>Kills <b>${state.kills}</b></span>`,
    `<span>Shield <b>${Math.ceil(player.shield)}</b></span>`,
    `<span>Overcharge <b>${player.overcharge > 0 ? `${player.overcharge.toFixed(1)}s` : "None"}</b></span>`,
    `<span>Weapon <b>${safeName(weapon.name)}</b></span>`,
    `<span>Armor <b>${safeName(armor.name)}</b></span>`,
    `<span>Boss <b>${boss ? `${boss.type === "superboss" ? "SUPER " : ""}${Math.ceil(Math.max(0, boss.hp))} HP` : "Dormant"}</b></span>`,
    `<span>Mini-boss <b>${pools.enemies.some((enemy) => enemy.type === "miniboss") ? "Active" : "Clear"}</b></span>`,
    `<span>Threat Mix <b>${new Set(pools.enemies.map((enemy) => enemy.type)).size || 0}</b></span>`,
    `<span>Achievements <b>${state.achievements.size}</b></span>`
  ].join("");
}

function endRun() {
  state.gameOverHandled = true;
  state.mode = "gameover";
  const bread = Math.floor(state.bread * (state.practice ? 0.4 : 1));
  const essenceEarned = Math.max(4, Math.floor(state.score / (state.flags.has("danger-dividend") ? 560 : 650)) + state.wave * 3 + Math.floor(state.kills / 12));
  const roundReached = Math.max(1, state.wave);
  const unlockedPowers = state.practice ? [] : awardPermanentPowers(roundReached);
  if (!state.practice) {
    meta.essence += essenceEarned;
    saveMetaProgress();
    renderMetaUpgrades();
    renderLoadoutPicker();
  }
  const minutes = Math.floor(state.time / 60);
  const seconds = Math.floor(state.time % 60).toString().padStart(2, "0");
  overlay.classList.remove("is-hidden");
  overlay.querySelector("p").textContent = "Run complete";
  overlay.querySelector("h2").textContent = `${state.score.toLocaleString()} score`;
  overlay.querySelector("span").textContent = `${bread.toLocaleString()} claimable bread. Survived ${minutes}:${seconds}, reached wave ${state.wave}, removed ${state.kills} curse-things, unlocked ${state.achievements.size} achievements, and earned ${state.practice ? 0 : essenceEarned} essence.${unlockedPowers.length ? ` Permanent power awakened: ${unlockedPowers.map((power) => power.name).join(", ")}.` : ""}`;
  services.submitScore({ score: state.score, bread });
  services.createClaimCode({ score: state.score, bread });
  statusText.textContent = "Run complete";
}

function render() {
  const shakeX = rand(-camera.shake, camera.shake);
  const shakeY = rand(-camera.shake, camera.shake);
  ctx.save();
  ctx.clearRect(0, 0, VIEW.width, VIEW.height);
  ctx.translate(Math.round(-camera.x + shakeX), Math.round(-camera.y + shakeY));
  drawWorld();
  drawHazards();
  drawPickups();
  drawProjectiles();
  drawEnemyShots();
  drawEnemies();
  drawPlayer();
  drawParticles();
  ctx.restore();
  drawReticle();
  drawMinimap();
  drawLowHealthWarning();
  drawFlash();
  drawVisionMask();
  if (state.mode === "paused") drawPauseTint();
}

function drawWorld() {
  const gradient = ctx.createLinearGradient(0, 0, WORLD.width, WORLD.height);
  const biomeColors = {
    "Outer Den": ["#07120d", "#102417", "#050a07"],
    "Green Furnace": ["#07100d", "#173719", "#0c1006"],
    "Broken Archive": ["#080b12", "#161733", "#07080d"]
  }[state.biome] || ["#07120d", "#102417", "#050a07"];
  gradient.addColorStop(0, biomeColors[0]);
  gradient.addColorStop(0.45, biomeColors[1]);
  gradient.addColorStop(1, biomeColors[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);

  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = "#1e6533";
  ctx.lineWidth = 2;
  const grid = 120;
  for (let x = 0; x <= WORLD.width; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD.height);
    ctx.stroke();
  }
  for (let y = 0; y <= WORLD.height; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD.width, y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.28;
  for (let i = 0; i < 34; i += 1) {
    const x = (i * 283) % WORLD.width;
    const y = (i * 179) % WORLD.height;
    ctx.fillStyle = i % 3 === 0 ? "#e0ff9a" : "#59e75c";
    ctx.beginPath();
    ctx.arc(x, y, 2 + (i % 4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(WORLD.width / 2, WORLD.height / 2);
  ctx.strokeStyle = "rgba(128,255,108,0.2)";
  for (let r = 170; r < 820; r += 130) {
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer() {
  const pulse = 1 + Math.sin(state.time * 8) * 0.025;
  ctx.save();
  ctx.translate(player.x, player.y);
  const aim = Math.atan2(pointer.worldY - player.y, pointer.worldX - player.x);
  ctx.rotate(aim);
  if (player.invulnerable > 0) ctx.globalAlpha = 0.68 + Math.sin(state.time * 40) * 0.22;
  ctx.fillStyle = "#f4f3e7";
  ctx.shadowColor = "rgba(183,255,146,0.45)";
  ctx.shadowBlur = 28;
  ctx.beginPath();
  ctx.ellipse(0, 0, player.radius * 1.15 * pulse, player.radius * 0.92 * pulse, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#1f2524";
  ctx.beginPath();
  ctx.ellipse(5, -player.radius * 0.92, 12, 30, -0.72, 0, Math.PI * 2);
  ctx.ellipse(5, player.radius * 0.92, 12, 30, 0.72, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#0d1512";
  ctx.beginPath();
  ctx.arc(15, -9, 4, 0, Math.PI * 2);
  ctx.arc(15, 9, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#78ff75";
  ctx.beginPath();
  ctx.arc(16, -10, 2, 0, Math.PI * 2);
  ctx.arc(16, 8, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (player.relic >= player.relicMax) {
    ctx.save();
    ctx.globalAlpha = 0.42 + Math.sin(state.time * 6) * 0.12;
    ctx.strokeStyle = "#9cff74";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(player.x, player.y, 48 + Math.sin(state.time * 7) * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (player.shield > 0) {
    ctx.save();
    ctx.globalAlpha = 0.22 + Math.sin(state.time * 8) * 0.06;
    ctx.strokeStyle = "#85ffd2";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius + 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (player.overcharge > 0) {
    ctx.save();
    ctx.globalAlpha = 0.28 + Math.sin(state.time * 18) * 0.08;
    ctx.strokeStyle = "#fff29b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius + 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawReticle() {
  if (state.mode !== "playing") return;
  ctx.save();
  ctx.strokeStyle = player.overcharge > 0 ? "#fff29b" : "rgba(215,255,145,0.88)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pointer.x, pointer.y, 12, 0, Math.PI * 2);
  ctx.moveTo(pointer.x - 20, pointer.y);
  ctx.lineTo(pointer.x - 9, pointer.y);
  ctx.moveTo(pointer.x + 9, pointer.y);
  ctx.lineTo(pointer.x + 20, pointer.y);
  ctx.moveTo(pointer.x, pointer.y - 20);
  ctx.lineTo(pointer.x, pointer.y - 9);
  ctx.moveTo(pointer.x, pointer.y + 9);
  ctx.lineTo(pointer.x, pointer.y + 20);
  ctx.stroke();
  ctx.restore();
}

function drawEnemies() {
  for (const enemy of pools.enemies) {
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    if (enemy.type === "charger" && enemy.state === "telegraph") {
      ctx.save();
      ctx.globalAlpha = 0.55 + Math.sin(state.time * 20) * 0.2;
      ctx.strokeStyle = "#ffdf6e";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(enemy.chargeX * 120, enemy.chargeY * 120);
      ctx.stroke();
      ctx.restore();
    }
    if (enemy.type === "sniper" && enemy.state === "aiming") {
      ctx.save();
      ctx.globalAlpha = 0.42 + Math.sin(state.time * 24) * 0.2;
      ctx.strokeStyle = "#ffef9b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(enemy.chargeX * 900, enemy.chargeY * 900);
      ctx.stroke();
      ctx.restore();
    }
    if (enemy.type === "healer" || enemy.type === "buffer") {
      ctx.save();
      ctx.globalAlpha = 0.22 + Math.sin(state.time * 5 + enemy.phase) * 0.08;
      ctx.strokeStyle = enemy.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 120, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (enemy.enraged > 0) {
      ctx.save();
      ctx.globalAlpha = 0.34 + Math.sin(state.time * 18) * 0.12;
      ctx.strokeStyle = "#ffb3f3";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = enemy.hitFlash > 0 ? "#ffffff" : enemy.color;
    if (enemy.phased > 0) ctx.globalAlpha = 0.42 + Math.sin(state.time * 24) * 0.18;
    ctx.shadowColor = enemy.color;
    ctx.shadowBlur = enemy.type === "superboss" ? 48 : enemy.type === "boss" || enemy.type === "miniboss" ? 34 : 16;
    ctx.beginPath();
    if (enemy.type === "mine") {
      ctx.moveTo(0, -enemy.radius);
      for (let i = 1; i < 8; i += 1) {
        const a = -Math.PI / 2 + i * Math.PI * 2 / 8;
        const r = i % 2 ? enemy.radius * 0.58 : enemy.radius;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
    } else {
      ctx.arc(0, 0, enemy.radius, 0, Math.PI * 2);
    }
    ctx.fill();
    if (enemy.type === "superboss" || enemy.type === "boss" || enemy.type === "miniboss") {
      ctx.strokeStyle = "rgba(255,255,255,0.68)";
      ctx.lineWidth = enemy.type === "superboss" ? 6 : enemy.type === "boss" ? 4 : 3;
      ctx.stroke();
    }
    if (enemy.type === "superboss") {
      ctx.save();
      ctx.globalAlpha = 0.42 + Math.sin(state.time * 8 + enemy.phase) * 0.16;
      ctx.strokeStyle = "#9cff74";
      ctx.lineWidth = 4;
      ctx.setLineDash([14, 8]);
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 18 + Math.sin(state.time * 5) * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    if (enemy.elite) {
      ctx.strokeStyle = "#fff29b";
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 8 + Math.sin(state.time * 8 + enemy.phase) * 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (enemy.affix) {
      ctx.strokeStyle = enemy.affixColor || "#d7ff91";
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.64 + Math.sin(state.time * 10 + enemy.phase) * 0.16;
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(2,6,4,0.84)";
    ctx.beginPath();
    ctx.arc(enemy.radius * 0.32, -enemy.radius * 0.18, Math.max(3, enemy.radius * 0.12), 0, Math.PI * 2);
    ctx.arc(enemy.radius * 0.32, enemy.radius * 0.18, Math.max(3, enemy.radius * 0.12), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(2,6,4,0.52)";
    ctx.fillRect(-enemy.radius, enemy.radius + 8, enemy.radius * 2, 5);
    ctx.fillStyle = "#8cff75";
    ctx.fillRect(-enemy.radius, enemy.radius + 8, enemy.radius * 2 * clamp(enemy.hp / enemy.maxHp, 0, 1), 5);
    if (enemy.maxShield > 0 && enemy.shield > 0) {
      ctx.fillStyle = "#a6ffd9";
      ctx.fillRect(-enemy.radius, enemy.radius + 15, enemy.radius * 2 * clamp(enemy.shield / enemy.maxShield, 0, 1), 4);
    }
    ctx.restore();
  }
}

function drawProjectiles() {
  for (const shot of pools.projectiles) {
    ctx.save();
    const color = shot.crit ? "#fff29b" : shot.color || "#dcffd4";
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(2, shot.radius * 0.6);
    ctx.beginPath();
    ctx.moveTo(shot.x, shot.y);
    ctx.lineTo(shot.x - shot.vx * 0.035, shot.y - shot.vy * 0.035);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = shot.crit ? 20 : 14;
    ctx.beginPath();
    if (shot.tags?.includes("rail")) {
      ctx.ellipse(shot.x, shot.y, shot.radius * 1.8, shot.radius * 0.72, Math.atan2(shot.vy, shot.vx), 0, Math.PI * 2);
    } else {
      ctx.arc(shot.x, shot.y, shot.radius, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }
}

function drawEnemyShots() {
  for (const shot of pools.enemyShots) {
    ctx.save();
    ctx.fillStyle = shot.color;
    ctx.shadowColor = shot.color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(shot.x, shot.y, shot.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function drawPickups() {
  for (const pickup of pools.pickups) {
    const bob = Math.sin(pickup.phase) * 4;
    ctx.save();
    ctx.translate(pickup.x, pickup.y + bob);
    const pickupColor = {
      bread: "#f4c466",
      relic: "#7cff73",
      heart: "#ff8fd8",
      shield: "#85ffd2",
      overcharge: "#fff29b"
    }[pickup.type] || "#f4c466";
    ctx.fillStyle = pickupColor;
    ctx.shadowColor = pickupColor;
    ctx.shadowBlur = 14;
    if (pickup.type === "bread") {
      ctx.beginPath();
      ctx.roundRect(-9, -6, 18, 12, 5);
      ctx.fill();
    } else if (pickup.type === "heart") {
      ctx.beginPath();
      ctx.arc(-5, -3, 6, 0, Math.PI * 2);
      ctx.arc(5, -3, 6, 0, Math.PI * 2);
      ctx.moveTo(-11, 0);
      ctx.lineTo(0, 12);
      ctx.lineTo(11, 0);
      ctx.closePath();
      ctx.fill();
    } else if (pickup.type === "shield") {
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.lineTo(12, -6);
      ctx.lineTo(8, 10);
      ctx.lineTo(0, 15);
      ctx.lineTo(-8, 10);
      ctx.lineTo(-12, -6);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-8, -8, 16, 16);
    }
    ctx.restore();
  }
}

function drawHazards() {
  for (const hazard of pools.hazards) {
    ctx.save();
    ctx.globalAlpha = clamp(hazard.life / 2, 0, 0.58);
    ctx.fillStyle = "#ff6868";
    ctx.strokeStyle = "#ffabab";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(hazard.x, hazard.y, hazard.radius + Math.sin(hazard.pulse) * 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of pools.particles) {
    ctx.save();
    ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const text of pools.texts) {
    ctx.save();
    ctx.globalAlpha = clamp(text.life / text.maxLife, 0, 1);
    ctx.fillStyle = text.color;
    ctx.font = "900 18px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 8;
    ctx.fillText(text.text, text.x, text.y);
    ctx.restore();
  }
}

function drawMinimap() {
  const width = 154;
  const height = 106;
  const x = VIEW.width - width - 18;
  const y = VIEW.height - height - 18;
  ctx.save();
  ctx.fillStyle = "rgba(2,8,5,0.58)";
  ctx.strokeStyle = "rgba(195,255,190,0.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 16);
  ctx.fill();
  ctx.stroke();
  const sx = width / WORLD.width;
  const sy = height / WORLD.height;
  ctx.fillStyle = "#f4f3e7";
  ctx.beginPath();
  ctx.arc(x + player.x * sx, y + player.y * sy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff7373";
  for (const enemy of pools.enemies.slice(0, DIFFICULTY_MODEL.maxDrawMinimapEnemies)) {
    ctx.fillStyle = enemy.type === "superboss" ? "#9cff74" : enemy.type === "boss" ? "#ff7373" : enemy.type === "miniboss" ? "#ff8fd8" : enemy.type === "healer" || enemy.type === "buffer" ? "#ff8fd8" : enemy.type === "charger" || enemy.type === "sniper" ? "#ffdf6e" : enemy.type === "bulwark" ? "#a6ffd9" : "#ff7373";
    const dot = enemy.type === "superboss" ? 5 : 3;
    ctx.fillRect(x + enemy.x * sx - dot / 2, y + enemy.y * sy - dot / 2, dot, dot);
  }
  ctx.restore();
}

function drawPauseTint() {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  ctx.restore();
}

function drawLowHealthWarning() {
  const ratio = player.health / Math.max(1, player.maxHealth);
  if (ratio > 0.28 || state.mode !== "playing") return;
  ctx.save();
  ctx.globalAlpha = clamp((0.28 - ratio) * 2.8 + Math.sin(state.time * 9) * 0.04, 0.08, 0.42);
  const gradient = ctx.createRadialGradient(VIEW.width / 2, VIEW.height / 2, VIEW.height * 0.25, VIEW.width / 2, VIEW.height / 2, VIEW.height * 0.78);
  gradient.addColorStop(0, "rgba(255,0,0,0)");
  gradient.addColorStop(1, "rgba(255,58,58,0.9)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  ctx.restore();
}

function drawFlash() {
  if (state.flash <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(state.flash * 1.8, 0, 0.5);
  ctx.fillStyle = "#d7ff91";
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  ctx.restore();
}

function drawVisionMask() {
  if (!currentMutator("limited-vision") || state.mode !== "playing") return;
  const x = player.x - camera.x;
  const y = player.y - camera.y;
  const radius = Math.max(180, Math.min(VIEW.width, VIEW.height) * 0.38);
  const gradient = ctx.createRadialGradient(x, y, radius * 0.28, x, y, radius);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.68, "rgba(0,0,0,0.28)");
  gradient.addColorStop(1, "rgba(0,0,0,0.82)");
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  ctx.restore();
}

function loop(now) {
  const dt = Math.min(0.033, (now - state.lastTime) / 1000 || 0);
  state.lastTime = now;
  update(dt);
  render();
  if (state.mode === "playing") updateSidebar();
  requestAnimationFrame(loop);
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  const key = normalizeKey(event.key);
  if (isTextInputTarget(event.target)) return;
  keys.add(key);
  if (GAMEPLAY_KEYS.has(key)) event.preventDefault();
});
window.addEventListener("keyup", (event) => keys.delete(normalizeKey(event.key)));
window.addEventListener("blur", () => keys.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) keys.clear();
});
canvas.addEventListener("pointermove", screenToWorld);
canvas.addEventListener("pointerdown", (event) => {
  focusGameCanvas();
  pointer.down = true;
  screenToWorld(event);
  canvas.setPointerCapture?.(event.pointerId);
});
canvas.addEventListener("pointerup", () => {
  pointer.down = false;
});
canvas.addEventListener("pointerleave", () => {
  pointer.down = false;
});
upgradeGrid.addEventListener("click", (event) => {
  const runChoice = event.target.closest("button[data-run-choice]");
  if (runChoice?.dataset.runChoice === "skip-reward") {
    skipUpgradeReward();
    return;
  }
  const button = event.target.closest("button[data-upgrade]");
  if (!button) return;
  applyUpgrade(button.dataset.upgrade);
});
upgradeModal.addEventListener("cancel", (event) => {
  event.preventDefault();
});
document.querySelectorAll("[data-loadout-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    activeLoadoutTab = button.dataset.loadoutTab || "weapon";
    renderLoadoutPicker();
  });
});
loadoutOptions?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-loadout-kind][data-loadout-id]");
  if (!button || button.disabled) return;
  const kind = button.dataset.loadoutKind;
  const id = button.dataset.loadoutId;
  if (kind === "weapon" && weaponCatalog[id]) selectedLoadout.weapon = id;
  if (kind === "armor" && armorCatalog[id]) selectedLoadout.armor = id;
  if (kind === "perk" && startingPerkCatalog[id] && isPerkUnlocked(startingPerkCatalog[id])) selectedLoadout.perk = id;
  saveLoadout();
  renderLoadoutPicker();
  updateSidebar();
});
metaUpgradeList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-meta-upgrade]");
  if (!button) return;
  buyMetaUpgrade(button.dataset.metaUpgrade);
});
startButton.addEventListener("click", () => resetRun(false));
practiceButton.addEventListener("click", () => resetRun(true));
fullscreenButton.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.querySelector(".relic-stage-wrap")?.requestFullscreen();
    }
    setTimeout(resizeCanvas, 80);
  } catch {
    announce("Fullscreen refused by the browser. Very official.", "#ffcf8a");
  }
});
document.addEventListener("fullscreenchange", () => {
  setTimeout(resizeCanvas, 80);
});

resizeCanvas();
renderMetaUpgrades();
renderLoadoutPicker();
services.loadLeaderboard();
updateHud();
updateSidebar();
requestAnimationFrame((time) => {
  state.lastTime = time;
  requestAnimationFrame(loop);
});
