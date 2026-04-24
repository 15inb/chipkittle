import {
  clamp,
  createBackgroundCache,
  createGameServices,
  distanceSq,
  rand
} from "/game-common.js";

const canvas = document.querySelector("#catchCanvas");
const ctx = canvas.getContext("2d");
const scoreValue = document.querySelector("#scoreValue");
const breadValue = document.querySelector("#breadValue");
const timeValue = document.querySelector("#timeValue");
const powerupStatus = document.querySelector("#powerupStatus");
const playerName = document.querySelector("#playerName");
const startButton = document.querySelector("#startGame");
const resetButton = document.querySelector("#resetGame");
const refreshLeaderboard = document.querySelector("#refreshLeaderboard");

const services = createGameServices("catch", {
  leaderboardList: document.querySelector("#leaderboardList"),
  leaderboardStatus: document.querySelector("#leaderboardStatus"),
  claimCard: document.querySelector("#claimCard"),
  playerName,
  emptyText: "No catches saved yet"
});

const basket = {
  x: 480,
  y: 468,
  width: 108,
  baseWidth: 108,
  height: 30
};

const keys = new Set();
let pointerActive = false;
let canvasRect = null;
const backgroundImage = createBackgroundCache(canvas, (cacheCtx, targetCanvas) => {
  const gradient = cacheCtx.createLinearGradient(0, 0, 0, targetCanvas.height);
  gradient.addColorStop(0, "#eef8ec");
  gradient.addColorStop(1, "#9ab7a0");
  cacheCtx.fillStyle = gradient;
  cacheCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  cacheCtx.fillStyle = "rgba(255,255,255,0.18)";
  for (let i = 0; i < 8; i += 1) {
    cacheCtx.beginPath();
    cacheCtx.arc(70 + i * 120, 92 + (i % 3) * 34, 42 + (i % 2) * 10, 0, Math.PI * 2);
    cacheCtx.fill();
  }
  cacheCtx.fillStyle = "rgba(25,48,32,0.12)";
  for (let y = 76; y < targetCanvas.height; y += 70) {
    cacheCtx.fillRect(0, y, targetCanvas.width, 2);
  }
});

let drops = [];
let running = false;
let ended = false;
let scoreSaved = false;
let lastTime = 0;
let spawnTimer = 0;
let powerupSpawnTimer = 6;
let score = 0;
let bread = 0;
let timeLeft = 45;
let wideTimer = 0;
let slowTimer = 0;
let magnetTimer = 0;

function updateStats() {
  scoreValue.textContent = String(Math.floor(score));
  breadValue.textContent = String(bread);
  timeValue.textContent = String(Math.max(Math.ceil(timeLeft), 0));
}

function updatePowerupStatus() {
  const labels = [];
  if (wideTimer > 0) labels.push(`Wide ${Math.ceil(wideTimer)}s`);
  if (slowTimer > 0) labels.push(`Slow ${Math.ceil(slowTimer)}s`);
  if (magnetTimer > 0) labels.push(`Magnet ${Math.ceil(magnetTimer)}s`);
  powerupStatus.textContent = `Power-up: ${labels.join(" | ") || "None"}`;
}

function syncBasketWidth() {
  basket.width = basket.baseWidth * (wideTimer > 0 ? 1.5 : 1);
}

function setBasketFromEvent(event) {
  if (!canvasRect) canvasRect = canvas.getBoundingClientRect();
  const point = event.touches?.[0] || event;
  basket.x = clamp((point.clientX - canvasRect.left) * (canvas.width / canvasRect.width), basket.width / 2, canvas.width - basket.width / 2);
}

function spawnDrop() {
  const roll = Math.random();
  let type = "bread";
  if (roll < 0.24) type = "stone";
  else if (roll < 0.32) type = "gold";

  drops.push({
    x: rand(45, canvas.width - 45),
    y: -35,
    speed: rand(240, 410),
    type,
    size: type === "stone" ? 38 : type === "gold" ? 26 : 24,
    spin: rand(0, Math.PI * 2)
  });
}

function spawnPowerup() {
  const types = ["wide", "slow", "magnet"];
  drops.push({
    x: rand(65, canvas.width - 65),
    y: -35,
    speed: rand(220, 300),
    type: types[Math.floor(Math.random() * types.length)],
    size: 28,
    spin: rand(0, Math.PI * 2)
  });
}

function applyPowerup(type) {
  if (type === "wide") wideTimer = 8;
  if (type === "slow") slowTimer = 8;
  if (type === "magnet") magnetTimer = 8;
  syncBasketWidth();
  updatePowerupStatus();
}

function resetGame() {
  drops = [];
  running = false;
  ended = false;
  scoreSaved = false;
  lastTime = 0;
  spawnTimer = 0;
  powerupSpawnTimer = 6;
  score = 0;
  bread = 0;
  timeLeft = 45;
  basket.x = 480;
  wideTimer = 0;
  slowTimer = 0;
  magnetTimer = 0;
  syncBasketWidth();
  services.resetClaimState("Catch bread until the round ends to get a claim code.");
  updateStats();
  updatePowerupStatus();
  draw();
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

function basketHit(drop) {
  const top = basket.y;
  const left = basket.x - basket.width / 2;
  const right = basket.x + basket.width / 2;
  return drop.y + drop.size / 2 >= top
    && drop.y - drop.size / 2 <= top + basket.height
    && drop.x >= left - drop.size / 2
    && drop.x <= right + drop.size / 2;
}

function update(dt) {
  if (!running || ended) return;

  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    endGame();
    updateStats();
    return;
  }

  if (keys.has("ArrowLeft") || keys.has("a")) basket.x -= 500 * dt;
  if (keys.has("ArrowRight") || keys.has("d")) basket.x += 500 * dt;
  basket.x = clamp(basket.x, basket.width / 2, canvas.width - basket.width / 2);

  wideTimer = Math.max(0, wideTimer - dt);
  slowTimer = Math.max(0, slowTimer - dt);
  magnetTimer = Math.max(0, magnetTimer - dt);
  syncBasketWidth();

  spawnTimer -= dt;
  powerupSpawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnDrop();
    spawnTimer = Math.max(0.15, 0.46 - score * 0.0018) + rand(0.08, 0.18);
  }
  if (powerupSpawnTimer <= 0) {
    spawnPowerup();
    powerupSpawnTimer = rand(7, 10);
  }

  const speedFactor = slowTimer > 0 ? 0.62 : 1;
  const magnetRange = magnetTimer > 0 ? 150 : 0;
  drops.forEach((drop) => {
    drop.spin += dt * 4;
    drop.y += drop.speed * dt * speedFactor;
    if (magnetRange > 0 && (drop.type === "bread" || drop.type === "gold")) {
      const dx = basket.x - drop.x;
      const dy = basket.y - drop.y;
      const dist = Math.hypot(dx, dy);
      if (dist < magnetRange && dist > 0.1) {
        const pull = (1 - dist / magnetRange) * 260 * dt;
        drop.x += (dx / dist) * pull;
      }
    }
  });

  drops = drops.filter((drop) => {
    if (basketHit(drop)) {
      if (drop.type === "bread") {
        bread += 1;
        score += 7;
      } else if (drop.type === "gold") {
        bread += 2;
        score += 20;
      } else if (drop.type === "stone") {
        score = Math.max(score - 28, 0);
        timeLeft = Math.max(timeLeft - 7, 0);
      } else {
        applyPowerup(drop.type);
      }
      updateStats();
      return false;
    }
    return drop.y < canvas.height + 60;
  });

  updateStats();
  updatePowerupStatus();
}

function drawDrop(drop) {
  ctx.save();
  ctx.translate(drop.x, drop.y);
  ctx.rotate(drop.spin * 0.3);
  if (drop.type === "bread" || drop.type === "gold") {
    ctx.fillStyle = drop.type === "gold" ? "#f3d463" : "#d99a3b";
    ctx.strokeStyle = drop.type === "gold" ? "#9b7710" : "#875719";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(-18, -12, 36, 24, 8);
    ctx.fill();
    ctx.stroke();
  } else if (drop.type === "stone") {
    ctx.fillStyle = "#111917";
    ctx.beginPath();
    ctx.arc(0, 0, drop.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (drop.type === "wide") {
    ctx.fillStyle = "#69d58b";
    ctx.fillRect(-18, -8, 36, 16);
    ctx.fillStyle = "#edfff0";
    ctx.fillRect(-8, -4, 16, 8);
  } else if (drop.type === "slow") {
    ctx.strokeStyle = "#aef0ff";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#edffff";
    ctx.fillRect(-2, -10, 4, 10);
    ctx.fillRect(-2, -2, 8, 4);
  } else {
    ctx.strokeStyle = "#ef667b";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, 13, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.strokeStyle = "#6dc3ff";
    ctx.beginPath();
    ctx.arc(0, 0, 13, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(backgroundImage("base"), 0, 0);
  drops.forEach(drawDrop);
  ctx.fillStyle = "#1a8a38";
  ctx.beginPath();
  ctx.roundRect(basket.x - basket.width / 2, basket.y, basket.width, basket.height, 12);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillRect(basket.x - basket.width * 0.36, basket.y + 8, basket.width * 0.72, 6);
  if (!running) {
    ctx.fillStyle = "rgba(5,12,10,0.48)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "900 54px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(ended ? "Basket closed" : "Bread Catch", canvas.width / 2, canvas.height / 2);
    ctx.font = "800 22px system-ui";
    ctx.fillText("Move with arrows, A/D, or drag", canvas.width / 2, canvas.height / 2 + 42);
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
  if (ended) resetGame();
  running = true;
});
resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", () => services.loadLeaderboard());

canvas.addEventListener("pointerdown", (event) => {
  canvasRect = canvas.getBoundingClientRect();
  pointerActive = true;
  setBasketFromEvent(event);
  if (!ended) running = true;
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointerActive) return;
  setBasketFromEvent(event);
});
canvas.addEventListener("pointerup", () => {
  pointerActive = false;
});
canvas.addEventListener("pointerleave", () => {
  pointerActive = false;
});
window.addEventListener("resize", () => {
  canvasRect = null;
});

window.addEventListener("keydown", (event) => {
  keys.add(event.key);
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.key);
});

resetGame();
services.renderLeaderboard();
services.loadLeaderboard();
requestAnimationFrame(loop);
