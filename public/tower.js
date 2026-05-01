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
const towerButtons = [...document.querySelectorAll("[data-tower]")];

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
const pathCells = [
  [0, 4], [1, 4], [2, 4], [3, 4], [4, 4],
  [4, 3], [4, 2], [5, 2], [6, 2], [7, 2],
  [7, 3], [7, 4], [8, 4], [9, 4], [10, 4],
  [10, 5], [10, 6], [11, 6], [12, 6], [13, 6],
  [13, 5], [13, 4], [14, 4], [15, 4]
];
const pathSet = new Set(pathCells.map(([x, y]) => `${x},${y}`));
const pathPoints = pathCells.map(([x, y]) => ({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }));

const towerTypes = {
  thorn: {
    name: "Thorn Sprayer",
    cost: 35,
    color: "#8dff71",
    range: 138,
    fireRate: 0.34,
    damage: 14,
    radius: 14,
    projectileSpeed: 580,
    splash: 0,
    slow: 0,
    description: "Fast single-target pressure"
  },
  relic: {
    name: "Relic Mortar",
    cost: 60,
    color: "#fff29b",
    range: 176,
    fireRate: 1.15,
    damage: 34,
    radius: 18,
    projectileSpeed: 420,
    splash: 72,
    slow: 0,
    description: "Explosive area denial"
  },
  spore: {
    name: "Spore Lantern",
    cost: 45,
    color: "#ba7cff",
    range: 122,
    fireRate: 0.62,
    damage: 7,
    radius: 16,
    projectileSpeed: 510,
    splash: 42,
    slow: 0.42,
    description: "Slows groups and chips armor"
  }
};

const enemyTypes = {
  mite: { name: "Curse Mite", hp: 42, speed: 54, reward: 7, damage: 1, color: "#ff7676", radius: 14 },
  runner: { name: "Vault Runner", hp: 34, speed: 92, reward: 8, damage: 1, color: "#ffb86c", radius: 12 },
  brute: { name: "Bread Brute", hp: 115, speed: 42, reward: 15, damage: 2, color: "#ff6fb1", radius: 18 },
  shield: { name: "Plate Keeper", hp: 72, shield: 70, speed: 48, reward: 18, damage: 2, color: "#85ffd2", radius: 17 },
  splitter: { name: "Split Crumb", hp: 62, speed: 58, reward: 12, damage: 1, color: "#d7ff91", radius: 15, splits: true }
};

const waves = [];
const towers = [];
const enemies = [];
const shots = [];
const particles = [];

let selectedTowerType = "thorn";
let selectedTowerId = null;
let running = false;
let ended = false;
let scoreSaved = false;
let lastTime = 0;
let score = 0;
let bread = 90;
let claimBread = 0;
let lives = 20;
let wave = 1;
let spawnQueue = [];
let spawnTimer = 0;
let waveActive = false;
let nextTowerId = 1;
let statusCache = "";
let statsCache = "";
let animationFrame = 0;

const drawBackground = createBackgroundCache(canvas, (cacheCtx, targetCanvas) => {
  const gradient = cacheCtx.createRadialGradient(710, 250, 80, 480, 270, 640);
  gradient.addColorStop(0, "#e7ffe1");
  gradient.addColorStop(0.52, "#b7ccb9");
  gradient.addColorStop(1, "#51635c");
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

  cacheCtx.lineCap = "round";
  cacheCtx.lineJoin = "round";
  cacheCtx.strokeStyle = "rgba(69, 60, 46, 0.72)";
  cacheCtx.lineWidth = 48;
  cacheCtx.beginPath();
  pathPoints.forEach((point, index) => {
    if (index === 0) cacheCtx.moveTo(point.x, point.y);
    else cacheCtx.lineTo(point.x, point.y);
  });
  cacheCtx.stroke();
  cacheCtx.strokeStyle = "rgba(244, 223, 156, 0.58)";
  cacheCtx.lineWidth = 28;
  cacheCtx.stroke();

  cacheCtx.fillStyle = "rgba(8, 24, 13, 0.5)";
  cacheCtx.fillRect(0, 0, 12, targetCanvas.height);
  cacheCtx.fillStyle = "rgba(17, 92, 38, 0.55)";
  cacheCtx.beginPath();
  cacheCtx.roundRect(targetCanvas.width - 88, 200, 78, 140, 22);
  cacheCtx.fill();
});

function buildWave(number) {
  const queue = [];
  const pressure = Math.max(0, number - 1);
  const base = 8 + Math.floor(number * 1.8);
  for (let i = 0; i < base; i += 1) queue.push("mite");
  if (number >= 3) for (let i = 0; i < 3 + Math.floor(number / 2); i += 1) queue.push("runner");
  if (number >= 5) for (let i = 0; i < 2 + Math.floor(number / 3); i += 1) queue.push("brute");
  if (number >= 7) for (let i = 0; i < 2 + Math.floor(number / 4); i += 1) queue.push("shield");
  if (number >= 9) for (let i = 0; i < 2 + Math.floor(number / 5); i += 1) queue.push("splitter");
  if (number % 5 === 0) queue.push("brute", "shield", "brute");
  return queue
    .sort(() => Math.random() - 0.5)
    .map((type, index) => ({ type, delay: Math.max(0.18, 0.86 - pressure * 0.018 - (index % 4) * 0.04) }));
}

function updateStats() {
  const next = `${Math.floor(score)}:${bread}:${lives}:${wave}`;
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
  waves.length = 0;
  selectedTowerType = "thorn";
  selectedTowerId = null;
  running = false;
  ended = false;
  scoreSaved = false;
  lastTime = 0;
  score = 0;
  bread = 90;
  claimBread = 0;
  lives = 20;
  wave = 1;
  spawnQueue = [];
  spawnTimer = 0;
  waveActive = false;
  nextTowerId = 1;
  startWaveButton.disabled = false;
  startWaveButton.textContent = "Start Wave";
  towerButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.tower === selectedTowerType));
  services.resetClaimState("Defend the vault, then lose or finish to get a claim code.");
  setStatus("Build before wave 1. The bread vault is watching.");
  updateStats();
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
  setStatus(`Wave ${wave} started. The path is about to become impolite.`);
}

function endGame() {
  if (ended) return;
  ended = true;
  running = false;
  waveActive = false;
  startWaveButton.disabled = true;
  startWaveButton.textContent = "Vault Lost";
  setStatus("The vault fell. A tragic bread-based incident.");
  services.createClaimCode({ score, bread: claimBread });
  if (!scoreSaved) {
    scoreSaved = true;
    services.submitScore({ score, bread: claimBread });
  }
}

function cellFromPointer(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  return {
    x,
    y,
    col: Math.floor(x / TILE),
    row: Math.floor(y / TILE)
  };
}

function towerAt(col, row) {
  return towers.find((tower) => tower.col === col && tower.row === row);
}

function canPlace(col, row) {
  return col >= 0 && col < COLS && row >= 0 && row < ROWS && !pathSet.has(`${col},${row}`) && !towerAt(col, row);
}

function placeTower(col, row) {
  const spec = towerTypes[selectedTowerType];
  if (!spec || !canPlace(col, row)) {
    setStatus(pathSet.has(`${col},${row}`) ? "That is the path. The path is busy being walked on." : "That tile is already occupied.");
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
    cooldown: 0,
    spent: spec.cost,
    targetId: null
  };
  nextTowerId += 1;
  towers.push(tower);
  selectedTowerId = tower.id;
  setStatus(`${spec.name} placed. The vault feels slightly less doomed.`);
  updateStats();
  renderInspector();
}

function selectedTower() {
  return towers.find((tower) => tower.id === selectedTowerId) || null;
}

function towerStats(tower) {
  const spec = towerTypes[tower.type];
  const levelBonus = tower.level - 1;
  return {
    ...spec,
    range: spec.range + levelBonus * 13,
    damage: Math.round(spec.damage * (1 + levelBonus * 0.42)),
    fireRate: Math.max(0.16, spec.fireRate * (1 - levelBonus * 0.08)),
    splash: spec.splash + levelBonus * 8,
    slow: spec.slow ? Math.min(0.68, spec.slow + levelBonus * 0.06) : 0,
    upgradeCost: Math.floor(spec.cost * (0.74 + tower.level * 0.58))
  };
}

function renderInspector() {
  const tower = selectedTower();
  if (!tower) {
    const spec = towerTypes[selectedTowerType];
    towerInspector.innerHTML = `
      <span>${spec.name}</span>
      <small>${spec.description}. Click an open tile to build for ${spec.cost} bread.</small>
    `;
    return;
  }
  const stats = towerStats(tower);
  towerInspector.innerHTML = `
    <span>${stats.name} · Level ${tower.level}</span>
    <small>${stats.description}. Damage ${stats.damage}, range ${Math.round(stats.range)}, rate ${stats.fireRate.toFixed(2)}s.</small>
    <div class="tower-actions">
      <button type="button" data-upgrade-tower>Upgrade · ${stats.upgradeCost}</button>
      <button type="button" data-sell-tower>Sell · ${Math.floor(tower.spent * 0.58)}</button>
    </div>
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
  burst(tower.x, tower.y, stats.color, 18);
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

function spawnEnemy(type, progress = 0) {
  const spec = enemyTypes[type] || enemyTypes.mite;
  const scale = 1 + (wave - 1) * 0.18 + Math.max(0, wave - 8) * 0.04;
  enemies.push({
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    type,
    name: spec.name,
    x: pathPoints[0].x,
    y: pathPoints[0].y,
    segment: 0,
    progress,
    hp: Math.round(spec.hp * scale),
    maxHp: Math.round(spec.hp * scale),
    shield: Math.round((spec.shield || 0) * (1 + wave * 0.12)),
    maxShield: Math.round((spec.shield || 0) * (1 + wave * 0.12)),
    speed: spec.speed * (1 + (wave - 1) * 0.018),
    reward: Math.round(spec.reward * (1 + wave * 0.08)),
    damage: spec.damage,
    color: spec.color,
    radius: spec.radius,
    slow: 0,
    slowPower: 0,
    escaped: false
  });
}

function burst(x, y, color, count = 10) {
  for (let i = 0; i < count; i += 1) {
    const angle = rand(0, Math.PI * 2);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * rand(30, 170),
      vy: Math.sin(angle) * rand(30, 170),
      radius: rand(2, 5),
      life: rand(0.25, 0.66),
      maxLife: 0.66,
      color
    });
  }
}

function moveEnemy(enemy, dt) {
  const speed = enemy.speed * (enemy.slow > 0 ? 1 - enemy.slowPower : 1);
  let travel = speed * dt;
  while (travel > 0 && enemy.segment < pathPoints.length - 1) {
    const a = pathPoints[enemy.segment];
    const b = pathPoints[enemy.segment + 1];
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
  if (enemy.segment >= pathPoints.length - 1) {
    enemy.escaped = true;
    return;
  }
  const a = pathPoints[enemy.segment];
  const b = pathPoints[enemy.segment + 1];
  enemy.x = a.x + (b.x - a.x) * enemy.progress;
  enemy.y = a.y + (b.y - a.y) * enemy.progress;
  enemy.slow = Math.max(0, enemy.slow - dt);
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
    tower.cooldown -= dt;
    const stats = towerStats(tower);
    if (tower.cooldown > 0) continue;
    const target = targetFor(tower, stats);
    if (!target) continue;
    tower.cooldown = stats.fireRate;
    shots.push({
      x: tower.x,
      y: tower.y,
      targetId: target.id,
      speed: stats.projectileSpeed,
      damage: stats.damage,
      splash: stats.splash,
      slow: stats.slow,
      color: stats.color,
      radius: stats.radius
    });
  }
}

function damageEnemy(enemy, amount) {
  let remaining = amount;
  if (enemy.shield > 0) {
    const blocked = Math.min(enemy.shield, remaining);
    enemy.shield -= blocked;
    remaining -= blocked;
  }
  enemy.hp -= remaining;
}

function hitEnemy(enemy, shot) {
  if (shot.splash > 0) {
    for (const other of enemies) {
      if (distanceSq(enemy, other) <= shot.splash ** 2) {
        damageEnemy(other, shot.damage * (other === enemy ? 1 : 0.62));
        if (shot.slow > 0) {
          other.slow = Math.max(other.slow, 1.8);
          other.slowPower = Math.max(other.slowPower, shot.slow);
        }
      }
    }
    burst(enemy.x, enemy.y, shot.color, 14);
  } else {
    damageEnemy(enemy, shot.damage);
    burst(enemy.x, enemy.y, shot.color, 5);
  }
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

function removeDefeatedEnemies() {
  for (let i = enemies.length - 1; i >= 0; i -= 1) {
    const enemy = enemies[i];
    if (enemy.hp > 0) continue;
    enemies.splice(i, 1);
    const reward = enemy.reward;
    const scoreGain = reward * 24 + wave * 12;
    bread += reward;
    claimBread += Math.max(1, Math.floor(reward / 2));
    score += scoreGain;
    burst(enemy.x, enemy.y, enemy.color, 16);
    if (enemyTypes[enemy.type]?.splits) {
      for (let split = 0; split < 2; split += 1) spawnEnemy("runner", enemy.progress);
      const spawned = enemies.slice(-2);
      spawned.forEach((child) => {
        child.segment = enemy.segment;
        child.x = enemy.x + rand(-8, 8);
        child.y = enemy.y + rand(-8, 8);
        child.hp = Math.max(12, Math.floor(child.hp * 0.46));
        child.maxHp = child.hp;
        child.reward = Math.max(2, Math.floor(child.reward * 0.42));
      });
    }
  }
}

function updateEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i -= 1) {
    const enemy = enemies[i];
    moveEnemy(enemy, dt);
    if (!enemy.escaped) continue;
    enemies.splice(i, 1);
    lives -= enemy.damage;
    burst(pathPoints.at(-1).x, pathPoints.at(-1).y, "#ff7676", 20);
    setStatus(`${enemy.name} reached the vault. Lives lost: ${enemy.damage}.`);
    if (lives <= 0) endGame();
  }
}

function updateWave(dt) {
  if (!waveActive || ended) return;
  spawnTimer -= dt;
  if (spawnQueue.length && spawnTimer <= 0) {
    const next = spawnQueue.shift();
    spawnEnemy(next.type);
    spawnTimer = next.delay;
  }
  if (!spawnQueue.length && enemies.length === 0) {
    waveActive = false;
    running = false;
    const bonus = 20 + wave * 5 + Math.max(0, lives - 12);
    bread += bonus;
    claimBread += Math.max(2, Math.floor(bonus / 8));
    score += 320 + wave * 110 + lives * 18;
    wave += 1;
    startWaveButton.disabled = false;
    startWaveButton.textContent = "Start Wave";
    setStatus(`Wave cleared. +${bonus} bread. Build, upgrade, and make worse decisions.`);
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const particle = particles[i];
    particle.life -= dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.96;
    particle.vy *= 0.96;
    if (particle.life <= 0) particles.splice(i, 1);
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
    updateParticles(dt);
  } else {
    updateParticles(dt);
  }
  updateStats();
  draw();
  animationFrame = requestAnimationFrame(update);
}

function drawPathBadges() {
  ctx.save();
  ctx.font = "900 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillText("curse entry", 54, 230);
  ctx.fillText("bread vault", 908, 194);
  ctx.restore();
}

function drawTowers() {
  for (const tower of towers) {
    const stats = towerStats(tower);
    const selected = selectedTowerId === tower.id;
    ctx.save();
    ctx.translate(tower.x, tower.y);
    if (selected) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = stats.color;
      ctx.beginPath();
      ctx.arc(0, 0, stats.range, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = "rgba(3, 12, 7, 0.76)";
    ctx.strokeStyle = stats.color;
    ctx.lineWidth = selected ? 4 : 3;
    ctx.beginPath();
    ctx.roundRect(-21, -21, 42, 42, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = stats.color;
    ctx.beginPath();
    if (tower.type === "relic") {
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-7, -7, 14, 14);
    } else if (tower.type === "spore") {
      ctx.ellipse(0, -3, 11, 15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-4, 7, 8, 11);
    } else {
      ctx.moveTo(0, -16);
      ctx.lineTo(14, 10);
      ctx.lineTo(-14, 10);
      ctx.closePath();
      ctx.fill();
    }
    ctx.rotate(0);
    ctx.fillStyle = "#f7fff4";
    ctx.font = "900 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(tower.level), 0, 5);
    ctx.restore();
  }
}

function drawEnemies() {
  for (const enemy of enemies) {
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    if (enemy.slow > 0) {
      ctx.strokeStyle = "rgba(186,124,255,0.72)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = enemy.color;
    ctx.shadowColor = enemy.color;
    ctx.shadowBlur = 14;
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
    ctx.arc(shot.x, shot.y, shot.splash > 0 ? 7 : 5, 0, Math.PI * 2);
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
}

function drawPlacementHint() {
  if (ended || waveActive) return;
  const spec = towerTypes[selectedTowerType];
  if (!spec) return;
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = spec.color;
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      if (!canPlace(col, row)) continue;
      ctx.fillRect(col * TILE + 4, row * TILE + 4, TILE - 8, TILE - 8);
    }
  }
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawBackground("tower"), 0, 0);
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
    ctx.font = "950 38px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(wave === 1 && !towers.length ? "Build the Den" : `Wave ${wave} Ready`, canvas.width / 2, 236);
    ctx.font = "800 17px Inter, system-ui, sans-serif";
    ctx.fillText("Click open tiles to place towers. Upgrade the weird ones. Protect the vault.", canvas.width / 2, 270);
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
    ctx.fillText("Build, upgrade, then start the next bad idea.", canvas.width / 2, 58);
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

towerButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedTowerType = button.dataset.tower;
    selectedTowerId = null;
    towerButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    renderInspector();
    draw();
  });
});

canvas.addEventListener("click", (event) => {
  if (ended) return;
  const cell = cellFromPointer(event);
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
  if (event.target.closest("[data-sell-tower]")) sellTower();
  draw();
});

startWaveButton.addEventListener("click", startWave);
resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", services.loadLeaderboard);

resetGame();
services.loadLeaderboard();
cancelAnimationFrame(animationFrame);
animationFrame = requestAnimationFrame(update);
