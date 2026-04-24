import {
  clamp,
  createBackgroundCache,
  createGameServices,
  distanceSq,
  rand
} from "/game-common.js";

const canvas = document.querySelector("#chipkittleGame");
const ctx = canvas.getContext("2d");
const scoreValue = document.querySelector("#scoreValue");
const breadValue = document.querySelector("#breadValue");
const bestValue = document.querySelector("#bestValue");
const powerupStatus = document.querySelector("#powerupStatus");
const startButton = document.querySelector("#startGame");
const pauseButton = document.querySelector("#pauseGame");
const resetButton = document.querySelector("#resetGame");
const scoreForm = document.querySelector("#scoreForm");
const playerName = document.querySelector("#playerName");
const refreshLeaderboard = document.querySelector("#refreshLeaderboard");
const services = createGameServices("dash", {
  leaderboardList: document.querySelector("#leaderboardList"),
  leaderboardStatus: document.querySelector("#leaderboardStatus"),
  claimCard: document.querySelector("#claimCard"),
  playerName,
  emptyText: "No runs saved yet"
});

const storageKey = "chipkittle-dash-best";
const keys = new Set();
const pointer = { active: false, x: canvas.width * 0.2, y: canvas.height * 0.5 };
let canvasRect = null;
let needsPointerFrame = false;

const backgroundPresets = [
  { sky: ["#eef6ed", "#d5ddd6", "#8f9898"], stroke: "rgba(26, 138, 56, 0.11)" },
  { sky: ["#f4f2ea", "#d9c7a2", "#a37a38"], stroke: "rgba(142, 95, 23, 0.12)" },
  { sky: ["#e8f1fa", "#cbddee", "#8ba6c7"], stroke: "rgba(55, 96, 148, 0.13)" },
  { sky: ["#f6eaef", "#dfc6d2", "#b67b98"], stroke: "rgba(141, 86, 107, 0.13)" }
];

const player = {
  x: 150,
  y: canvas.height / 2,
  radius: 28,
  baseSpeed: 320,
  speed: 320,
  shield: 0,
  speedBoost: 0,
  magnet: 0,
  stasis: 0
};

let artifacts = [];
let stones = [];
let powerups = [];
let score = 0;
let bread = 0;
let best = Number(localStorage.getItem(storageKey) || 0);
let running = false;
let gameOver = false;
let scoreSaved = false;
let lastTime = 0;
let artifactTimer = 0;
let stoneTimer = 0;
let bonusTimer = 7;
let powerupTimer = 6;
let elapsedTime = 0;
let lastStatsText = "";
let lastPowerupText = "";
let particles = [];

bestValue.textContent = String(best);

const drawBackground = createBackgroundCache(canvas, (cacheCtx, targetCanvas, presetIndex) => {
  const preset = backgroundPresets[presetIndex % backgroundPresets.length];
  const gradient = cacheCtx.createLinearGradient(0, 0, targetCanvas.width, targetCanvas.height);
  gradient.addColorStop(0, preset.sky[0]);
  gradient.addColorStop(0.55, preset.sky[1]);
  gradient.addColorStop(1, preset.sky[2]);
  cacheCtx.fillStyle = gradient;
  cacheCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  cacheCtx.strokeStyle = preset.stroke;
  cacheCtx.lineWidth = 2;
  const lineGap = 72 - Math.min(24, presetIndex * 4);
  for (let x = -80; x < targetCanvas.width + 120; x += lineGap) {
    cacheCtx.beginPath();
    cacheCtx.moveTo(x, targetCanvas.height);
    cacheCtx.lineTo(x + 250, 0);
    cacheCtx.stroke();
  }
  for (let y = 70; y < targetCanvas.height; y += lineGap) {
    cacheCtx.beginPath();
    cacheCtx.moveTo(0, y);
    cacheCtx.lineTo(targetCanvas.width, y + 30);
    cacheCtx.stroke();
  }
});

function currentPresetIndex() {
  return Math.floor(score / 500) % backgroundPresets.length;
}

function randomY(padding = 45) {
  return rand(padding, canvas.height - padding);
}

function setPointerFromEvent(event) {
  if (!canvasRect) canvasRect = canvas.getBoundingClientRect();
  const point = event.touches?.[0] || event;
  const nextX = (point.clientX - canvasRect.left) * (canvas.width / canvasRect.width);
  const nextY = (point.clientY - canvasRect.top) * (canvas.height / canvasRect.height);
  if (Math.abs(pointer.x - nextX) < 1.5 && Math.abs(pointer.y - nextY) < 1.5) return;
  pointer.x = nextX;
  pointer.y = nextY;
}

function scheduleRectRefresh() {
  if (needsPointerFrame) return;
  needsPointerFrame = true;
  requestAnimationFrame(() => {
    canvasRect = canvas.getBoundingClientRect();
    needsPointerFrame = false;
  });
}

function timeMultiplier() {
  return 1 + Math.min(1.65, elapsedTime / 55);
}

function updateStats() {
  const next = `${Math.floor(score)}:${bread}:${best}`;
  if (next === lastStatsText) return;
  lastStatsText = next;
  scoreValue.textContent = String(Math.floor(score));
  breadValue.textContent = String(bread);
  bestValue.textContent = String(best);
}

function activePowerupText() {
  const labels = [];
  if (player.shield > 0) labels.push(`Shield ${Math.ceil(player.shield)}s`);
  if (player.speedBoost > 0) labels.push(`Haste ${Math.ceil(player.speedBoost)}s`);
  if (player.magnet > 0) labels.push(`Magnet ${Math.ceil(player.magnet)}s`);
  if (player.stasis > 0) labels.push(`Stasis ${Math.ceil(player.stasis)}s`);
  const next = `Power-up: ${labels.join(" | ") || "None"}`;
  if (next === lastPowerupText) return;
  lastPowerupText = next;
  powerupStatus.textContent = next;
}

function burst(x, y, color, count = 8) {
  for (let i = 0; i < count; i += 1) {
    particles.push({
      x,
      y,
      vx: rand(-90, 90),
      vy: rand(-110, 70),
      life: rand(0.28, 0.58),
      maxLife: 0.58,
      color,
      radius: rand(2, 5)
    });
  }
}

function spawnArtifact(forceBonus = false) {
  const typeRoll = Math.random();
  const type = forceBonus ? "star" : typeRoll > 0.72 ? "bread" : "artifact";
  artifacts.push({
    x: canvas.width + 40,
    y: randomY(),
    radius: type === "bread" ? 16 : type === "star" ? 20 : 18,
    speed: rand(185, 255),
    type,
    spin: rand(0, Math.PI * 2)
  });
}

function spawnStone() {
  const intensity = timeMultiplier();
  const count = elapsedTime > 70 && Math.random() < 0.25 ? 2 : 1;
  for (let index = 0; index < count; index += 1) {
    stones.push({
      x: canvas.width + 48 + index * 34,
      y: randomY(52),
      radius: rand(22, 33) + intensity * 1.8,
      speed: rand(210, 340) * intensity,
      wobble: rand(0, Math.PI * 2)
    });
  }
}

function spawnPowerup() {
  const types = ["shield", "speed", "magnet", "stasis"];
  const type = types[Math.floor(Math.random() * types.length)];
  powerups.push({
    x: canvas.width + 42,
    y: randomY(60),
    radius: 18,
    speed: rand(150, 220),
    type,
    phase: rand(0, Math.PI * 2)
  });
}

function applyPowerup(type) {
  if (type === "shield") player.shield = 8;
  if (type === "speed") player.speedBoost = 6.5;
  if (type === "magnet") player.magnet = 7.5;
  if (type === "stasis") player.stasis = 6;
  activePowerupText();
}

function updatePowerups(dt) {
  player.shield = Math.max(0, player.shield - dt);
  player.speedBoost = Math.max(0, player.speedBoost - dt);
  player.magnet = Math.max(0, player.magnet - dt);
  player.stasis = Math.max(0, player.stasis - dt);
  player.speed = player.baseSpeed * (player.speedBoost > 0 ? 1.55 : 1);
  activePowerupText();
}

function endRun() {
  if (gameOver) return;
  gameOver = true;
  running = false;
  services.createClaimCode({ score, bread });
  if (!scoreSaved && score > 0) {
    scoreSaved = true;
    scoreForm.hidden = false;
    playerName.focus();
  }
}

function resetGame() {
  player.x = 150;
  player.y = canvas.height / 2;
  player.speed = player.baseSpeed;
  player.shield = 0;
  player.speedBoost = 0;
  player.magnet = 0;
  player.stasis = 0;
  artifacts = [];
  stones = [];
  powerups = [];
  particles = [];
  score = 0;
  bread = 0;
  running = false;
  gameOver = false;
  scoreSaved = false;
  lastTime = 0;
  artifactTimer = 0;
  stoneTimer = 0;
  bonusTimer = 7;
  powerupTimer = 6;
  elapsedTime = 0;
  scoreForm.hidden = true;
  pauseButton.textContent = "Pause";
  services.resetClaimState("Collect bread, then finish the run to get a Discord claim code automatically.");
  updateStats();
  activePowerupText();
  draw();
}

function update(dt) {
  if (!running || gameOver) return;

  const move = { x: 0, y: 0 };
  if (keys.has("ArrowLeft") || keys.has("a")) move.x -= 1;
  if (keys.has("ArrowRight") || keys.has("d")) move.x += 1;
  if (keys.has("ArrowUp") || keys.has("w")) move.y -= 1;
  if (keys.has("ArrowDown") || keys.has("s")) move.y += 1;

  if (pointer.active) {
    const dx = pointer.x - player.x;
    const dy = pointer.y - player.y;
    const len = Math.hypot(dx, dy);
    if (len > 4) {
      move.x += dx / len;
      move.y += dy / len;
    }
  }

  const len = Math.hypot(move.x, move.y) || 1;
  player.x += (move.x / len) * player.speed * dt;
  player.y += (move.y / len) * player.speed * dt;
  player.x = clamp(player.x, player.radius + 8, canvas.width - player.radius - 8);
  player.y = clamp(player.y, player.radius + 8, canvas.height - player.radius - 8);

  elapsedTime += dt;
  artifactTimer -= dt;
  stoneTimer -= dt;
  bonusTimer -= dt;
  powerupTimer -= dt;

  if (artifactTimer <= 0) {
    spawnArtifact(false);
    artifactTimer = rand(0.45, 0.82);
  }
  if (stoneTimer <= 0) {
    spawnStone();
    stoneTimer = Math.max(0.3, 1.05 - elapsedTime * 0.013) / timeMultiplier() + rand(0.15, 0.42);
  }
  if (bonusTimer <= 0) {
    spawnArtifact(true);
    bonusTimer = rand(7, 11);
  }
  if (powerupTimer <= 0) {
    spawnPowerup();
    powerupTimer = rand(8, 12);
  }

  const magnetRange = player.magnet > 0 ? 150 : 0;
  artifacts.forEach((item) => {
    item.x -= item.speed * dt;
    item.spin += dt * 4;
    if (magnetRange > 0) {
      const dx = player.x - item.x;
      const dy = player.y - item.y;
      const dist = Math.hypot(dx, dy);
      if (dist < magnetRange && dist > 0.1) {
        const pull = (1 - dist / magnetRange) * 320 * dt;
        item.x += (dx / dist) * pull;
        item.y += (dy / dist) * pull;
      }
    }
  });

  powerups.forEach((item) => {
    item.x -= item.speed * dt;
    item.phase += dt * 3;
    if (magnetRange > 0) {
      const dx = player.x - item.x;
      const dy = player.y - item.y;
      const dist = Math.hypot(dx, dy);
      if (dist < magnetRange && dist > 0.1) {
        const pull = (1 - dist / magnetRange) * 280 * dt;
        item.x += (dx / dist) * pull;
        item.y += (dy / dist) * pull;
      }
    }
  });

  const stoneFactor = player.stasis > 0 ? 0.46 : 1;
  stones.forEach((stone) => {
    stone.x -= stone.speed * dt * stoneFactor;
    stone.y += Math.sin(performance.now() / 280 + stone.wobble) * 0.7;
  });

  artifacts = artifacts.filter((item) => {
    const combined = player.radius + item.radius;
    if (distanceSq(player, item) < combined * combined) {
      if (item.type === "bread") {
        bread += 1;
        score += 6;
        burst(item.x, item.y, "#d69a3c", 5);
      } else if (item.type === "star") {
        bread += 2;
        score += 24;
        burst(item.x, item.y, "#f7d25a", 12);
      } else {
        score += 10;
        burst(item.x, item.y, "#66dc62", 8);
      }
      if (score > best) {
        best = score;
        localStorage.setItem(storageKey, String(best));
      }
      updateStats();
      return false;
    }
    return item.x > -60;
  });

  powerups = powerups.filter((item) => {
    const combined = player.radius + item.radius;
    if (distanceSq(player, item) < combined * combined) {
      applyPowerup(item.type);
      burst(item.x, item.y, "#b6f6ff", 10);
      return false;
    }
    return item.x > -60;
  });

  for (const stone of stones) {
    const combined = player.radius + stone.radius - 4;
    if (distanceSq(player, stone) < combined * combined) {
      if (player.shield > 0) {
        player.shield = 0;
        stone.x = -120;
        activePowerupText();
        continue;
      }
      endRun();
      break;
    }
  }
  stones = stones.filter((stone) => stone.x > -70);
  particles.forEach((particle) => {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vy += 180 * dt;
    particle.life -= dt;
  });
  particles = particles.filter((particle) => particle.life > 0);
  updatePowerups(dt);
}

function drawPlayer() {
  const fur = ctx.createRadialGradient(player.x, player.y - 4, 6, player.x, player.y, 44);
  fur.addColorStop(0, "#ffffff");
  fur.addColorStop(0.55, "#eef0ed");
  fur.addColorStop(1, "#cfd4cc");
  ctx.fillStyle = fur;
  ctx.beginPath();
  ctx.ellipse(player.x, player.y, 42, 46, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#111917";
  ctx.beginPath();
  ctx.ellipse(player.x - 12, player.y - 12, 8, 10, 0, 0, Math.PI * 2);
  ctx.ellipse(player.x + 12, player.y - 12, 8, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#90f37a";
  ctx.beginPath();
  ctx.arc(player.x - 12, player.y - 12, 2.5, 0, Math.PI * 2);
  ctx.arc(player.x + 12, player.y - 12, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#f1d0bd";
  ctx.beginPath();
  ctx.ellipse(player.x, player.y + 18, 18, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  if (player.shield > 0) {
    ctx.strokeStyle = "rgba(100, 168, 255, 0.85)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(player.x, player.y, 38, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawArtifact(item) {
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.rotate(item.spin);
  if (item.type === "bread") {
    ctx.fillStyle = "#d69a3c";
    ctx.strokeStyle = "#8d5a20";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(-17, -12, 34, 24, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillRect(-9, -6, 18, 4);
  } else if (item.type === "star") {
    ctx.shadowColor = "#f0d54b";
    ctx.shadowBlur = 18;
    ctx.fillStyle = "#f7d25a";
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.lineTo(9, -6);
    ctx.lineTo(26, -2);
    ctx.lineTo(12, 10);
    ctx.lineTo(16, 24);
    ctx.lineTo(0, 17);
    ctx.lineTo(-16, 24);
    ctx.lineTo(-12, 10);
    ctx.lineTo(-26, -2);
    ctx.lineTo(-9, -6);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.shadowColor = "#65d64a";
    ctx.shadowBlur = 22;
    ctx.fillStyle = "#66dc62";
    ctx.beginPath();
    ctx.moveTo(0, -23);
    ctx.quadraticCurveTo(8, -8, 23, 0);
    ctx.quadraticCurveTo(8, 8, 0, 23);
    ctx.quadraticCurveTo(-8, 8, -23, 0);
    ctx.quadraticCurveTo(-8, -8, 0, -23);
    ctx.fill();
    ctx.fillStyle = "#073d1e";
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(11, 0);
    ctx.lineTo(0, 10);
    ctx.lineTo(-11, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawStone(stone) {
  ctx.save();
  ctx.translate(stone.x, stone.y);
  ctx.fillStyle = "#1a211f";
  ctx.strokeStyle = "#4b5550";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-stone.radius, -6);
  ctx.quadraticCurveTo(-10, -stone.radius, 12, -stone.radius + 6);
  ctx.quadraticCurveTo(stone.radius, 4, 7, stone.radius);
  ctx.quadraticCurveTo(-16, stone.radius - 2, -stone.radius, -6);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPowerup(item) {
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.rotate(item.phase * 0.25);
  if (item.type === "shield") {
    ctx.fillStyle = "#4f91f2";
    ctx.strokeStyle = "#c3e1ff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, item.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();
  } else if (item.type === "speed") {
    ctx.fillStyle = "#f2d34f";
    ctx.strokeStyle = "#c18f1f";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -item.radius);
    ctx.lineTo(item.radius * 0.4, -item.radius * 0.18);
    ctx.lineTo(item.radius, 0);
    ctx.lineTo(item.radius * 0.28, item.radius * 0.2);
    ctx.lineTo(item.radius * 0.45, item.radius);
    ctx.lineTo(0, item.radius * 0.35);
    ctx.lineTo(-item.radius * 0.52, item.radius);
    ctx.lineTo(-item.radius * 0.3, item.radius * 0.1);
    ctx.lineTo(-item.radius, 0);
    ctx.lineTo(-item.radius * 0.4, -item.radius * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (item.type === "magnet") {
    ctx.strokeStyle = "#f05f71";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, item.radius - 3, Math.PI * 0.16, Math.PI * 0.84);
    ctx.stroke();
    ctx.strokeStyle = "#7cc8ff";
    ctx.beginPath();
    ctx.arc(0, 0, item.radius - 3, Math.PI * 1.16, Math.PI * 1.84);
    ctx.stroke();
  } else {
    ctx.strokeStyle = "#b6f6ff";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, item.radius - 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#e7f9ff";
    ctx.fillRect(-3, -12, 6, 24);
    ctx.fillRect(-12, -3, 24, 6);
  }
  ctx.restore();
}

function drawOverlay() {
  if (!running && !gameOver && score === 0 && bread === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#101915";
    ctx.font = "900 58px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Chipkittle Dash", canvas.width / 2, canvas.height / 2 - 14);
    ctx.font = "700 22px system-ui";
    ctx.fillText("WASD, arrows, or drag to move", canvas.width / 2, canvas.height / 2 + 32);
  }
  if (gameOver) {
    ctx.fillStyle = "rgba(5,12,10,0.62)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 58px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("The ritual slipped", canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = "800 24px system-ui";
    ctx.fillText(`Score ${Math.floor(score)} · Bread ${bread}`, canvas.width / 2, canvas.height / 2 + 34);
  }
}

function draw() {
  if (document.hidden) return;
  const background = drawBackground(currentPresetIndex());
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(background, 0, 0);
  artifacts.forEach(drawArtifact);
  powerups.forEach(drawPowerup);
  stones.forEach(drawStone);
  particles.forEach((particle) => {
    ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  drawPlayer();
  drawOverlay();
}

function loop(time) {
  const dt = Math.min((time - lastTime) / 1000 || 0, 0.033);
  lastTime = time;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

startButton.addEventListener("click", () => {
  if (gameOver) resetGame();
  running = true;
});

pauseButton.addEventListener("click", () => {
  running = !running;
  pauseButton.textContent = running ? "Pause" : "Resume";
});

resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", () => services.loadLeaderboard());

scoreForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await services.submitScore({ score, bread });
  scoreForm.hidden = true;
});

window.addEventListener("keydown", (event) => {
  keys.add(event.key);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) {
    event.preventDefault();
  }
  if (event.key === " ") running = true;
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key);
});

window.addEventListener("resize", scheduleRectRefresh);

canvas.addEventListener("pointerdown", (event) => {
  canvasRect = canvas.getBoundingClientRect();
  pointer.active = true;
  setPointerFromEvent(event);
  running = true;
});

canvas.addEventListener("pointermove", (event) => {
  if (!pointer.active) return;
  setPointerFromEvent(event);
});

canvas.addEventListener("pointerup", () => {
  pointer.active = false;
});

canvas.addEventListener("pointerleave", () => {
  pointer.active = false;
});

document.addEventListener("visibilitychange", () => {
  lastTime = performance.now();
  if (!document.hidden) draw();
});

resetGame();
services.renderLeaderboard();
services.loadLeaderboard();
requestAnimationFrame(loop);
