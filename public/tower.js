import {
  clamp,
  createBackgroundCache,
  createGameServices,
  distanceSq,
  rand
} from "/game-common.js";

const canvas = document.querySelector("#towerCanvas");
const ctx = canvas.getContext("2d");
const scoreValue = document.querySelector("#scoreValue");
const breadValue = document.querySelector("#breadValue");
const livesValue = document.querySelector("#livesValue");
const waveValue = document.querySelector("#waveValue");
const statusText = document.querySelector("#statusText");
const playerName = document.querySelector("#playerName");
const startWaveButton = document.querySelector("#startWave");
const resetButton = document.querySelector("#resetGame");
const refreshLeaderboard = document.querySelector("#refreshLeaderboard");
const towerInspector = document.querySelector("#towerInspector");
const mapPicker = document.querySelector("#mapPicker");
const towerShop = document.querySelector("#towerShop");
const enemyIntel = document.querySelector("#enemyIntel");

const services = createGameServices("tower", {
  leaderboardList: document.querySelector("#leaderboardList"),
  leaderboardStatus: document.querySelector("#leaderboardStatus"),
  claimCard: document.querySelector("#claimCard"),
  playerName,
  emptyText: "No defenses recorded yet"
});

const TILE = 60;
const COLS = 16;
const ROWS = 9;
const PROGRESS_KEY = "chipkittle-tower-progress-v2";
const STARTING_TOWERS = new Set(["thorn", "needle", "relic", "spore"]);

const maps = {
  den: {
    name: "Green Den",
    difficulty: "Starter",
    reward: 1,
    bread: 105,
    lives: 24,
    color: "#8dff71",
    description: "One readable path with generous build space. Good for learning tower roles.",
    blocked: [[6, 5], [7, 5], [8, 5], [2, 2], [12, 2]],
    zones: [
      { id: "focus", name: "Focus Moss", col: 5, row: 3, radius: 1.25, type: "buff", stat: "range", amount: 1.12, color: "#8dff71" }
    ],
    paths: [[
      [0, 4], [1, 4], [2, 4], [3, 4], [4, 4],
      [4, 3], [4, 2], [5, 2], [6, 2], [7, 2],
      [7, 3], [7, 4], [8, 4], [9, 4], [10, 4],
      [10, 5], [10, 6], [11, 6], [12, 6], [13, 6],
      [13, 5], [13, 4], [14, 4], [15, 4]
    ]]
  },
  pantry: {
    name: "Split Pantry",
    difficulty: "Medium",
    reward: 1.18,
    bread: 120,
    lives: 22,
    color: "#fff29b",
    description: "Two entrances merge near the vault. Split defenses or get folded.",
    blocked: [[7, 1], [8, 1], [7, 7], [8, 7], [5, 4], [11, 4]],
    zones: [
      { id: "crumb-tax", name: "Crumb Tax", col: 8, row: 4, radius: 1.35, type: "debuff", stat: "enemySpeed", amount: 0.9, color: "#fff29b" }
    ],
    paths: [
      [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [4, 3], [5, 3], [6, 3], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4], [13, 4], [14, 4], [15, 4]],
      [[0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [4, 5], [5, 5], [6, 5], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4], [13, 4], [14, 4], [15, 4]]
    ]
  },
  archive: {
    name: "Archive Spiral",
    difficulty: "Hard",
    reward: 1.34,
    bread: 135,
    lives: 20,
    color: "#ba7cff",
    description: "A long spiral path creates strong choke points, but archive tiles block greedy builds.",
    blocked: [[3, 1], [4, 1], [11, 1], [12, 1], [3, 7], [4, 7], [11, 7], [12, 7], [7, 4], [8, 4]],
    zones: [
      { id: "archive", name: "Archive Static", col: 7, row: 4, radius: 1.5, type: "buff", stat: "damage", amount: 1.13, color: "#ba7cff" }
    ],
    paths: [[
      [0, 1], [1, 1], [2, 1], [2, 2], [2, 3], [3, 3], [4, 3], [5, 3],
      [5, 4], [5, 5], [6, 5], [7, 5], [8, 5], [9, 5], [10, 5],
      [10, 4], [10, 3], [11, 3], [12, 3], [13, 3], [13, 4], [13, 5], [14, 5], [15, 5]
    ]]
  },
  furnace: {
    name: "Furnace Fork",
    difficulty: "Brutal",
    reward: 1.52,
    bread: 145,
    lives: 18,
    color: "#ff8f5c",
    description: "Short split lanes, heat vents, and less reaction time. Splash and slow matter.",
    blocked: [[4, 4], [5, 4], [10, 4], [11, 4], [7, 2], [8, 6]],
    zones: [
      { id: "heat-a", name: "Heat Vent", col: 6, row: 3, radius: 1.1, type: "hazard", damage: 5, color: "#ff8f5c" },
      { id: "heat-b", name: "Heat Vent", col: 9, row: 5, radius: 1.1, type: "hazard", damage: 5, color: "#ff8f5c" }
    ],
    paths: [
      [[0, 3], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 4], [8, 4], [9, 4], [10, 3], [11, 3], [12, 3], [13, 3], [14, 4], [15, 4]],
      [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 4], [8, 4], [9, 4], [10, 5], [11, 5], [12, 5], [13, 5], [14, 4], [15, 4]]
    ]
  }
};

const towerTypes = {
  thorn: { name: "Thorn Sprayer", role: "Balanced DPS", unlockWave: 1, cost: 35, color: "#8dff71", range: 138, fireRate: 0.36, damage: 15, projectileSpeed: 620, tags: ["basic"], strong: ["normal"], weak: ["shield"], description: "Reliable pressure with no weird requirements." },
  needle: { name: "Needle Nest", role: "Rapid anti-swarm", unlockWave: 1, cost: 42, color: "#79eaff", range: 118, fireRate: 0.15, damage: 6, projectileSpeed: 720, tags: ["rapid", "swarm"], strong: ["swarm", "split"], weak: ["armor"], description: "Shreds small enemies but struggles against armor." },
  relic: { name: "Relic Mortar", role: "Splash control", unlockWave: 1, cost: 62, color: "#fff29b", range: 178, fireRate: 1.12, damage: 36, projectileSpeed: 430, splash: 76, tags: ["splash"], strong: ["swarm", "split"], weak: ["fast"], description: "Explodes clusters. Misses fast nonsense if unsupported." },
  spore: { name: "Spore Lantern", role: "Slow/debuff", unlockWave: 1, cost: 48, color: "#ba7cff", range: 128, fireRate: 0.62, damage: 8, projectileSpeed: 540, splash: 46, slow: 0.42, weaken: 0.08, tags: ["slow", "debuff"], strong: ["fast"], weak: ["boss"], description: "Slows groups and makes them easier to damage." },
  horn: { name: "Horn Sniper", role: "Long-range burst", unlockWave: 4, cost: 78, color: "#f7fff4", range: 265, fireRate: 1.35, damage: 88, projectileSpeed: 980, pierce: 1, tags: ["sniper", "armor"], strong: ["armor", "boss"], weak: ["swarm"], description: "Huge range and armor cracking. Terrible into crowds." },
  kiln: { name: "Bread Kiln", role: "Burn/status", unlockWave: 6, cost: 70, color: "#ff8f5c", range: 142, fireRate: 0.82, damage: 18, projectileSpeed: 520, splash: 54, burn: 4.8, tags: ["burn", "status"], strong: ["regen", "swarm"], weak: ["shield"], description: "Burns enemies after impact and keeps pressure rolling." },
  prism: { name: "Prism Conduit", role: "Chain lightning", unlockWave: 8, cost: 88, color: "#7cf7ff", range: 154, fireRate: 0.72, damage: 21, projectileSpeed: 860, chain: 3, tags: ["chain"], strong: ["packed", "fast"], weak: ["boss"], description: "Chains between nearby enemies. Loves messy split paths." },
  antler: { name: "Antler Breaker", role: "Anti-armor", unlockWave: 10, cost: 92, color: "#ff8fd8", range: 156, fireRate: 0.58, damage: 26, projectileSpeed: 660, armorBreak: 34, tags: ["armor", "shield"], strong: ["shield", "armor"], weak: ["swarm"], description: "Deletes shields and chunks armored enemies." },
  keeper: { name: "Keeper Totem", role: "Support buff", unlockWave: 12, cost: 82, color: "#c9ff8f", range: 128, fireRate: 999, damage: 0, projectileSpeed: 0, auraDamage: 1.18, auraRate: 0.88, tags: ["support"], strong: ["towers"], weak: ["solo"], description: "Does not attack. Buffs nearby tower damage and fire rate." }
};

const branchUpgrades = {
  overclock: { name: "Overclocked", detail: "+30% fire rate, -8% range.", apply(stats) { stats.fireRate *= 0.7; stats.range *= 0.92; } },
  focus: { name: "Focusing Lens", detail: "+22% range, +18% damage.", apply(stats) { stats.range *= 1.22; stats.damage *= 1.18; } },
  cruel: { name: "Cruel Barbs", detail: "+42% damage against tough enemies.", apply(stats) { stats.toughBonus = (stats.toughBonus || 1) * 1.42; } },
  wide: { name: "Wide Curse", detail: "+28% splash/chain reach.", apply(stats) { stats.splash *= 1.28; stats.chainRange = (stats.chainRange || 105) * 1.28; } }
};

const enemyTypes = {
  mite: { name: "Curse Mite", class: "swarm", hp: 42, speed: 56, reward: 7, damage: 1, color: "#ff7676", radius: 14, resist: { armor: 0, burn: 1, slow: 1, shield: 1 } },
  runner: { name: "Vault Runner", class: "fast", hp: 34, speed: 96, reward: 8, damage: 1, color: "#ffb86c", radius: 12, resist: { armor: 0, burn: 1, slow: 0.82, shield: 1 } },
  brute: { name: "Bread Brute", class: "armor", hp: 132, armor: 7, speed: 42, reward: 16, damage: 2, color: "#ff6fb1", radius: 18, resist: { armor: 1, burn: 1.1, slow: 0.92, shield: 1 } },
  shield: { name: "Plate Keeper", class: "shield", hp: 76, shield: 88, armor: 4, speed: 48, reward: 19, damage: 2, color: "#85ffd2", radius: 17, resist: { armor: 1, burn: 0.8, slow: 0.9, shield: 1.45 } },
  splitter: { name: "Split Crumb", class: "split", hp: 68, speed: 58, reward: 13, damage: 1, color: "#d7ff91", radius: 15, splits: true, resist: { armor: 0, burn: 1, slow: 1, shield: 1 } },
  regenerator: { name: "Loaf Mender", class: "regen", hp: 96, speed: 46, reward: 18, damage: 1, color: "#9cff74", radius: 16, regen: 4.2, resist: { armor: 0, burn: 1.35, slow: 1, shield: 1 } },
  boss: { name: "Antler Auditor", class: "boss", hp: 430, shield: 120, armor: 8, speed: 34, reward: 64, damage: 5, color: "#f7fff4", radius: 26, resist: { armor: 1, burn: 0.78, slow: 0.55, shield: 1.25 } }
};

const towers = [];
const enemies = [];
const shots = [];
const particles = [];
const floaters = [];

let selectedTowerType = "thorn";
let selectedTowerId = null;
let hoverCell = null;
let selectedMapId = "den";
let activeMap = maps.den;
let pathSets = [];
let pathPointSets = [];
let blockedSet = new Set();
let running = false;
let ended = false;
let scoreSaved = false;
let lastTime = 0;
let score = 0;
let bread = 105;
let claimBread = 0;
let lives = 24;
let wave = 1;
let spawnQueue = [];
let spawnTimer = 0;
let waveActive = false;
let nextTowerId = 1;
let statusCache = "";
let statsCache = "";
let animationFrame = 0;
let progress = loadProgress();

const drawBackground = createBackgroundCache(canvas, (cacheCtx, targetCanvas, key) => {
  const map = maps[key] || maps.den;
  const gradient = cacheCtx.createRadialGradient(710, 250, 80, 480, 270, 640);
  gradient.addColorStop(0, `${map.color}55`);
  gradient.addColorStop(0.52, "#8fa696");
  gradient.addColorStop(1, "#31413a");
  cacheCtx.fillStyle = gradient;
  cacheCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

  cacheCtx.strokeStyle = "rgba(12, 28, 18, 0.12)";
  cacheCtx.lineWidth = 1;
  for (let x = 0; x <= targetCanvas.width; x += TILE) {
    cacheCtx.beginPath();
    cacheCtx.moveTo(x, 0);
    cacheCtx.lineTo(x, targetCanvas.height);
    cacheCtx.stroke();
  }
  for (let y = 0; y <= targetCanvas.height; y += TILE) {
    cacheCtx.beginPath();
    cacheCtx.moveTo(0, y);
    cacheCtx.lineTo(targetCanvas.width, y);
    cacheCtx.stroke();
  }

  for (const path of map.paths.map(cellsToPoints)) {
    cacheCtx.lineCap = "round";
    cacheCtx.lineJoin = "round";
    cacheCtx.strokeStyle = "rgba(62, 48, 39, 0.78)";
    cacheCtx.lineWidth = 48;
    cacheCtx.beginPath();
    path.forEach((point, index) => index ? cacheCtx.lineTo(point.x, point.y) : cacheCtx.moveTo(point.x, point.y));
    cacheCtx.stroke();
    cacheCtx.strokeStyle = "rgba(244, 223, 156, 0.58)";
    cacheCtx.lineWidth = 28;
    cacheCtx.stroke();
  }

  for (const [col, row] of map.blocked || []) {
    cacheCtx.fillStyle = "rgba(9, 20, 14, 0.42)";
    cacheCtx.strokeStyle = "rgba(255,255,255,0.16)";
    cacheCtx.lineWidth = 2;
    cacheCtx.beginPath();
    cacheCtx.roundRect(col * TILE + 8, row * TILE + 8, TILE - 16, TILE - 16, 12);
    cacheCtx.fill();
    cacheCtx.stroke();
  }

  for (const zone of map.zones || []) {
    cacheCtx.globalAlpha = 0.22;
    cacheCtx.fillStyle = zone.color;
    cacheCtx.beginPath();
    cacheCtx.arc(zone.col * TILE + TILE / 2, zone.row * TILE + TILE / 2, zone.radius * TILE, 0, Math.PI * 2);
    cacheCtx.fill();
    cacheCtx.globalAlpha = 1;
  }

  cacheCtx.fillStyle = "rgba(8, 24, 13, 0.5)";
  cacheCtx.fillRect(0, 0, 12, targetCanvas.height);
  cacheCtx.fillStyle = `${map.color}70`;
  cacheCtx.beginPath();
  cacheCtx.roundRect(targetCanvas.width - 88, 200, 78, 140, 22);
  cacheCtx.fill();
});

function loadProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return {
      bestWave: Math.max(0, Math.floor(Number(parsed.bestWave) || 0)),
      completedMaps: Array.isArray(parsed.completedMaps) ? parsed.completedMaps : []
    };
  } catch {
    return { bestWave: 0, completedMaps: [] };
  }
}

function saveProgress() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

function isTowerUnlocked(towerId) {
  const tower = towerTypes[towerId];
  return STARTING_TOWERS.has(towerId) || progress.bestWave >= tower.unlockWave;
}

function cellsToPoints(cells) {
  return cells.map(([x, y]) => ({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }));
}

function configureMap(mapId) {
  selectedMapId = mapId;
  activeMap = maps[mapId] || maps.den;
  pathPointSets = activeMap.paths.map(cellsToPoints);
  pathSets = activeMap.paths.map((path) => new Set(path.map(([x, y]) => `${x},${y}`)));
  blockedSet = new Set((activeMap.blocked || []).map(([x, y]) => `${x},${y}`));
}

function allPathSet() {
  return new Set(pathSets.flatMap((set) => [...set]));
}

function buildWave(number) {
  const queue = [];
  const pressure = Math.max(0, number - 1);
  const laneCount = activeMap.paths.length;
  const base = 8 + Math.floor(number * 1.65) + laneCount * 2;
  for (let i = 0; i < base; i += 1) queue.push("mite");
  if (number >= 2) for (let i = 0; i < 3 + Math.floor(number / 2); i += 1) queue.push("runner");
  if (number >= 4) for (let i = 0; i < 2 + Math.floor(number / 3); i += 1) queue.push("brute");
  if (number >= 6) for (let i = 0; i < 2 + Math.floor(number / 4); i += 1) queue.push("shield");
  if (number >= 8) for (let i = 0; i < 2 + Math.floor(number / 5); i += 1) queue.push("splitter");
  if (number >= 11) for (let i = 0; i < 1 + Math.floor(number / 6); i += 1) queue.push("regenerator");
  if (number % 7 === 0) queue.push("boss");
  if (number % 5 === 0) queue.push("brute", "shield", "runner", "splitter");
  return queue
    .sort(() => Math.random() - 0.5)
    .map((type, index) => ({
      type,
      pathIndex: index % laneCount,
      delay: Math.max(0.16, 0.82 - pressure * 0.016 - laneCount * 0.05 - (index % 4) * 0.035)
    }));
}

function updateStats() {
  const next = `${Math.floor(score)}:${bread}:${lives}:${wave}:${selectedMapId}`;
  if (statsCache === next) return;
  statsCache = next;
  scoreValue.textContent = Math.floor(score).toLocaleString();
  breadValue.textContent = String(bread);
  livesValue.textContent = String(lives);
  waveValue.textContent = String(wave);
}

function setStatus(text) {
  if (statusCache === text) return;
  statusCache = text;
  statusText.textContent = text;
}

function ensurePlayerReady() {
  if (services.hasPlayerName()) {
    services.persistPlayerName();
    services.setLeaderboardStatus("");
    return true;
  }
  services.setLeaderboardStatus("Add your player name before defending the vault.");
  services.focusPlayerName();
  return false;
}

function resetGame() {
  towers.length = 0;
  enemies.length = 0;
  shots.length = 0;
  particles.length = 0;
  floaters.length = 0;
  selectedTowerId = null;
  running = false;
  ended = false;
  scoreSaved = false;
  lastTime = 0;
  score = 0;
  bread = activeMap.bread;
  claimBread = 0;
  lives = activeMap.lives;
  wave = 1;
  spawnQueue = [];
  spawnTimer = 0;
  waveActive = false;
  nextTowerId = 1;
  startWaveButton.disabled = false;
  startWaveButton.textContent = "Start Wave";
  services.resetClaimState("Defend the vault, then lose or finish to get a claim code.");
  setStatus(`${activeMap.name}: ${activeMap.description}`);
  updateStats();
  renderMapPicker();
  renderTowerShop();
  renderInspector();
  draw();
}

function startWave() {
  if (ended || waveActive) return;
  if (!ensurePlayerReady()) return;
  running = true;
  waveActive = true;
  spawnQueue = buildWave(wave);
  spawnTimer = 0.2;
  startWaveButton.disabled = true;
  startWaveButton.textContent = "Wave Active";
  setStatus(`Wave ${wave} started on ${activeMap.name}. ${spawnQueue.length} problems inbound.`);
}

function finishRun() {
  progress.bestWave = Math.max(progress.bestWave, wave);
  if (wave >= 12 && !progress.completedMaps.includes(selectedMapId)) progress.completedMaps.push(selectedMapId);
  saveProgress();
  renderTowerShop();
  renderMapPicker();
}

function endGame() {
  if (ended) return;
  ended = true;
  running = false;
  waveActive = false;
  finishRun();
  startWaveButton.disabled = true;
  startWaveButton.textContent = "Vault Lost";
  setStatus("The vault fell. A tragic bread-based incident.");
  services.createClaimCode({ score, bread: claimBread });
  if (!scoreSaved) {
    scoreSaved = true;
    services.submitScore({ score, bread: claimBread });
  }
}

function pointerInfo(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  return { x, y, col: Math.floor(x / TILE), row: Math.floor(y / TILE) };
}

function towerAt(col, row) {
  return towers.find((tower) => tower.col === col && tower.row === row);
}

function terrainAt(col, row) {
  const key = `${col},${row}`;
  if (allPathSet().has(key)) return "path";
  if (blockedSet.has(key)) return "blocked";
  return "build";
}

function canPlace(col, row) {
  return col >= 0 && col < COLS && row >= 0 && row < ROWS && terrainAt(col, row) === "build" && !towerAt(col, row);
}

function zoneMultiplier(col, row, stat) {
  let value = 1;
  for (const zone of activeMap.zones || []) {
    if (zone.type !== "buff" || zone.stat !== stat) continue;
    const dx = col - zone.col;
    const dy = row - zone.row;
    if (Math.hypot(dx, dy) <= zone.radius) value *= zone.amount;
  }
  return value;
}

function auraMultiplier(tower, stat) {
  let value = 1;
  for (const other of towers) {
    if (other.id === tower.id || other.type !== "keeper") continue;
    const keeperStats = towerStats(other, { ignoreAuras: true });
    if (distanceSq(tower, other) > keeperStats.range ** 2) continue;
    if (stat === "damage") value *= keeperStats.auraDamage || 1;
    if (stat === "fireRate") value *= keeperStats.auraRate || 1;
  }
  return value;
}

function placeTower(col, row) {
  const spec = towerTypes[selectedTowerType];
  if (!spec || !isTowerUnlocked(selectedTowerType)) return;
  if (!canPlace(col, row)) {
    setStatus(terrainAt(col, row) === "path" ? "That is the path. It is busy being walked on." : "That tile cannot hold a tower.");
    return;
  }
  if (bread < spec.cost) {
    setStatus(`Need ${spec.cost} bread for ${spec.name}. Current bread: ${bread}.`);
    return;
  }
  bread -= spec.cost;
  const tower = {
    id: nextTowerId,
    type: selectedTowerType,
    col,
    row,
    x: col * TILE + TILE / 2,
    y: row * TILE + TILE / 2,
    level: 1,
    branch: "",
    cooldown: 0,
    spent: spec.cost
  };
  nextTowerId += 1;
  towers.push(tower);
  selectedTowerId = tower.id;
  setStatus(`${spec.name} placed. ${spec.role} is now somebody else's problem.`);
  burst(tower.x, tower.y, spec.color, 18);
  updateStats();
  renderInspector();
}

function selectedTower() {
  return towers.find((tower) => tower.id === selectedTowerId) || null;
}

function towerStats(tower, options = {}) {
  const spec = towerTypes[tower.type];
  const levelBonus = tower.level - 1;
  const stats = {
    ...spec,
    range: spec.range + levelBonus * 12,
    damage: Math.round(spec.damage * (1 + levelBonus * 0.34)),
    fireRate: Math.max(0.08, spec.fireRate * (1 - levelBonus * 0.055)),
    splash: (spec.splash || 0) + levelBonus * 7,
    slow: spec.slow ? Math.min(0.72, spec.slow + levelBonus * 0.045) : 0,
    burn: spec.burn ? spec.burn + levelBonus * 0.8 : 0,
    chain: spec.chain ? spec.chain + Math.floor(levelBonus / 2) : 0,
    armorBreak: spec.armorBreak ? spec.armorBreak + levelBonus * 6 : 0,
    chainRange: 105 + levelBonus * 8,
    upgradeCost: Math.floor(spec.cost * (0.72 + tower.level * 0.56)),
    branchCost: Math.floor(spec.cost * 1.4)
  };
  if (tower.branch && branchUpgrades[tower.branch]) branchUpgrades[tower.branch].apply(stats);
  if (!options.ignoreAuras) {
    stats.damage *= auraMultiplier(tower, "damage") * zoneMultiplier(tower.col, tower.row, "damage");
    stats.fireRate *= auraMultiplier(tower, "fireRate");
    stats.range *= zoneMultiplier(tower.col, tower.row, "range");
  }
  stats.damage = Math.round(stats.damage);
  return stats;
}

function renderMapPicker() {
  mapPicker.innerHTML = Object.entries(maps).map(([id, map]) => {
    const complete = progress.completedMaps.includes(id);
    return `
      <button type="button" class="map-choice ${id === selectedMapId ? "is-active" : ""}" data-map="${id}" ${waveActive || towers.length ? "disabled" : ""}>
        <span>${map.name}</span>
        <small>${map.difficulty} · ${map.paths.length} lane${map.paths.length > 1 ? "s" : ""}${complete ? " · cleared" : ""}</small>
      </button>
    `;
  }).join("");
}

function renderTowerShop() {
  towerShop.innerHTML = Object.entries(towerTypes).map(([id, tower]) => {
    const unlocked = isTowerUnlocked(id);
    return `
      <button class="tower-choice ${id === selectedTowerType ? "is-active" : ""}" type="button" data-tower="${id}" ${unlocked ? "" : "disabled"}>
        <span>${tower.name}</span>
        <small>${unlocked ? `${tower.role} · ${tower.cost} bread` : `Unlock at best wave ${tower.unlockWave}`}</small>
      </button>
    `;
  }).join("");
}

function renderInspector() {
  const tower = selectedTower();
  const preview = towerTypes[selectedTowerType];
  if (!tower) {
    towerInspector.innerHTML = `
      <span>${preview.name}</span>
      <small>${preview.description}</small>
      <small><b>Strong:</b> ${preview.strong.join(", ")} · <b>Weak:</b> ${preview.weak.join(", ")}</small>
      <small>Click an open tile to build for ${preview.cost} bread.</small>
    `;
    return;
  }
  const stats = towerStats(tower);
  const branches = Object.entries(branchUpgrades).map(([id, branch]) => `
    <button type="button" data-branch-tower="${id}" ${tower.branch ? "disabled" : ""}>${branch.name}</button>
  `).join("");
  towerInspector.innerHTML = `
    <span>${stats.name} · Level ${tower.level}${tower.branch ? ` · ${branchUpgrades[tower.branch].name}` : ""}</span>
    <small>${stats.description}</small>
    <small>Damage ${stats.damage}, range ${Math.round(stats.range)}, rate ${stats.fireRate.toFixed(2)}s${stats.splash ? `, splash ${Math.round(stats.splash)}` : ""}${stats.chain ? `, chains ${stats.chain}` : ""}.</small>
    <div class="tower-actions">
      <button type="button" data-upgrade-tower>Upgrade · ${stats.upgradeCost}</button>
      <button type="button" data-sell-tower>Sell · ${Math.floor(tower.spent * 0.58)}</button>
    </div>
    ${tower.level >= 3 ? `<small>Branch upgrade${tower.branch ? `: ${branchUpgrades[tower.branch].detail}` : ` · ${stats.branchCost} bread`}</small><div class="tower-branches">${branches}</div>` : `<small>Reach level 3 to pick a branch upgrade.</small>`}
  `;
}

function renderEnemyIntel() {
  const counts = enemies.reduce((map, enemy) => map.set(enemy.className, (map.get(enemy.className) || 0) + 1), new Map());
  const active = [...counts.entries()].map(([name, count]) => `${name} x${count}`).join(" · ");
  enemyIntel.innerHTML = `
    <span>Enemy Intel</span>
    <small>${active || "No enemies active. Next wave will adapt to the map."}</small>
  `;
}

function upgradeTower() {
  const tower = selectedTower();
  if (!tower) return;
  const stats = towerStats(tower);
  if (bread < stats.upgradeCost) {
    setStatus(`Need ${stats.upgradeCost} bread to upgrade ${stats.name}.`);
    return;
  }
  bread -= stats.upgradeCost;
  tower.spent += stats.upgradeCost;
  tower.level += 1;
  setStatus(`${stats.name} upgraded to level ${tower.level}.`);
  burst(tower.x, tower.y, stats.color, 24);
  updateStats();
  renderInspector();
}

function branchTower(branchId) {
  const tower = selectedTower();
  if (!tower || tower.branch || tower.level < 3) return;
  const stats = towerStats(tower);
  if (bread < stats.branchCost) {
    setStatus(`Need ${stats.branchCost} bread for ${branchUpgrades[branchId].name}.`);
    return;
  }
  bread -= stats.branchCost;
  tower.spent += stats.branchCost;
  tower.branch = branchId;
  setStatus(`${stats.name} specialized into ${branchUpgrades[branchId].name}.`);
  burst(tower.x, tower.y, stats.color, 34);
  updateStats();
  renderInspector();
}

function sellTower() {
  const tower = selectedTower();
  if (!tower) return;
  const index = towers.indexOf(tower);
  if (index >= 0) towers.splice(index, 1);
  const refund = Math.floor(tower.spent * 0.58);
  bread += refund;
  selectedTowerId = null;
  setStatus(`Tower sold for ${refund} bread. Economically questionable, but allowed.`);
  updateStats();
  renderInspector();
}

function spawnEnemy(type, pathIndex = 0, progress = 0, segment = 0) {
  const spec = enemyTypes[type] || enemyTypes.mite;
  const scale = 1 + (wave - 1) * 0.17 + Math.max(0, wave - 10) * 0.05;
  const path = pathPointSets[pathIndex] || pathPointSets[0];
  enemies.push({
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    type,
    className: spec.class,
    name: spec.name,
    pathIndex,
    x: path[0].x,
    y: path[0].y,
    segment,
    progress,
    hp: Math.round(spec.hp * scale),
    maxHp: Math.round(spec.hp * scale),
    shield: Math.round((spec.shield || 0) * (1 + wave * 0.12)),
    maxShield: Math.round((spec.shield || 0) * (1 + wave * 0.12)),
    armor: spec.armor || 0,
    speed: spec.speed * (1 + (wave - 1) * 0.018),
    reward: Math.round(spec.reward * (1 + wave * 0.08) * activeMap.reward),
    damage: spec.damage,
    color: spec.color,
    radius: spec.radius,
    resist: spec.resist || {},
    splits: spec.splits,
    regen: spec.regen || 0,
    burn: 0,
    poison: 0,
    slow: 0,
    slowPower: 0,
    weaken: 0,
    escaped: false
  });
}

function burst(x, y, color, count = 10, speed = 170) {
  for (let i = 0; i < count; i += 1) {
    const angle = rand(0, Math.PI * 2);
    particles.push({ x, y, vx: Math.cos(angle) * rand(30, speed), vy: Math.sin(angle) * rand(30, speed), radius: rand(2, 5), life: rand(0.25, 0.66), maxLife: 0.66, color });
  }
}

function floater(x, y, text, color = "#f7fff4") {
  floaters.push({ x, y, text, color, life: 1.1, maxLife: 1.1 });
}

function moveEnemy(enemy, dt) {
  const path = pathPointSets[enemy.pathIndex] || pathPointSets[0];
  const zoneSpeed = activeMap.zones?.some((zone) => zone.type === "debuff" && zone.stat === "enemySpeed" && Math.hypot(enemy.x / TILE - zone.col, enemy.y / TILE - zone.row) <= zone.radius)
    ? activeMap.zones.find((zone) => zone.type === "debuff" && zone.stat === "enemySpeed")?.amount || 1
    : 1;
  const speed = enemy.speed * (enemy.slow > 0 ? 1 - enemy.slowPower * (enemy.resist.slow || 1) : 1) * zoneSpeed;
  let travel = speed * dt;
  while (travel > 0 && enemy.segment < path.length - 1) {
    const a = path[enemy.segment];
    const b = path[enemy.segment + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const remaining = length * (1 - enemy.progress);
    if (travel < remaining) {
      enemy.progress += travel / length;
      travel = 0;
    } else {
      travel -= remaining;
      enemy.segment += 1;
      enemy.progress = 0;
    }
  }
  if (enemy.segment >= path.length - 1) {
    enemy.escaped = true;
    return;
  }
  const a = path[enemy.segment];
  const b = path[enemy.segment + 1];
  enemy.x = a.x + (b.x - a.x) * enemy.progress;
  enemy.y = a.y + (b.y - a.y) * enemy.progress;
}

function targetFor(tower, stats) {
  let best = null;
  let bestPath = -1;
  for (const enemy of enemies) {
    if (distanceSq(tower, enemy) > stats.range ** 2) continue;
    const pathValue = enemy.segment + enemy.progress;
    if (pathValue > bestPath) {
      best = enemy;
      bestPath = pathValue;
    }
  }
  return best;
}

function updateTowers(dt) {
  for (const tower of towers) {
    const stats = towerStats(tower);
    if (tower.type === "keeper") continue;
    tower.cooldown -= dt;
    if (tower.cooldown > 0) continue;
    const target = targetFor(tower, stats);
    if (!target) continue;
    tower.cooldown = stats.fireRate;
    shots.push({ x: tower.x, y: tower.y, targetId: target.id, sourceType: tower.type, speed: stats.projectileSpeed, damage: stats.damage, splash: stats.splash || 0, slow: stats.slow || 0, weaken: stats.weaken || 0, burn: stats.burn || 0, chain: stats.chain || 0, chainRange: stats.chainRange || 105, armorBreak: stats.armorBreak || 0, toughBonus: stats.toughBonus || 1, color: stats.color, radius: tower.type === "horn" ? 4 : 6 });
  }
}

function damageEnemy(enemy, amount, shot = {}) {
  let damage = amount;
  if (shot.toughBonus && ["armor", "shield", "boss"].includes(enemy.className)) damage *= shot.toughBonus;
  if (shot.armorBreak && enemy.shield > 0) damage += shot.armorBreak * (enemy.resist.shield || 1);
  damage *= 1 + enemy.weaken;
  damage = Math.max(1, damage - enemy.armor * (shot.armorBreak ? 0.25 : 1));
  if (enemy.shield > 0) {
    const blocked = Math.min(enemy.shield, damage);
    enemy.shield -= blocked;
    damage -= blocked;
  }
  enemy.hp -= damage;
  return damage;
}

function applyShotEffects(enemy, shot) {
  if (shot.slow > 0) {
    enemy.slow = Math.max(enemy.slow, 1.9);
    enemy.slowPower = Math.max(enemy.slowPower, shot.slow);
  }
  if (shot.weaken > 0) enemy.weaken = Math.max(enemy.weaken, shot.weaken);
  if (shot.burn > 0) enemy.burn = Math.max(enemy.burn, shot.burn);
}

function hitEnemy(enemy, shot) {
  const affected = [enemy];
  if (shot.splash > 0) {
    for (const other of enemies) {
      if (other !== enemy && distanceSq(enemy, other) <= shot.splash ** 2) affected.push(other);
    }
  }
  for (const target of affected) {
    damageEnemy(target, shot.damage * (target === enemy ? 1 : 0.58), shot);
    applyShotEffects(target, shot);
  }
  let chainFrom = enemy;
  for (let chain = 0; chain < shot.chain; chain += 1) {
    const next = enemies.find((candidate) => candidate !== chainFrom && candidate.hp > 0 && distanceSq(chainFrom, candidate) <= shot.chainRange ** 2 && !affected.includes(candidate));
    if (!next) break;
    damageEnemy(next, shot.damage * 0.72, shot);
    applyShotEffects(next, shot);
    affected.push(next);
    chainFrom = next;
    particles.push({ x: next.x, y: next.y, vx: 0, vy: 0, radius: 9, life: 0.18, maxLife: 0.18, color: shot.color });
  }
  burst(enemy.x, enemy.y, shot.color, shot.splash ? 16 : 6, shot.splash ? 220 : 150);
}

function updateShots(dt) {
  for (let i = shots.length - 1; i >= 0; i -= 1) {
    const shot = shots[i];
    const target = enemies.find((enemy) => enemy.id === shot.targetId);
    if (!target) {
      shots.splice(i, 1);
      continue;
    }
    const dx = target.x - shot.x;
    const dy = target.y - shot.y;
    const dist = Math.hypot(dx, dy) || 1;
    const step = shot.speed * dt;
    if (dist <= step + target.radius) {
      hitEnemy(target, shot);
      shots.splice(i, 1);
      continue;
    }
    shot.x += (dx / dist) * step;
    shot.y += (dy / dist) * step;
  }
}

function updateEnemyStatuses(dt) {
  for (const enemy of enemies) {
    if (enemy.burn > 0) {
      enemy.hp -= 8 * (enemy.resist.burn || 1) * dt;
      enemy.burn -= dt;
      if (Math.random() < dt * 8) burst(enemy.x, enemy.y, "#ff8f5c", 1, 40);
    }
    if (enemy.poison > 0) {
      enemy.hp -= 5 * dt;
      enemy.poison -= dt;
    }
    if (enemy.regen && enemy.burn <= 0) enemy.hp = Math.min(enemy.maxHp, enemy.hp + enemy.regen * dt);
    enemy.slow = Math.max(0, enemy.slow - dt);
    enemy.weaken = Math.max(0, enemy.weaken - dt * 0.18);
    for (const zone of activeMap.zones || []) {
      if (zone.type !== "hazard") continue;
      if (Math.hypot(enemy.x / TILE - zone.col, enemy.y / TILE - zone.row) <= zone.radius) enemy.hp -= zone.damage * dt;
    }
  }
}

function removeDefeatedEnemies() {
  for (let i = enemies.length - 1; i >= 0; i -= 1) {
    const enemy = enemies[i];
    if (enemy.hp > 0) continue;
    enemies.splice(i, 1);
    const reward = enemy.reward;
    const scoreGain = reward * 24 + wave * 12 + Math.floor(activeMap.reward * 80);
    bread += reward;
    claimBread += Math.max(1, Math.floor(reward / 2));
    score += scoreGain;
    floater(enemy.x, enemy.y - enemy.radius - 10, `+${reward}`, "#fff29b");
    burst(enemy.x, enemy.y, enemy.color, 18);
    if (enemy.splits) {
      for (let split = 0; split < 2; split += 1) spawnEnemy("runner", enemy.pathIndex, enemy.progress, enemy.segment);
      enemies.slice(-2).forEach((child) => {
        child.x = enemy.x + rand(-8, 8);
        child.y = enemy.y + rand(-8, 8);
        child.hp = Math.max(12, Math.floor(child.hp * 0.42));
        child.maxHp = child.hp;
        child.reward = Math.max(2, Math.floor(child.reward * 0.42));
      });
    }
  }
}

function updateEnemies(dt) {
  updateEnemyStatuses(dt);
  for (let i = enemies.length - 1; i >= 0; i -= 1) {
    const enemy = enemies[i];
    moveEnemy(enemy, dt);
    if (!enemy.escaped) continue;
    enemies.splice(i, 1);
    lives -= enemy.damage;
    const endPoint = pathPointSets[enemy.pathIndex].at(-1);
    burst(endPoint.x, endPoint.y, "#ff7676", 20);
    setStatus(`${enemy.name} reached the vault. Lives lost: ${enemy.damage}.`);
    if (lives <= 0) endGame();
  }
}

function updateWave(dt) {
  if (!waveActive || ended) return;
  spawnTimer -= dt;
  if (spawnQueue.length && spawnTimer <= 0) {
    const next = spawnQueue.shift();
    spawnEnemy(next.type, next.pathIndex);
    spawnTimer = next.delay;
  }
  if (!spawnQueue.length && enemies.length === 0) {
    waveActive = false;
    running = false;
    const bonus = Math.round((20 + wave * 5 + Math.max(0, lives - 12)) * activeMap.reward);
    bread += bonus;
    claimBread += Math.max(2, Math.floor(bonus / 8));
    score += Math.round((320 + wave * 110 + lives * 18) * activeMap.reward);
    progress.bestWave = Math.max(progress.bestWave, wave);
    saveProgress();
    wave += 1;
    startWaveButton.disabled = false;
    startWaveButton.textContent = "Start Wave";
    setStatus(`Wave cleared. +${bonus} bread. New unlocks may have woken up.`);
    renderTowerShop();
    renderMapPicker();
  }
}

function updateParticles(dt) {
  for (const list of [particles, floaters]) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      item.life -= dt;
      item.x += (item.vx || 0) * dt;
      item.y += (item.vy || -18) * dt;
      item.vx = (item.vx || 0) * 0.96;
      item.vy = (item.vy || 0) * 0.96;
      if (item.life <= 0) list.splice(i, 1);
    }
  }
}

function update(now) {
  const dt = Math.min(0.033, (now - lastTime) / 1000 || 0);
  lastTime = now;
  if (running && !ended) {
    updateWave(dt);
    updateTowers(dt);
    updateShots(dt);
    updateEnemies(dt);
    removeDefeatedEnemies();
  }
  updateParticles(dt);
  updateStats();
  renderEnemyIntel();
  draw();
  animationFrame = requestAnimationFrame(update);
}

function drawPathBadges() {
  ctx.save();
  ctx.font = "900 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  pathPointSets.forEach((path, index) => {
    ctx.fillText(index ? `entry ${index + 1}` : "curse entry", path[0].x + 22, path[0].y - 22);
  });
  const vault = pathPointSets[0].at(-1);
  ctx.fillText("bread vault", vault.x - 18, vault.y - 42);
  ctx.restore();
}

function drawTowers() {
  for (const tower of towers) {
    const stats = towerStats(tower);
    const selected = selectedTowerId === tower.id;
    ctx.save();
    ctx.translate(tower.x, tower.y);
    if (selected) drawRange(stats.range, stats.color);
    if (tower.type === "keeper") drawRange(stats.range, stats.color, 0.1);
    ctx.fillStyle = "rgba(3, 12, 7, 0.78)";
    ctx.strokeStyle = stats.color;
    ctx.lineWidth = selected ? 4 : 3;
    ctx.beginPath();
    ctx.roundRect(-21, -21, 42, 42, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = stats.color;
    ctx.beginPath();
    if (["relic", "kiln"].includes(tower.type)) {
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-7, -7, 14, 14);
    } else if (["spore", "keeper"].includes(tower.type)) {
      ctx.ellipse(0, -3, 11, 15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-4, 7, 8, 11);
    } else if (tower.type === "horn") {
      ctx.moveTo(-16, 8);
      ctx.lineTo(17, -1);
      ctx.lineTo(-16, -10);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.moveTo(0, -16);
      ctx.lineTo(14, 10);
      ctx.lineTo(-14, 10);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#f7fff4";
    ctx.font = "900 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(tower.level), 0, 5);
    ctx.restore();
  }
}

function drawRange(range, color, alpha = 0.18) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, range, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEnemies() {
  for (const enemy of enemies) {
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    if (enemy.slow > 0 || enemy.weaken > 0 || enemy.burn > 0) {
      ctx.strokeStyle = enemy.burn > 0 ? "#ff8f5c" : enemy.weaken > 0 ? "#ba7cff" : "#7cf7ff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = enemy.color;
    ctx.shadowColor = enemy.color;
    ctx.shadowBlur = enemy.type === "boss" ? 26 : 14;
    ctx.beginPath();
    ctx.arc(0, 0, enemy.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(2, 7, 5, 0.86)";
    ctx.beginPath();
    ctx.arc(enemy.radius * 0.22, -enemy.radius * 0.2, Math.max(2, enemy.radius * 0.16), 0, Math.PI * 2);
    ctx.arc(enemy.radius * 0.22, enemy.radius * 0.2, Math.max(2, enemy.radius * 0.16), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.46)";
    ctx.fillRect(-enemy.radius, enemy.radius + 7, enemy.radius * 2, 4);
    ctx.fillStyle = "#9cff74";
    ctx.fillRect(-enemy.radius, enemy.radius + 7, enemy.radius * 2 * clamp(enemy.hp / enemy.maxHp, 0, 1), 4);
    if (enemy.maxShield > 0 && enemy.shield > 0) {
      ctx.fillStyle = "#85ffd2";
      ctx.fillRect(-enemy.radius, enemy.radius + 13, enemy.radius * 2 * clamp(enemy.shield / enemy.maxShield, 0, 1), 3);
    }
    ctx.restore();
  }
}

function drawShots() {
  for (const shot of shots) {
    ctx.save();
    ctx.fillStyle = shot.color;
    ctx.shadowColor = shot.color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(shot.x, shot.y, shot.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawParticles() {
  for (const particle of particles) {
    ctx.save();
    ctx.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const text of floaters) {
    ctx.save();
    ctx.globalAlpha = clamp(text.life / text.maxLife, 0, 1);
    ctx.fillStyle = text.color;
    ctx.font = "900 16px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text.text, text.x, text.y);
    ctx.restore();
  }
}

function drawPlacementHint() {
  if (ended || waveActive) return;
  const spec = towerTypes[selectedTowerType];
  if (!spec) return;
  ctx.save();
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      if (!canPlace(col, row)) continue;
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = spec.color;
      ctx.fillRect(col * TILE + 4, row * TILE + 4, TILE - 8, TILE - 8);
    }
  }
  if (hoverCell && canPlace(hoverCell.col, hoverCell.row)) {
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = spec.color;
    ctx.fillRect(hoverCell.col * TILE + 4, hoverCell.row * TILE + 4, TILE - 8, TILE - 8);
    ctx.translate(hoverCell.col * TILE + TILE / 2, hoverCell.row * TILE + TILE / 2);
    drawRange(spec.range, spec.color, 0.16);
  }
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawBackground(selectedMapId), 0, 0);
  drawPlacementHint();
  drawPathBadges();
  drawTowers();
  drawShots();
  drawEnemies();
  drawParticles();
  if (!running && !waveActive && !ended && wave === 1 && !towers.length) {
    ctx.save();
    ctx.fillStyle = "rgba(3, 12, 7, 0.54)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f7fff4";
    ctx.font = "950 37px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(activeMap.name, canvas.width / 2, 226);
    ctx.font = "800 17px Inter, system-ui, sans-serif";
    ctx.fillText(activeMap.description, canvas.width / 2, 260);
    ctx.restore();
  } else if (!running && !waveActive && !ended) {
    ctx.save();
    ctx.fillStyle = "rgba(3, 12, 7, 0.58)";
    ctx.strokeStyle = "rgba(215,255,145,0.32)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(320, 18, 320, 52, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f7fff4";
    ctx.font = "900 19px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Wave ${wave} ready`, canvas.width / 2, 41);
    ctx.font = "800 12px Inter, system-ui, sans-serif";
    ctx.fillText("Build, upgrade, branch, then start the next bad idea.", canvas.width / 2, 58);
    ctx.restore();
  }
  if (ended) {
    ctx.save();
    ctx.fillStyle = "rgba(3, 12, 7, 0.66)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff29b";
    ctx.font = "950 42px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Vault breached", canvas.width / 2, 246);
    ctx.fillStyle = "#f7fff4";
    ctx.font = "850 18px Inter, system-ui, sans-serif";
    ctx.fillText(`${Math.floor(score).toLocaleString()} score · ${claimBread} claimable bread`, canvas.width / 2, 282);
    ctx.restore();
  }
}

mapPicker.addEventListener("click", (event) => {
  const button = event.target.closest("[data-map]");
  if (!button || waveActive || towers.length) return;
  configureMap(button.dataset.map);
  resetGame();
});

towerShop.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tower]");
  if (!button || button.disabled) return;
  selectedTowerType = button.dataset.tower;
  selectedTowerId = null;
  renderTowerShop();
  renderInspector();
  draw();
});

canvas.addEventListener("pointermove", (event) => {
  hoverCell = pointerInfo(event);
});

canvas.addEventListener("pointerleave", () => {
  hoverCell = null;
});

canvas.addEventListener("click", (event) => {
  if (ended) return;
  const cell = pointerInfo(event);
  const existing = towerAt(cell.col, cell.row);
  if (existing) {
    selectedTowerId = existing.id;
    renderInspector();
    draw();
    return;
  }
  placeTower(cell.col, cell.row);
  draw();
});

towerInspector.addEventListener("click", (event) => {
  if (event.target.closest("[data-upgrade-tower]")) upgradeTower();
  const branchButton = event.target.closest("[data-branch-tower]");
  if (branchButton) branchTower(branchButton.dataset.branchTower);
  if (event.target.closest("[data-sell-tower]")) sellTower();
  draw();
});

startWaveButton.addEventListener("click", startWave);
resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", services.loadLeaderboard);

configureMap(selectedMapId);
resetGame();
services.loadLeaderboard();
cancelAnimationFrame(animationFrame);
animationFrame = requestAnimationFrame(update);
