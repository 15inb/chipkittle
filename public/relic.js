import { clamp, createGameServices, distanceSq, rand, safeName } from "./game-common.js";

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

let meta = loadMetaProgress();

function normalizeKey(key = "") {
  return String(key || "").toLowerCase();
}

function isTextInputTarget(target) {
  const tagName = target?.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || Boolean(target?.isContentEditable);
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
  fireRate: 0.16,
  projectileSpeed: 820,
  multiShot: 1,
  magnet: 150,
  relic: 0,
  relicMax: 100,
  crit: 0.08,
  regen: 0,
  shield: 0,
  overcharge: 0
};

const upgrades = [
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
  mite: { hp: 32, speed: 135, radius: 18, damage: 9, value: 22, color: "#9cf66f" },
  brute: { hp: 92, speed: 82, radius: 30, damage: 18, value: 56, color: "#f1c964" },
  wisp: { hp: 22, speed: 190, radius: 14, damage: 7, value: 30, color: "#79eaff" },
  spitter: { hp: 48, speed: 112, radius: 20, damage: 10, value: 46, color: "#c68cff" },
  guardian: { hp: 150, speed: 58, radius: 35, damage: 20, value: 82, color: "#85ffd2" },
  charger: { hp: 76, speed: 118, radius: 23, damage: 18, value: 62, color: "#ffb35c" },
  splitter: { hp: 64, speed: 105, radius: 24, damage: 12, value: 58, color: "#b7ff4f" },
  healer: { hp: 70, speed: 92, radius: 22, damage: 8, value: 72, color: "#ff8fd8" },
  mine: { hp: 30, speed: 42, radius: 18, damage: 28, value: 38, color: "#ffdf6e" },
  fragment: { hp: 18, speed: 155, radius: 14, damage: 5, value: 10, color: "#d7ff91" },
  miniboss: { hp: 340, speed: 72, radius: 44, damage: 24, value: 220, color: "#ff6fb4" },
  boss: { hp: 720, speed: 64, radius: 54, damage: 26, value: 480, color: "#ff7373" }
};

const DIFFICULTY_MODEL = {
  softStartWave: 1,
  layeredStartWave: 6,
  surgeStartWave: 12,
  endlessStartWave: 18,
  spawnFloor: 0.1,
  baseWaveSeconds: 22,
  maxWaveSeconds: 48,
  baseEnemyCap: 22,
  enemyCapLimit: 88,
  maxTelegraphCompression: 0.62,
  maxSpecialCooldownCompression: 0.58
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
  if (wave <= 6) return 0;
  return ((wave - 6) / 5) ** 1.25;
}

function roundModifierFor(wave = state.wave) {
  if (wave < 4) return ROUND_MODIFIERS[0];
  return ROUND_MODIFIERS[(wave - 1) % ROUND_MODIFIERS.length];
}

function difficultyProfile(wave = state.wave) {
  const soft = Math.max(0, wave - DIFFICULTY_MODEL.softStartWave);
  const layered = Math.max(0, wave - DIFFICULTY_MODEL.layeredStartWave);
  const surge = Math.max(0, wave - DIFFICULTY_MODEL.surgeStartWave);
  const endless = Math.max(0, wave - DIFFICULTY_MODEL.endlessStartWave);
  const modifier = roundModifierFor(wave);
  const layeredCurve = layered ** 1.18;
  const surgeCurve = surge ** 1.32;
  const endlessCurve = Math.log2(endless + 1);

  const threat = 1 + soft * 0.075 + layeredCurve * 0.035 + surgeCurve * 0.028 + endlessCurve * 0.18;
  const telegraphMultiplier = Math.max(
    DIFFICULTY_MODEL.maxTelegraphCompression,
    1 - layered * 0.018 - surge * 0.012
  );
  const specialCooldownMultiplier = Math.max(
    DIFFICULTY_MODEL.maxSpecialCooldownCompression,
    1 - layered * 0.022 - surge * 0.014
  );

  return {
    wave,
    modifier,
    threat,
    healthScale: (1 + soft * 0.08 + layeredCurve * 0.045 + surgeCurve * 0.035 + endlessCurve * 0.18) * modifier.health,
    speedScale: (1 + soft * 0.012 + layered * 0.012 + surge * 0.01 + endlessCurve * 0.045) * modifier.speed,
    damageScale: 1 + Math.max(0, wave - 7) * 0.026 + surge * 0.012,
    spawnInterval: Math.max(
      DIFFICULTY_MODEL.spawnFloor,
      (1.1 - soft * 0.035 - layered * 0.018 - surge * 0.011) * modifier.spawn
    ),
    enemyCap: Math.min(
      DIFFICULTY_MODEL.enemyCapLimit,
      Math.max(14, DIFFICULTY_MODEL.baseEnemyCap + Math.floor(soft * 2.4 + layeredCurve * 1.25 + surge * 1.45 + modifier.enemyCap))
    ),
    hazardRate: (0.02 + soft * 0.004 + layered * 0.006 + surge * 0.007) * modifier.hazards,
    extraSpawnChance: Math.min(0.62, 0.08 + layered * 0.025 + surge * 0.021),
    supportChance: Math.min(0.48, Math.max(0, (wave - 7) * 0.032)),
    eliteChance: Math.min(0.4, Math.max(0, (wave - 9) * 0.022)),
    telegraphMultiplier,
    specialCooldownMultiplier,
    projectileSpeedScale: 1 + soft * 0.01 + layered * 0.014 + surge * 0.012,
    bossPatternScale: 1 + layered * 0.045 + surge * 0.055,
    scoreMultiplier: (1 + soft * 0.035 + layered * 0.028 + surge * 0.026 + endlessCurve * 0.12) * modifier.score,
    waveLength: Math.min(DIFFICULTY_MODEL.maxWaveSeconds, DIFFICULTY_MODEL.baseWaveSeconds + Math.min(20, wave * 2.3) + Math.min(6, surge * 0.35))
  };
}

function loadMetaProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return {
      essence: Math.max(0, Math.floor(Number(parsed.essence) || 0)),
      upgrades: Object.fromEntries(metaUpgradeCatalog.map((item) => [
        item.id,
        clamp(Math.floor(Number(parsed.upgrades?.[item.id]) || 0), 0, item.max)
      ]))
    };
  } catch {
    return {
      essence: 0,
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
          <small>${item.description}</small>
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

function applyMetaUpgrades() {
  const levels = meta.upgrades || {};
  player.maxHealth += (levels.vitality || 0) * 18;
  player.health = player.maxHealth;
  player.damage += (levels.damage || 0) * 3;
  player.speed += (levels.speed || 0) * 14;
  player.magnet += (levels.magnet || 0) * 22;
  player.relicMax = Math.max(62, player.relicMax - (levels.relic || 0) * 4);
  player.crit += (levels.crit || 0) * 0.02;
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
    fireRate: 0.16,
    projectileSpeed: 820,
    multiShot: 1,
    magnet: 150,
    relic: 0,
    relicMax: 100,
    crit: 0.08,
    regen: 0,
    shield: 0,
    overcharge: 0
  });
  applyMetaUpgrades();
  for (const list of Object.values(pools)) list.length = 0;
  for (let i = 0; i < 30; i += 1) spawnPickup(rand(240, WORLD.width - 240), rand(220, WORLD.height - 220), "bread", 1);
  overlay.classList.add("is-hidden");
  services.resetClaimState("Finish this run to create a Discord bread claim.");
  updateSidebar();
  announce("Wave 1: keep the fur attached.", "#d7ff91");
  showEvent("Wave 1", "Keep the fur attached", "rare");
  showToast("Run started", practice ? "Practice bread is discounted. Shameful, but useful." : "Survive waves, pick relics, leave with bread.", "common");
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
  const elite = !["fragment", "boss", "miniboss"].includes(type) && Math.random() < profile.eliteChance;
  pools.enemies.push({
    type,
    elite,
    x,
    y,
    vx: 0,
    vy: 0,
    hp: spec.hp * healthScale * (elite ? 1.7 : 1),
    maxHp: spec.hp * healthScale * (elite ? 1.7 : 1),
    speed: spec.speed * speedScale * (elite ? 1.08 : 1),
    radius: spec.radius * (elite ? 1.12 : 1),
    damage: spec.damage * damageScale * (elite ? 1.18 : 1),
    value: Math.floor(spec.value * (elite ? 2.2 : 1)),
    color: spec.color,
    hitFlash: 0,
    attackCooldown: 0,
    specialCooldown: rand(1.2, 3.4) * profile.specialCooldownMultiplier,
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
    radius: rand(48, 82 + Math.min(30, profile.threat * 4)),
    life: rand(6.2, 10.5),
    pulse: rand(0, Math.PI * 2)
  });
}

function fireProjectile() {
  if (state.fireCooldown > 0 || state.mode !== "playing") return;
  const dx = pointer.worldX - player.x;
  const dy = pointer.worldY - player.y;
  const angle = Math.atan2(dy, dx);
  const count = player.multiShot;
  const spread = count === 1 ? 0 : 0.12 + count * 0.018;
  const damageMultiplier = player.overcharge > 0 ? 1.45 : 1;
  for (let i = 0; i < count; i += 1) {
    const offset = (i - (count - 1) / 2) * spread;
    const a = angle + offset;
    const crit = Math.random() < player.crit;
    pools.projectiles.push({
      x: player.x + Math.cos(a) * 34,
      y: player.y + Math.sin(a) * 34,
      vx: Math.cos(a) * player.projectileSpeed,
      vy: Math.sin(a) * player.projectileSpeed,
      radius: crit ? 9 : 7,
      damage: player.damage * damageMultiplier * (crit ? 2.15 : 1),
      life: 0.82,
      crit,
      pierce: (crit ? 1 : 0) + (state.flags.has("piercing-shots") ? 1 : 0)
    });
  }
  state.fireCooldown = Math.max(0.06, player.fireRate);
  camera.trauma = Math.max(camera.trauma, 0.06);
  audio.shoot();
}

function relicBurst() {
  if (player.relic < player.relicMax || state.relicCooldown > 0 || state.mode !== "playing") return;
  player.relic = 0;
  state.relicCooldown = 1.2;
  state.flash = 0.38;
  camera.trauma = Math.max(camera.trauma, 0.42);
  showEvent("Relic burst", "The creature objected loudly", "legendary");
  audio.relic();
  const radius = 260 + (100 - player.relicMax) * 3;
  for (const enemy of pools.enemies) {
    const d = Math.sqrt(distanceSq(player, enemy));
    if (d < radius) {
      const damage = 130 + state.wave * 16;
      enemy.hp -= damage;
      enemy.hitFlash = 0.2;
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
  pools.particles.push({ x, y, vx, vy, life, maxLife: life, color, size });
}

function floatingText(x, y, text, color = "#f3fff1") {
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
  toast.innerHTML = `<strong>${safeName(title)}</strong><span>${safeName(detail)}</span>`;
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
  return [...upgrades]
    .sort(() => Math.random() - 0.5)
    .map((upgrade) => {
      const rarity = rarityScore[upgrade.rarity] || 1;
      const lateWaveLift = Math.min(0.72, state.wave / 22);
      return { upgrade, roll: Math.random() + lateWaveLift * (rarity - 1) * 0.24 };
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
  upgradeGrid.innerHTML = options.map((upgrade, index) => `
    <button type="button" class="rarity-${upgrade.rarity || "common"}" data-upgrade="${upgrade.id}" value="${index}">
      <span>${rarityLabel(upgrade.rarity)}</span>
      <b>${upgrade.name}</b>
      <small>${upgrade.description}</small>
    </button>
  `).join("");
  showEvent("Choose a relic", "The den offers three bad ideas", "epic");
  upgradeModal.showModal();
}

function applyUpgrade(upgradeId) {
  const upgrade = upgrades.find((item) => item.id === upgradeId);
  if (!upgrade) return;
  upgrade.apply();
  state.upgrades.push(upgrade.name);
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
  updateSidebar();
  announce(`Wave ${state.wave}: ${upgrade.name}`, "#d7ff91");
  showToast("Relic equipped", upgrade.name, upgrade.rarity || "rare");
  showEvent(`Wave ${state.wave}`, upgrade.name, upgrade.rarity || "rare");
  audio.upgrade();
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
    player.invulnerable = 0.24;
    player.dashCooldown = Math.max(0.35, 0.9 - player.dash * 0.08);
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

function updateWave(dt) {
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
    const roll = Math.random();
    let type = "mite";
    if (state.wave > 2 && roll > 0.72) type = "brute";
    if (state.wave > 1 && roll < 0.22) type = "wisp";
    if (state.wave > 3 && roll > 0.42 && roll < 0.58) type = "spitter";
    if (state.wave > 6 && roll > 0.86) type = "guardian";
    if (state.wave > 4 && roll > 0.58 && roll < 0.68) type = "charger";
    if (state.wave > 5 && roll > 0.31 && roll < 0.41) type = "splitter";
    if (state.wave > 7 && roll > 0.16 && roll < 0.23) type = "healer";
    if (state.wave > 8 && roll > 0.68 && roll < 0.76) type = "mine";
    if (state.wave > 10 && roll > 0.76 && roll < 0.86) type = Math.random() < 0.5 ? "guardian" : "charger";
    if (state.wave > 12 && roll < 0.18) type = Math.random() < 0.55 ? "healer" : "spitter";
    spawnEnemy(type);
    if (state.wave > 4 && Math.random() < profile.extraSpawnChance) spawnEnemy(state.wave > 11 && Math.random() < 0.4 ? "wisp" : "mite");
    if (state.wave > 8 && Math.random() < profile.supportChance) spawnEnemy(Math.random() < 0.5 ? "healer" : "spitter");
    if (state.wave > 14 && Math.random() < 0.12 + Math.min(2.8, pressure) * 0.035) spawnEnemy(Math.random() < 0.5 ? "charger" : "splitter");
    state.spawnTimer = profile.spawnInterval / Math.max(0.78, state.difficulty);
  }
  if (state.wave > 2 && Math.random() < dt * profile.hazardRate) spawnHazard();
  if (state.wave > 13 && Math.random() < dt * Math.min(0.16, pressure * 0.025)) spawnHazard();
  if (state.wave >= 9 && !state.waveClearing && state.waveTimer > waveLength * 0.52 && !state.milestones.has(`skill-check-${state.wave}`)) {
    state.milestones.add(`skill-check-${state.wave}`);
    showEvent("Skill check", "Hazard burst incoming", state.wave >= 14 ? "legendary" : "epic");
    showToast("Skill check", "Move cleanly. Damage now costs bonus bread.", "epic");
    for (let i = 0; i < Math.min(7, 2 + Math.floor(state.wave / 4)); i += 1) spawnHazard();
    camera.trauma = Math.max(camera.trauma, 0.24);
    audio.wave();
  }
  if (state.wave > 3 && state.wave % 3 === 0 && state.wave % 4 !== 0 && !state.bossSpawned && state.waveTimer > 7) {
    spawnEnemy("miniboss");
    state.bossSpawned = true;
    announce("Mini-boss entering the den. Horrible posture.", "#ff9bd6");
    showEvent("Mini-boss", "Horrible posture detected", "epic");
    showToast("Mini-boss entered", "Clear it for stronger drops and essence.", "epic");
    audio.wave();
  }
  if (state.wave % 4 === 0 && !state.bossSpawned && state.waveTimer > 8) {
    spawnEnemy("boss");
    state.bossSpawned = true;
    state.bossAttackTimer = 2;
    announce("Boss thing detected. Deeply rude.", "#ff9797");
    showEvent("Boss wave", "Deeply rude thing detected", "legendary");
    showToast("Boss thing detected", "Break it before the arena becomes a problem.", "legendary");
    audio.wave();
  }
  if (state.wave >= 16 && state.bossSpawned && state.waveTimer > waveLength * 0.68 && state.escalationTimer <= 0 && pools.enemies.some((enemy) => enemy.type === "boss" || enemy.type === "miniboss")) {
    state.escalationTimer = 999;
    showEvent("Phase spike", "The boss called friends", "legendary");
    const adds = Math.min(8, 2 + Math.floor(state.wave / 5));
    for (let i = 0; i < adds; i += 1) spawnEnemy(i % 2 ? "charger" : "spitter");
    camera.trauma = Math.max(camera.trauma, 0.28);
  }
  if (state.waveClearing && pools.enemies.length === 0) {
    if (state.waveDamageTaken <= 0) {
      const bonusBread = Math.max(3, Math.floor(state.wave * 1.5));
      const bonusScore = Math.floor((350 + state.wave * 90) * profile.scoreMultiplier);
      state.bread += bonusBread;
      state.score += bonusScore;
      unlockAchievement("Untouched Fur", "Cleared a wave without taking damage.");
      announce(`Perfect wave: +${bonusBread} bread`, "#fff29b");
      showToast("Perfect wave", `+${bonusBread} bread and +${bonusScore.toLocaleString()} score`, "legendary");
    }
    if (state.wave >= 9 && state.waveDamageTaken > 0) {
      const penalty = Math.min(state.bread, Math.floor(state.waveDamageTaken / 22));
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
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const dist = Math.hypot(dx, dy) || 1;
    const wobble = Math.sin(state.time * 3 + enemy.phase) * (enemy.type === "wisp" ? 0.65 : 0.18);
    const nx = dx / dist;
    const ny = dy / dist;
    enemy.vx += (nx * enemy.speed - ny * enemy.speed * wobble - enemy.vx) * Math.min(1, dt * 2.8);
    enemy.vy += (ny * enemy.speed + nx * enemy.speed * wobble - enemy.vy) * Math.min(1, dt * 2.8);
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

    if (enemy.type === "guardian" && enemy.specialCooldown <= 0) {
      const profile = difficultyProfile();
      shockwave(enemy.x, enemy.y, 118 + Math.min(4, lateWavePressure()) * 12, 24 + Math.min(4, lateWavePressure()) * 6);
      enemy.specialCooldown = rand(4.2, 5.8) * profile.specialCooldownMultiplier;
    }

    if (enemy.type === "healer" && enemy.specialCooldown <= 0) {
      healNearbyEnemies(enemy);
      enemy.specialCooldown = rand(3.2, 4.8) * difficultyProfile().specialCooldownMultiplier;
    }

    if (enemy.type === "miniboss" && enemy.specialCooldown <= 0) {
      miniBossPattern(enemy);
      enemy.specialCooldown = rand(2.4, 3.6) * difficultyProfile().specialCooldownMultiplier;
    }

    if (enemy.type === "boss" && enemy.specialCooldown <= 0) {
      bossPattern(enemy);
      enemy.specialCooldown = Math.max(0.72, (3.4 - state.wave * 0.04) * difficultyProfile().specialCooldownMultiplier);
    }

    if (dist < enemy.radius + player.radius && enemy.attackCooldown <= 0 && player.invulnerable <= 0) {
      let damage = Math.max(2, enemy.damage - player.armor);
      if (state.flags.has("glass-contract")) damage *= 1.22;
      if (player.shield > 0) {
        const blocked = Math.min(player.shield, damage);
        player.shield -= blocked;
        damage -= blocked;
        floatingText(player.x, player.y - 54, `BLOCK ${Math.round(blocked)}`, "#85ffd2");
      }
      player.health -= damage;
      state.waveDamageTaken += damage;
      player.invulnerable = 0.3;
      enemy.attackCooldown = 0.62;
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
  const count = 10 + Math.min(14, state.wave) + Math.floor(Math.min(5, pressure) * 4 * profile.bossPatternScale);
  for (let i = 0; i < count; i += 1) {
    const angle = base + (i - count / 2) * (0.18 - Math.min(0.05, pressure * 0.01));
    spawnEnemyShot(enemy.x, enemy.y, angle, (285 + state.wave * 9 + Math.min(5, pressure) * 28) * profile.projectileSpeedScale, enemy.damage * 0.72, "#ff8f8f", 10 + Math.min(5, pressure) * 0.8);
  }
  if (Math.random() < Math.min(0.82, 0.55 + pressure * 0.07)) {
    pools.hazards.push({
      x: clamp(player.x + rand(-160, 160), 180, WORLD.width - 180),
      y: clamp(player.y + rand(-160, 160), 180, WORLD.height - 180),
      radius: rand(74, 112 + Math.min(5, pressure) * 14),
      life: rand(4.2, 6.2 + Math.min(5, pressure) * 0.7),
      pulse: rand(0, Math.PI * 2)
    });
  }
  if (!state.waveClearing && pressure > 1.1 && Math.random() < 0.38) {
    spawnEnemy(Math.random() < 0.5 ? "healer" : "charger");
  }
  camera.trauma = Math.max(camera.trauma, 0.16);
}

function miniBossPattern(enemy) {
  const base = Math.atan2(player.y - enemy.y, player.x - enemy.x);
  const pressure = lateWavePressure();
  const profile = difficultyProfile();
  const count = 7 + Math.floor(Math.min(5, pressure) * 2 * profile.bossPatternScale);
  for (let i = 0; i < count; i += 1) {
    const angle = base + (i - (count - 1) / 2) * 0.24;
    spawnEnemyShot(enemy.x, enemy.y, angle, (330 + state.wave * 6 + Math.min(5, pressure) * 22) * profile.projectileSpeedScale, enemy.damage * 0.74, "#ff8fd8", 9 + Math.min(5, pressure) * 0.5);
  }
  if (!state.waveClearing && Math.random() < 0.5 + pressure * 0.08) {
    spawnEnemy(Math.random() < 0.45 ? "charger" : Math.random() < 0.65 ? "spitter" : "splitter");
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

function killEnemy(enemy, index) {
  pools.enemies.splice(index, 1);
  state.kills += 1;
  state.combo = clamp(state.combo + 0.08, 1, 4);
  state.comboTimer = 2.5;
  const scoreGain = Math.floor(enemy.value * state.combo * difficultyProfile().scoreMultiplier * (state.flags.has("glass-contract") ? 1.18 : 1));
  state.score += scoreGain;
  const relicGain = enemy.type === "boss" ? 32 : enemy.type === "miniboss" ? 22 : 8;
  player.relic = clamp(player.relic + relicGain, 0, player.relicMax);
  if (state.kills === 25) unlockAchievement("First Furstorm", "25 curse-things removed.");
  if (state.combo >= 3) unlockAchievement("Combo Creature", "Reached a 3x score chain.");
  if (enemy.type === "boss") unlockAchievement("Boss Handler", "Defeated a boss wave.");
  if (enemy.type === "miniboss") unlockAchievement("Mini Problem", "Defeated a mini-boss.");
  audio.pickup();
  floatingText(enemy.x, enemy.y - enemy.radius, `+${scoreGain}`, enemy.color);
  const breadDrops = Math.ceil((enemy.type === "boss" ? 10 : enemy.type === "miniboss" ? 7 : enemy.type === "brute" || enemy.type === "guardian" ? 3 : 1) * (state.flags.has("greed-spiral") ? 1.28 : 1));
  for (let i = 0; i < breadDrops; i += 1) spawnPickup(enemy.x + rand(-24, 24), enemy.y + rand(-24, 24), "bread", enemy.type === "boss" ? 5 : 1);
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
  if (Math.random() < 0.16 || enemy.type === "boss" || enemy.type === "miniboss") spawnPickup(enemy.x, enemy.y, "relic", enemy.type === "boss" ? 18 : enemy.type === "miniboss" ? 14 : 8);
  if (enemy.type === "boss" || enemy.type === "miniboss") {
    spawnPickup(enemy.x + rand(-28, 28), enemy.y + rand(-28, 28), "heart", enemy.type === "boss" ? 36 : 24);
    spawnPickup(enemy.x + rand(-28, 28), enemy.y + rand(-28, 28), "shield", enemy.type === "boss" ? 34 : 24);
  } else if (Math.random() < 0.035) {
    spawnPickup(enemy.x, enemy.y, Math.random() < 0.5 ? "heart" : "overcharge", 16);
  }
  for (let i = 0; i < 20; i += 1) particle(enemy.x, enemy.y, rand(-220, 220), rand(-220, 220), rand(0.28, 0.8), enemy.color, rand(2, 6));
  if (state.flags.has("death-echo") && Math.random() < 0.22) {
    shockwave(enemy.x, enemy.y, 145, 48);
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

function shockwave(x, y, radius, damage) {
  for (const enemy of pools.enemies) {
    const d = Math.sqrt(distanceSq({ x, y }, enemy));
    if (d < radius) {
      enemy.hp -= damage;
      enemy.hitFlash = 0.16;
    }
  }
  for (let i = 0; i < 30; i += 1) {
    const angle = (i / 30) * Math.PI * 2;
    particle(x, y, Math.cos(angle) * 260, Math.sin(angle) * 260, 0.44, "#d7ff91", 3);
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
        enemy.hp -= shot.damage;
        enemy.hitFlash = 0.12;
        enemy.vx += shot.vx * 0.055;
        enemy.vy += shot.vy * 0.055;
        floatingText(enemy.x, enemy.y - enemy.radius, shot.crit ? "CRIT" : Math.round(shot.damage), shot.crit ? "#fff29b" : "#f3fff1");
        for (let p = 0; p < 8; p += 1) particle(shot.x, shot.y, rand(-160, 160), rand(-160, 160), rand(0.18, 0.38), shot.crit ? "#fff29b" : "#caffb8", rand(2, 4));
        if (shot.pierce > 0) shot.pierce -= 1;
        else remove = true;
        break;
      }
    }
    if (remove) pools.projectiles.splice(i, 1);
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
        let damage = Math.max(2, shot.damage - player.armor * 0.6);
        if (state.flags.has("glass-contract")) damage *= 1.22;
        if (player.shield > 0) {
          const blocked = Math.min(player.shield, damage);
          player.shield -= blocked;
          damage -= blocked;
          floatingText(player.x, player.y - 54, `BLOCK ${Math.round(blocked)}`, "#85ffd2");
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
      const damage = Math.max(3, 12 - player.armor) * dt;
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
  loadout.innerHTML = state.upgrades.length
    ? state.upgrades.slice(-10).map((item) => `<span>${safeName(item)}</span>`).join("")
    : "<span>No relics equipped yet.</span>";
  objectives.innerHTML = [
    state.waveClearing ? `Clear the remaining wave ${state.wave} enemies.` : `Survive wave ${state.wave}.`,
    state.waveClearing ? "Spawner paused. Upgrade appears when the arena is clean." : `${Math.max(0, Math.ceil((22 + Math.min(28, state.wave * 3)) - state.waveTimer))} seconds until the wave starts clearing.`,
    `${pools.enemies.length} curse-things active.`,
    player.relic >= player.relicMax ? "Relic burst ready. Press Q." : "Charge relic burst with kills and shards."
  ].map((item) => `<li>${item}</li>`).join("");
  const boss = pools.enemies.find((enemy) => enemy.type === "boss");
  const pressure = lateWavePressure();
  intel.innerHTML = [
    `<span>Biome <b>${safeName(state.biome)}</b></span>`,
    `<span>Modifier <b>${safeName(state.roundModifier)}</b></span>`,
    `<span>Late Pressure <b>${pressure > 0 ? `${pressure.toFixed(1)}x` : "Calm"}</b></span>`,
    `<span>Kills <b>${state.kills}</b></span>`,
    `<span>Shield <b>${Math.ceil(player.shield)}</b></span>`,
    `<span>Overcharge <b>${player.overcharge > 0 ? `${player.overcharge.toFixed(1)}s` : "None"}</b></span>`,
    `<span>Boss <b>${boss ? `${Math.ceil(Math.max(0, boss.hp))} HP` : "Dormant"}</b></span>`,
    `<span>Mini-boss <b>${pools.enemies.some((enemy) => enemy.type === "miniboss") ? "Active" : "Clear"}</b></span>`,
    `<span>Threat Mix <b>${new Set(pools.enemies.map((enemy) => enemy.type)).size || 0}</b></span>`,
    `<span>Achievements <b>${state.achievements.size}</b></span>`
  ].join("");
}

function endRun() {
  state.gameOverHandled = true;
  state.mode = "gameover";
  const bread = Math.floor(state.bread * (state.practice ? 0.4 : 1));
  const essenceEarned = Math.max(4, Math.floor(state.score / 650) + state.wave * 3 + Math.floor(state.kills / 12));
  if (!state.practice) {
    meta.essence += essenceEarned;
    saveMetaProgress();
    renderMetaUpgrades();
  }
  const minutes = Math.floor(state.time / 60);
  const seconds = Math.floor(state.time % 60).toString().padStart(2, "0");
  overlay.classList.remove("is-hidden");
  overlay.querySelector("p").textContent = "Run complete";
  overlay.querySelector("h2").textContent = `${state.score.toLocaleString()} score`;
  overlay.querySelector("span").textContent = `${bread.toLocaleString()} claimable bread. Survived ${minutes}:${seconds}, reached wave ${state.wave}, removed ${state.kills} curse-things, unlocked ${state.achievements.size} achievements, and earned ${state.practice ? 0 : essenceEarned} essence.`;
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
    if (enemy.type === "healer") {
      ctx.save();
      ctx.globalAlpha = 0.22 + Math.sin(state.time * 5 + enemy.phase) * 0.08;
      ctx.strokeStyle = enemy.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 120, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = enemy.hitFlash > 0 ? "#ffffff" : enemy.color;
    ctx.shadowColor = enemy.color;
    ctx.shadowBlur = enemy.type === "boss" || enemy.type === "miniboss" ? 34 : 16;
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
    if (enemy.type === "boss" || enemy.type === "miniboss") {
      ctx.strokeStyle = "rgba(255,255,255,0.68)";
      ctx.lineWidth = enemy.type === "boss" ? 4 : 3;
      ctx.stroke();
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
    ctx.restore();
  }
}

function drawProjectiles() {
  for (const shot of pools.projectiles) {
    ctx.save();
    ctx.fillStyle = shot.crit ? "#fff29b" : "#dcffd4";
    ctx.shadowColor = shot.crit ? "#fff29b" : "#7fff75";
    ctx.shadowBlur = shot.crit ? 20 : 14;
    ctx.beginPath();
    ctx.arc(shot.x, shot.y, shot.radius, 0, Math.PI * 2);
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
  for (const enemy of pools.enemies.slice(0, 80)) {
    ctx.fillStyle = enemy.type === "boss" ? "#ff7373" : enemy.type === "miniboss" ? "#ff8fd8" : enemy.type === "healer" ? "#ff8fd8" : enemy.type === "charger" ? "#ffdf6e" : "#ff7373";
    ctx.fillRect(x + enemy.x * sx - 1.5, y + enemy.y * sy - 1.5, 3, 3);
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
  const button = event.target.closest("button[data-upgrade]");
  if (!button) return;
  applyUpgrade(button.dataset.upgrade);
});
upgradeModal.addEventListener("cancel", (event) => {
  event.preventDefault();
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
services.loadLeaderboard();
updateHud();
updateSidebar();
requestAnimationFrame((time) => {
  state.lastTime = time;
  requestAnimationFrame(loop);
});
