import {
  clamp,
  createBackgroundCache,
  createGameServices,
  rand
} from "/game-common.js";

const canvas = document.querySelector("#blitzCanvas");
const ctx = canvas.getContext("2d");
const scoreValue = document.querySelector("#scoreValue");
const breadValue = document.querySelector("#breadValue");
const healthValue = document.querySelector("#healthValue");
const powerupStatus = document.querySelector("#powerupStatus");
const playerName = document.querySelector("#playerName");
const startButton = document.querySelector("#startGame");
const resetButton = document.querySelector("#resetGame");
const refreshLeaderboard = document.querySelector("#refreshLeaderboard");

const services = createGameServices("blitz", {
  leaderboardList: document.querySelector("#leaderboardList"),
  leaderboardStatus: document.querySelector("#leaderboardStatus"),
  claimCard: document.querySelector("#claimCard"),
  playerName,
  emptyText: "No blitz runs saved yet"
});

const keys = new Set();
const pointer = { active: false, x: canvas.width / 2, y: canvas.height / 2 };
let canvasRect = null;

const player = {
  x: canvas.width / 2,
  y: canvas.height / 2,
  radius: 24,
  speed: 280,
  health: 5,
  fireCooldown: 0,
  hitCooldown: 0,
  rapid: 0,
  ward: 0,
  vacuum: 0
};

const enemies = [];
const bolts = [];
const crumbs = [];
const powerups = [];
const particles = [];
let running = false;
let ended = false;
let scoreSaved = false;
let score = 0;
let bread = 0;
let lastTime = 0;
let enemyTimer = 0;
let powerupTimer = 8;
let elapsed = 0;
let lastStatsText = "";
let lastPowerupText = "";

const drawBackground = createBackgroundCache(canvas, (cacheCtx, targetCanvas) => {
  const gradient = cacheCtx.createRadialGradient(
    targetCanvas.width / 2,
    targetCanvas.height / 2,
    80,
    targetCanvas.width / 2,
    targetCanvas.height / 2,
    520
  );
  gradient.addColorStop(0, "#eff8ec");
  gradient.addColorStop(0.58, "#d9e6d9");
  gradient.addColorStop(1, "#93a598");
  cacheCtx.fillStyle = gradient;
  cacheCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

  cacheCtx.strokeStyle = "rgba(24, 42, 28, 0.11)";
  cacheCtx.lineWidth = 2;
  for (let radius = 80; radius <= 400; radius += 62) {
    cacheCtx.beginPath();
    cacheCtx.arc(targetCanvas.width / 2, targetCanvas.height / 2, radius, 0, Math.PI * 2);
    cacheCtx.stroke();
  }
});

function updateStats() {
  const next = `${Math.floor(score)}:${bread}:${player.health}`;
  if (next === lastStatsText) return;
  lastStatsText = next;
  scoreValue.textContent = String(Math.floor(score));
  breadValue.textContent = String(bread);
  healthValue.textContent = String(player.health);
}

function updatePowerupStatus() {
  const labels = [];
  if (player.rapid > 0) labels.push(`Rapid ${Math.ceil(player.rapid)}s`);
  if (player.ward > 0) labels.push(`Ward ${Math.ceil(player.ward)}s`);
  if (player.vacuum > 0) labels.push(`Vacuum ${Math.ceil(player.vacuum)}s`);
  const next = `Power-up: ${labels.join(" | ") || "None"}`;
  if (next === lastPowerupText) return;
  lastPowerupText = next;
  powerupStatus.textContent = next;
}

function ensurePlayerReady() {
  if (services.hasPlayerName()) {
    services.persistPlayerName();
    services.setLeaderboardStatus("");
    return true;
  }
  services.setLeaderboardStatus("Add your player name before starting Bread Blitz.");
  services.focusPlayerName();
  return false;
}

function addParticles(x, y, color, count = 7) {
  for (let index = 0; index < count; index += 1) {
    particles.push({
      x,
      y,
      vx: rand(-110, 110),
      vy: rand(-120, 120),
      life: rand(0.18, 0.46),
      maxLife: 0.46,
      radius: rand(2, 5),
      color
    });
  }
  if (particles.length > 180) {
    particles.splice(0, particles.length - 180);
  }
}

function spawnEnemy() {
  const side = Math.floor(rand(0, 4));
  const margin = 40;
  let x = 0;
  let y = 0;
  if (side === 0) {
    x = rand(-margin, canvas.width + margin);
    y = -margin;
  } else if (side === 1) {
    x = canvas.width + margin;
    y = rand(-margin, canvas.height + margin);
  } else if (side === 2) {
    x = rand(-margin, canvas.width + margin);
    y = canvas.height + margin;
  } else {
    x = -margin;
    y = rand(-margin, canvas.height + margin);
  }
  const typeRoll = Math.random();
  enemies.push({
    x,
    y,
    radius: typeRoll > 0.8 ? 24 : typeRoll > 0.45 ? 18 : 14,
    speed: rand(62, 110) + Math.min(110, elapsed * 2.2),
    health: typeRoll > 0.8 ? 3 : typeRoll > 0.45 ? 2 : 1,
    wobble: rand(0, Math.PI * 2),
    color: typeRoll > 0.8 ? "#7e3147" : typeRoll > 0.45 ? "#4252c9" : "#111917"
  });
}

function spawnPowerup() {
  const types = ["rapid", "ward", "vacuum"];
  powerups.push({
    x: rand(90, canvas.width - 90),
    y: rand(70, canvas.height - 70),
    radius: 18,
    type: types[Math.floor(Math.random() * types.length)],
    phase: rand(0, Math.PI * 2)
  });
}

function applyPowerup(type) {
  if (type === "rapid") player.rapid = 8;
  if (type === "ward") player.ward = 8;
  if (type === "vacuum") player.vacuum = 8;
  updatePowerupStatus();
}

function findTarget() {
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < enemies.length; index += 1) {
    const enemy = enemies[index];
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistance) {
      bestDistance = distanceSq;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function fireBolt() {
  const targetIndex = findTarget();
  if (targetIndex < 0) return;
  const enemy = enemies[targetIndex];
  const dx = enemy.x - player.x;
  const dy = enemy.y - player.y;
  const length = Math.hypot(dx, dy) || 1;
  bolts.push({
    x: player.x,
    y: player.y,
    vx: (dx / length) * 520,
    vy: (dy / length) * 520,
    radius: 6,
    damage: player.rapid > 0 ? 2 : 1,
    life: 1.1
  });
}

function damagePlayer() {
  if (player.hitCooldown > 0 || ended) return;
  if (player.ward > 0) {
    player.ward = 0;
    player.hitCooldown = 0.65;
    addParticles(player.x, player.y, "#9fe7ff", 12);
    updatePowerupStatus();
    return;
  }
  player.health -= 1;
  player.hitCooldown = 0.85;
  addParticles(player.x, player.y, "#ff8d8d", 12);
  updateStats();
  if (player.health <= 0) {
    endGame();
  }
}

function endGame() {
  if (ended) return;
  ended = true;
  running = false;
  services.createClaimCode({ score, bread });
  if (!scoreSaved) {
    scoreSaved = true;
    services.submitScore({ score, bread });
  }
}

function resetGame() {
  running = false;
  ended = false;
  scoreSaved = false;
  score = 0;
  bread = 0;
  lastTime = 0;
  enemyTimer = 0;
  powerupTimer = 8;
  elapsed = 0;
  lastStatsText = "";
  lastPowerupText = "";
  enemies.length = 0;
  bolts.length = 0;
  crumbs.length = 0;
  powerups.length = 0;
  particles.length = 0;
  Object.assign(player, {
    x: canvas.width / 2,
    y: canvas.height / 2,
    health: 5,
    fireCooldown: 0,
    hitCooldown: 0,
    rapid: 0,
    ward: 0,
    vacuum: 0
  });
  updateStats();
  updatePowerupStatus();
  services.resetClaimState("Hold the swarm off and gather bread to get a claim code.");
  draw();
}

function setPointer(event) {
  if (!canvasRect) canvasRect = canvas.getBoundingClientRect();
  const point = event.touches?.[0] || event;
  pointer.x = (point.clientX - canvasRect.left) * (canvas.width / canvasRect.width);
  pointer.y = (point.clientY - canvasRect.top) * (canvas.height / canvasRect.height);
}

function update(dt) {
  if (!running || ended) return;

  elapsed += dt;
  score += dt * 10;
  player.fireCooldown -= dt;
  player.hitCooldown = Math.max(0, player.hitCooldown - dt);
  player.rapid = Math.max(0, player.rapid - dt);
  player.ward = Math.max(0, player.ward - dt);
  player.vacuum = Math.max(0, player.vacuum - dt);

  let moveX = 0;
  let moveY = 0;
  if (keys.has("arrowleft") || keys.has("a")) moveX -= 1;
  if (keys.has("arrowright") || keys.has("d")) moveX += 1;
  if (keys.has("arrowup") || keys.has("w")) moveY -= 1;
  if (keys.has("arrowdown") || keys.has("s")) moveY += 1;
  if (pointer.active) {
    const dx = pointer.x - player.x;
    const dy = pointer.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 10) {
      moveX += dx / dist;
      moveY += dy / dist;
    }
  }

  const moveLength = Math.hypot(moveX, moveY) || 1;
  player.x += (moveX / moveLength) * player.speed * dt;
  player.y += (moveY / moveLength) * player.speed * dt;
  player.x = clamp(player.x, player.radius, canvas.width - player.radius);
  player.y = clamp(player.y, player.radius, canvas.height - player.radius);

  enemyTimer -= dt;
  powerupTimer -= dt;
  if (enemyTimer <= 0) {
    spawnEnemy();
    enemyTimer = Math.max(0.22, 0.7 - elapsed * 0.008) + rand(0.02, 0.12);
  }
  if (powerupTimer <= 0) {
    spawnPowerup();
    powerupTimer = rand(8, 12);
  }

  if (player.fireCooldown <= 0) {
    fireBolt();
    player.fireCooldown = player.rapid > 0 ? 0.18 : 0.34;
  }

  for (let index = enemies.length - 1; index >= 0; index -= 1) {
    const enemy = enemies[index];
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const dist = Math.hypot(dx, dy) || 1;
    enemy.wobble += dt * 4;
    enemy.x += (dx / dist) * enemy.speed * dt + Math.sin(enemy.wobble) * 10 * dt;
    enemy.y += (dy / dist) * enemy.speed * dt + Math.cos(enemy.wobble) * 10 * dt;
    if (dist < player.radius + enemy.radius - 4) {
      enemies.splice(index, 1);
      damagePlayer();
    }
  }

  for (let index = bolts.length - 1; index >= 0; index -= 1) {
    const bolt = bolts[index];
    bolt.x += bolt.vx * dt;
    bolt.y += bolt.vy * dt;
    bolt.life -= dt;
    let hit = false;
    for (let enemyIndex = enemies.length - 1; enemyIndex >= 0; enemyIndex -= 1) {
      const enemy = enemies[enemyIndex];
      const dx = bolt.x - enemy.x;
      const dy = bolt.y - enemy.y;
      if ((dx * dx + dy * dy) < (bolt.radius + enemy.radius) * (bolt.radius + enemy.radius)) {
        enemy.health -= bolt.damage;
        addParticles(enemy.x, enemy.y, "#8fffa0", 5);
        if (enemy.health <= 0) {
          score += enemy.radius > 20 ? 34 : enemy.radius > 16 ? 20 : 12;
          crumbs.push({
            x: enemy.x,
            y: enemy.y,
            radius: 10,
            life: 10
          });
          addParticles(enemy.x, enemy.y, "#d99a3b", 8);
          enemies.splice(enemyIndex, 1);
        }
        hit = true;
        break;
      }
    }
    if (hit || bolt.life <= 0 || bolt.x < -20 || bolt.x > canvas.width + 20 || bolt.y < -20 || bolt.y > canvas.height + 20) {
      bolts.splice(index, 1);
    }
  }

  const vacuumRange = player.vacuum > 0 ? 170 : 84;
  for (let index = crumbs.length - 1; index >= 0; index -= 1) {
    const crumb = crumbs[index];
    crumb.life -= dt;
    const dx = player.x - crumb.x;
    const dy = player.y - crumb.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist < vacuumRange) {
      const pull = (1 - dist / vacuumRange) * (player.vacuum > 0 ? 380 : 210) * dt;
      crumb.x += (dx / dist) * pull;
      crumb.y += (dy / dist) * pull;
    }
    if (dist < player.radius + crumb.radius + 4) {
      bread += 1;
      score += 8;
      addParticles(crumb.x, crumb.y, "#f0cf6a", 7);
      crumbs.splice(index, 1);
      updateStats();
      continue;
    }
    if (crumb.life <= 0) {
      crumbs.splice(index, 1);
    }
  }

  for (let index = powerups.length - 1; index >= 0; index -= 1) {
    const item = powerups[index];
    item.phase += dt * 4;
    const dx = player.x - item.x;
    const dy = player.y - item.y;
    if ((dx * dx + dy * dy) < (player.radius + item.radius) * (player.radius + item.radius)) {
      applyPowerup(item.type);
      addParticles(item.x, item.y, "#aefcc8", 10);
      powerups.splice(index, 1);
    }
  }

  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index];
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.life -= dt;
    if (particle.life <= 0) particles.splice(index, 1);
  }

  updateStats();
  updatePowerupStatus();
}

function drawPlayer() {
  if (player.hitCooldown > 0 && Math.floor(player.hitCooldown * 18) % 2 === 0) return;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.fillStyle = "#f7faf5";
  ctx.beginPath();
  ctx.ellipse(0, 0, 24, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111917";
  ctx.beginPath();
  ctx.arc(-8, -6, 4.5, 0, Math.PI * 2);
  ctx.arc(8, -6, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f1d0bd";
  ctx.beginPath();
  ctx.ellipse(0, 10, 12, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  if (player.ward > 0) {
    ctx.strokeStyle = "rgba(106, 198, 255, 0.82)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  if (document.hidden) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawBackground("base"), 0, 0);

  for (let radius = 190; radius <= 250; radius += 60) {
    ctx.strokeStyle = "rgba(63, 111, 74, 0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (let index = 0; index < crumbs.length; index += 1) {
    const crumb = crumbs[index];
    ctx.fillStyle = "#d99a3b";
    ctx.strokeStyle = "#86551a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(crumb.x - 10, crumb.y - 8, 20, 16, 7);
    ctx.fill();
    ctx.stroke();
  }

  for (let index = 0; index < powerups.length; index += 1) {
    const item = powerups[index];
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.phase * 0.2);
    if (item.type === "rapid") {
      ctx.fillStyle = "#f2d34f";
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(9, -4);
      ctx.lineTo(18, 0);
      ctx.lineTo(6, 5);
      ctx.lineTo(10, 18);
      ctx.lineTo(0, 8);
      ctx.lineTo(-10, 18);
      ctx.lineTo(-6, 5);
      ctx.lineTo(-18, 0);
      ctx.lineTo(-9, -4);
      ctx.closePath();
      ctx.fill();
    } else if (item.type === "ward") {
      ctx.fillStyle = "#5da7ff";
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = "#ef667b";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(0, 0, 14, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.strokeStyle = "#6dc3ff";
      ctx.beginPath();
      ctx.arc(0, 0, 14, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.restore();
  }

  for (let index = 0; index < bolts.length; index += 1) {
    const bolt = bolts[index];
    ctx.fillStyle = "#8fffa0";
    ctx.beginPath();
    ctx.arc(bolt.x, bolt.y, bolt.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let index = 0; index < enemies.length; index += 1) {
    const enemy = enemies[index];
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    ctx.fillStyle = enemy.color;
    ctx.beginPath();
    if (enemy.radius > 20) {
      ctx.moveTo(0, -enemy.radius);
      ctx.lineTo(enemy.radius * 0.9, 0);
      ctx.lineTo(0, enemy.radius);
      ctx.lineTo(-enemy.radius * 0.9, 0);
      ctx.closePath();
    } else if (enemy.radius > 16) {
      ctx.arc(0, 0, enemy.radius, 0, Math.PI * 2);
    } else {
      ctx.roundRect(-enemy.radius, -enemy.radius, enemy.radius * 2, enemy.radius * 2, 6);
    }
    ctx.fill();
    ctx.restore();
  }

  for (let index = 0; index < particles.length; index += 1) {
    const particle = particles[index];
    ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawPlayer();

  if (!running && !ended) {
    ctx.fillStyle = "rgba(7,12,10,0.42)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "900 54px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Bread Blitz", canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = "800 22px system-ui";
    ctx.fillText("Move with WASD, arrows, or drag", canvas.width / 2, canvas.height / 2 + 34);
  }

  if (ended) {
    ctx.fillStyle = "rgba(7,12,10,0.56)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "900 56px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Swarm won", canvas.width / 2, canvas.height / 2 - 12);
    ctx.font = "800 24px system-ui";
    ctx.fillText(`Score ${Math.floor(score)} | Bread ${bread}`, canvas.width / 2, canvas.height / 2 + 28);
  }
}

function loop(time) {
  const dt = Math.min((time - lastTime) / 1000 || 0, 0.033);
  lastTime = time;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

startButton.addEventListener("click", () => {
  if (!ensurePlayerReady()) return;
  if (ended) resetGame();
  running = true;
});

resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", () => services.loadLeaderboard());

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  keys.add(key);
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", " "].includes(key)) {
    event.preventDefault();
  }
  if (key === " " && ensurePlayerReady()) running = true;
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

canvas.addEventListener("pointerdown", (event) => {
  if (!ensurePlayerReady()) return;
  canvasRect = canvas.getBoundingClientRect();
  pointer.active = true;
  setPointer(event);
  running = true;
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointer.active) return;
  setPointer(event);
});
canvas.addEventListener("pointerup", () => {
  pointer.active = false;
});
canvas.addEventListener("pointerleave", () => {
  pointer.active = false;
});
window.addEventListener("resize", () => {
  canvasRect = null;
});

document.addEventListener("visibilitychange", () => {
  lastTime = performance.now();
  if (!document.hidden) draw();
});

resetGame();
services.renderLeaderboard();
services.loadLeaderboard();
requestAnimationFrame(loop);
