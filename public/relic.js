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
  wave() { this.tone(250, 0.12, "triangle", 0.024); setTimeout(() => this.tone(420, 0.16, "triangle", 0.024), 80); }
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
  bossAttackTimer: 0,
  score: 0,
  bread: 0,
  combo: 1,
  comboTimer: 0,
  kills: 0,
  upgrades: [],
  flags: new Set(),
  achievements: new Set(),
  pauseLatch: false,
  fireCooldown: 0,
  relicCooldown: 0,
  difficulty: 1,
  biome: "Outer Den",
  flash: 0,
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
  regen: 0
};

const upgrades = [
  {
    id: "horns",
    name: "Hollow Horn Voltage",
    description: "Projectiles hit harder and have a higher crit chance.",
    apply() {
      player.damage += 8;
      player.crit += 0.05;
    }
  },
  {
    id: "regen",
    name: "Warm Den Ember",
    description: "Slowly regenerate health while you avoid damage.",
    apply() {
      player.regen += 1.6;
    }
  },
  {
    id: "pierce",
    name: "Artifact Splintering",
    description: "Normal shots pierce one extra enemy.",
    apply() {
      state.flags.add("piercing-shots");
    }
  },
  {
    id: "ward",
    name: "Keeper Ward",
    description: "Taking a hit triggers a short knockback pulse.",
    apply() {
      state.flags.add("hit-ward");
    }
  },
  {
    id: "fur",
    name: "Dense Ritual Fur",
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
    description: "Move faster and recharge dash sooner.",
    apply() {
      player.speed += 48;
      player.dash += 0.16;
    }
  },
  {
    id: "loaf",
    name: "Loaf Magnet",
    description: "Pull bread and relic shards from much farther away.",
    apply() {
      player.magnet += 90;
    }
  },
  {
    id: "burst",
    name: "Relic Overbite",
    description: "Relic burst recharges faster and hits a larger area.",
    apply() {
      player.relicMax = Math.max(55, player.relicMax - 12);
    }
  },
  {
    id: "triple",
    name: "Three Bad Ideas",
    description: "Fire an extra projectile in a spread.",
    apply() {
      player.multiShot = Math.min(5, player.multiShot + 1);
      player.fireRate += 0.015;
    }
  },
  {
    id: "bakery",
    name: "Questionable Bakery",
    description: "Bread pickups heal you slightly.",
    apply() {
      state.flags.add("bakery-heal");
    }
  },
  {
    id: "echo",
    name: "Den Echo",
    description: "Kills have a chance to release a shock ring.",
    apply() {
      state.flags.add("death-echo");
    }
  }
];

const enemyTypes = {
  mite: { hp: 32, speed: 135, radius: 18, damage: 9, value: 22, color: "#9cf66f" },
  brute: { hp: 92, speed: 82, radius: 30, damage: 18, value: 56, color: "#f1c964" },
  wisp: { hp: 22, speed: 190, radius: 14, damage: 7, value: 30, color: "#79eaff" },
  spitter: { hp: 48, speed: 112, radius: 20, damage: 10, value: 46, color: "#c68cff" },
  guardian: { hp: 150, speed: 58, radius: 35, damage: 20, value: 82, color: "#85ffd2" },
  boss: { hp: 720, speed: 64, radius: 54, damage: 26, value: 480, color: "#ff7373" }
};

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
  audio.pickup();
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
    bossAttackTimer: 0,
    score: 0,
    bread: 0,
    combo: 1,
    comboTimer: 0,
    kills: 0,
    upgrades: [],
    flags: new Set(),
    achievements: new Set(),
    fireCooldown: 0,
    relicCooldown: 0,
    difficulty: practice ? 0.78 : 1,
    biome: "Outer Den",
    flash: 0,
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
    regen: 0
  });
  applyMetaUpgrades();
  for (const list of Object.values(pools)) list.length = 0;
  for (let i = 0; i < 30; i += 1) spawnPickup(rand(240, WORLD.width - 240), rand(220, WORLD.height - 220), "bread", 1);
  overlay.classList.add("is-hidden");
  services.resetClaimState("Finish this run to create a Discord bread claim.");
  updateSidebar();
  announce("Wave 1: keep the fur attached.", "#d7ff91");
  audio.ensure();
  audio.wave();
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  VIEW.width = rect.width;
  VIEW.height = rect.height;
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
  pools.enemies.push({
    type,
    x,
    y,
    vx: 0,
    vy: 0,
    hp: spec.hp * (1 + state.wave * 0.12) * state.difficulty,
    maxHp: spec.hp * (1 + state.wave * 0.12) * state.difficulty,
    speed: spec.speed * (1 + state.wave * 0.018),
    radius: spec.radius,
    damage: spec.damage,
    value: spec.value,
    color: spec.color,
    hitFlash: 0,
    attackCooldown: 0,
    specialCooldown: rand(1.2, 3.4),
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
  pools.pickups.push({
    x,
    y,
    vx: rand(-40, 40),
    vy: rand(-40, 40),
    type,
    amount,
    radius: type === "relic" ? 13 : 10,
    life: 30,
    phase: rand(0, Math.PI * 2)
  });
}

function spawnHazard() {
  pools.hazards.push({
    x: rand(260, WORLD.width - 260),
    y: rand(240, WORLD.height - 240),
    radius: rand(48, 82),
    life: rand(7, 11),
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
      damage: player.damage * (crit ? 2.15 : 1),
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

function chooseUpgradeOptions() {
  const shuffled = [...upgrades].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3);
}

function openUpgradeModal() {
  if (state.mode === "upgrade" || state.upgradePending) return;
  state.upgradePending = true;
  state.mode = "upgrade";
  const options = chooseUpgradeOptions();
  upgradeGrid.innerHTML = options.map((upgrade, index) => `
    <button type="button" data-upgrade="${upgrade.id}" value="${index}">
      <b>${upgrade.name}</b>
      <small>${upgrade.description}</small>
    </button>
  `).join("");
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
  state.waveClearing = false;
  state.upgradePending = false;
  upgradeModal.close();
  updateSidebar();
  announce(`Wave ${state.wave}: ${upgrade.name}`, "#d7ff91");
  audio.wave();
}

function update(dt) {
  if (keys.has("p") || keys.has("P")) {
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
  updateCamera(dt);
  updateHud();

  if (player.health <= 0 && !state.gameOverHandled) endRun();
}

function updatePlayer(dt) {
  let ax = 0;
  let ay = 0;
  let padDash = false;
  if (keys.has("w") || keys.has("ArrowUp")) ay -= 1;
  if (keys.has("s") || keys.has("ArrowDown")) ay += 1;
  if (keys.has("a") || keys.has("ArrowLeft")) ax -= 1;
  if (keys.has("d") || keys.has("ArrowRight")) ax += 1;
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

  if ((keys.has(" ") || keys.has("Shift") || padDash) && player.dashCooldown <= 0 && (ax || ay)) {
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
  if (keys.has("q") || keys.has("Q")) relicBurst();
}

function updateWave(dt) {
  const waveLength = 22 + Math.min(28, state.wave * 3);
  state.biome = state.wave > 8 ? "Broken Archive" : state.wave > 4 ? "Green Furnace" : "Outer Den";
  if (!state.waveClearing && state.waveTimer >= waveLength) {
    state.waveClearing = true;
    state.spawnTimer = 999;
    announce(`Wave ${state.wave} clearing: finish the leftovers.`, "#d7ff91");
  }
  const enemyCap = 24 + Math.min(28, state.wave * 3);
  if (!state.waveClearing && state.spawnTimer <= 0 && pools.enemies.length < enemyCap) {
    const roll = Math.random();
    let type = "mite";
    if (state.wave > 2 && roll > 0.72) type = "brute";
    if (state.wave > 1 && roll < 0.22) type = "wisp";
    if (state.wave > 3 && roll > 0.42 && roll < 0.58) type = "spitter";
    if (state.wave > 6 && roll > 0.86) type = "guardian";
    spawnEnemy(type);
    if (state.wave > 4 && Math.random() < 0.18) spawnEnemy("mite");
    state.spawnTimer = Math.max(0.22, 1.05 - state.wave * 0.055) / state.difficulty;
  }
  if (state.wave > 2 && Math.random() < dt * 0.035) spawnHazard();
  if (state.wave % 4 === 0 && !state.bossSpawned && state.waveTimer > 8) {
    spawnEnemy("boss");
    state.bossSpawned = true;
    state.bossAttackTimer = 2;
    announce("Boss thing detected. Deeply rude.", "#ff9797");
    audio.wave();
  }
  if (state.waveClearing && pools.enemies.length === 0) {
    openUpgradeModal();
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

    if (enemy.type === "spitter" && enemy.specialCooldown <= 0 && dist < 760) {
      const angle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
      spawnEnemyShot(enemy.x, enemy.y, angle, 390 + state.wave * 8, enemy.damage, enemy.color, 8);
      enemy.specialCooldown = rand(1.4, 2.5);
      enemy.vx -= nx * 120;
      enemy.vy -= ny * 120;
    }

    if (enemy.type === "guardian" && enemy.specialCooldown <= 0) {
      shockwave(enemy.x, enemy.y, 118, 24);
      enemy.specialCooldown = rand(4.2, 5.8);
    }

    if (enemy.type === "boss" && enemy.specialCooldown <= 0) {
      bossPattern(enemy);
      enemy.specialCooldown = Math.max(1.3, 3.4 - state.wave * 0.08);
    }

    if (dist < enemy.radius + player.radius && enemy.attackCooldown <= 0 && player.invulnerable <= 0) {
      const damage = Math.max(2, enemy.damage - player.armor);
      player.health -= damage;
      player.invulnerable = 0.3;
      enemy.attackCooldown = 0.62;
      camera.trauma = Math.max(camera.trauma, 0.32);
      audio.hit();
      if (state.flags.has("hit-ward")) shockwave(player.x, player.y, 130, 18 + state.wave * 2);
      floatingText(player.x, player.y - 34, `-${Math.round(damage)}`, "#ff9b9b");
      for (let p = 0; p < 16; p += 1) particle(player.x, player.y, rand(-260, 260), rand(-260, 260), rand(0.25, 0.55), "#ff7373", rand(2, 6));
    }

    if (enemy.hp <= 0) killEnemy(enemy, i);
  }
}

function bossPattern(enemy) {
  const base = Math.atan2(player.y - enemy.y, player.x - enemy.x);
  const count = 10 + Math.min(10, state.wave);
  for (let i = 0; i < count; i += 1) {
    const angle = base + (i - count / 2) * 0.18;
    spawnEnemyShot(enemy.x, enemy.y, angle, 285 + state.wave * 9, enemy.damage * 0.7, "#ff8f8f", 10);
  }
  if (Math.random() < 0.55) {
    pools.hazards.push({
      x: clamp(player.x + rand(-160, 160), 180, WORLD.width - 180),
      y: clamp(player.y + rand(-160, 160), 180, WORLD.height - 180),
      radius: rand(74, 112),
      life: rand(4.2, 6.2),
      pulse: rand(0, Math.PI * 2)
    });
  }
  camera.trauma = Math.max(camera.trauma, 0.16);
}

function killEnemy(enemy, index) {
  pools.enemies.splice(index, 1);
  state.kills += 1;
  state.combo = clamp(state.combo + 0.08, 1, 4);
  state.comboTimer = 2.5;
  const scoreGain = Math.floor(enemy.value * state.combo);
  state.score += scoreGain;
  player.relic = clamp(player.relic + (enemy.type === "boss" ? 32 : 8), 0, player.relicMax);
  if (state.kills === 25) unlockAchievement("First Furstorm", "25 curse-things removed.");
  if (state.combo >= 3) unlockAchievement("Combo Creature", "Reached a 3x score chain.");
  if (enemy.type === "boss") unlockAchievement("Boss Handler", "Defeated a boss wave.");
  audio.pickup();
  floatingText(enemy.x, enemy.y - enemy.radius, `+${scoreGain}`, enemy.color);
  const breadDrops = enemy.type === "boss" ? 10 : enemy.type === "brute" ? 3 : 1;
  for (let i = 0; i < breadDrops; i += 1) spawnPickup(enemy.x + rand(-24, 24), enemy.y + rand(-24, 24), "bread", enemy.type === "boss" ? 5 : 1);
  if (Math.random() < 0.16 || enemy.type === "boss") spawnPickup(enemy.x, enemy.y, "relic", enemy.type === "boss" ? 18 : 8);
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
        const damage = Math.max(2, shot.damage - player.armor * 0.6);
        player.health -= damage;
        player.invulnerable = 0.22;
        camera.trauma = Math.max(camera.trauma, 0.24);
        audio.hit();
        floatingText(player.x, player.y - 36, `-${Math.round(damage)}`, "#ff9b9b");
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
      } else {
        player.relic = clamp(player.relic + pickup.amount, 0, player.relicMax);
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
      player.health -= Math.max(3, 12 - player.armor) * dt;
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
  hud.bread.textContent = state.bread;
  hud.score.textContent = state.score.toLocaleString();
  hud.relic.textContent = `${Math.floor((player.relic / player.relicMax) * 100)}%`;
  hud.dash.textContent = player.dashCooldown <= 0 ? "Ready" : `${player.dashCooldown.toFixed(1)}s`;
  hud.combo.textContent = `x${state.combo.toFixed(1)}`;
  difficultyText.textContent = state.practice ? "Practice" : `Threat ${state.difficulty.toFixed(1)}x`;
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
  intel.innerHTML = [
    `<span>Biome <b>${safeName(state.biome)}</b></span>`,
    `<span>Kills <b>${state.kills}</b></span>`,
    `<span>Boss <b>${boss ? `${Math.ceil(Math.max(0, boss.hp))} HP` : "Dormant"}</b></span>`,
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
  drawMinimap();
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
}

function drawEnemies() {
  for (const enemy of pools.enemies) {
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    ctx.fillStyle = enemy.hitFlash > 0 ? "#ffffff" : enemy.color;
    ctx.shadowColor = enemy.color;
    ctx.shadowBlur = enemy.type === "boss" ? 34 : 16;
    ctx.beginPath();
    ctx.arc(0, 0, enemy.radius, 0, Math.PI * 2);
    ctx.fill();
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
    ctx.fillStyle = pickup.type === "bread" ? "#f4c466" : "#7cff73";
    ctx.shadowColor = pickup.type === "bread" ? "#f4c466" : "#7cff73";
    ctx.shadowBlur = 14;
    if (pickup.type === "bread") {
      ctx.beginPath();
      ctx.roundRect(-9, -6, 18, 12, 5);
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
  keys.add(event.key);
  if ([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault();
});
window.addEventListener("keyup", (event) => keys.delete(event.key));
canvas.addEventListener("pointermove", screenToWorld);
canvas.addEventListener("pointerdown", (event) => {
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

resizeCanvas();
renderMetaUpgrades();
services.loadLeaderboard();
updateHud();
updateSidebar();
requestAnimationFrame((time) => {
  state.lastTime = time;
  requestAnimationFrame(loop);
});
