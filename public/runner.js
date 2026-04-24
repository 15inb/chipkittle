import {
  clamp,
  createBackgroundCache,
  createGameServices,
  distanceSq,
  rand
} from "/game-common.js";

const canvas = document.querySelector("#runnerCanvas");
const ctx = canvas.getContext("2d");
const scoreValue = document.querySelector("#scoreValue");
const breadValue = document.querySelector("#breadValue");
const powerupStatus = document.querySelector("#powerupStatus");
const playerName = document.querySelector("#playerName");
const startButton = document.querySelector("#startGame");
const resetButton = document.querySelector("#resetGame");
const refreshLeaderboard = document.querySelector("#refreshLeaderboard");

const services = createGameServices("runner", {
  leaderboardList: document.querySelector("#leaderboardList"),
  leaderboardStatus: document.querySelector("#leaderboardStatus"),
  claimCard: document.querySelector("#claimCard"),
  playerName,
  emptyText: "No runs saved yet"
});

const groundY = 430;
const keys = new Set();
const player = {
  x: 116,
  y: groundY,
  vy: 0,
  width: 48,
  height: 56,
  grounded: true,
  coyote: 0,
  jumpBuffer: 0,
  jumpsLeft: 1,
  shield: 0,
  feather: 0,
  magnet: 0
};

let running = false;
let ended = false;
let scoreSaved = false;
let lastTime = 0;
let score = 0;
let bread = 0;
let speed = 300;
let spawnTimer = 0;
let breadTimer = 0.7;
let powerupTimer = 5.5;
let obstacles = [];
let breads = [];
let powerups = [];
let dust = [];
let lastStatsText = "";
let lastPowerupText = "";

const drawBackground = createBackgroundCache(canvas, (cacheCtx, targetCanvas, key) => {
  const palettes = [
    ["#e9f7e6", "#d4e6d5", "#98b29d"],
    ["#e8f0fa", "#d0dbe9", "#8da5bd"],
    ["#f4ede8", "#dfd1c8", "#b49c87"]
  ];
  const palette = palettes[key % palettes.length];
  const gradient = cacheCtx.createLinearGradient(0, 0, 0, targetCanvas.height);
  gradient.addColorStop(0, palette[0]);
  gradient.addColorStop(1, palette[2]);
  cacheCtx.fillStyle = gradient;
  cacheCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  cacheCtx.fillStyle = "rgba(255,255,255,0.18)";
  for (let i = 0; i < 7; i += 1) {
    cacheCtx.beginPath();
    cacheCtx.arc(100 + i * 150, 80 + (i % 2) * 40, 56 + (i % 3) * 16, 0, Math.PI * 2);
    cacheCtx.fill();
  }
  cacheCtx.strokeStyle = "rgba(16,25,21,0.12)";
  for (let x = -80; x < targetCanvas.width + 100; x += 82) {
    cacheCtx.beginPath();
    cacheCtx.moveTo(x, targetCanvas.height);
    cacheCtx.lineTo(x + 250, 0);
    cacheCtx.stroke();
  }
  cacheCtx.fillStyle = "#6b7c74";
  cacheCtx.fillRect(0, 460, targetCanvas.width, 80);
  cacheCtx.fillStyle = "#85958e";
  cacheCtx.fillRect(0, 448, targetCanvas.width, 14);
});

function updateStats() {
  const next = `${Math.floor(score)}:${bread}`;
  if (next === lastStatsText) return;
  lastStatsText = next;
  scoreValue.textContent = String(Math.floor(score));
  breadValue.textContent = String(bread);
}

function updatePowerupStatus() {
  const labels = [];
  if (player.shield > 0) labels.push(`Shield ${Math.ceil(player.shield)}s`);
  if (player.feather > 0) labels.push(`Feather ${Math.ceil(player.feather)}s`);
  if (player.magnet > 0) labels.push(`Magnet ${Math.ceil(player.magnet)}s`);
  const next = `Power-up: ${labels.join(" | ") || "None"}`;
  if (next === lastPowerupText) return;
  lastPowerupText = next;
  powerupStatus.textContent = next;
}

function puff(x, y, color = "rgba(255,255,255,0.55)", count = 5) {
  for (let index = 0; index < count; index += 1) {
    dust.push({
      x,
      y,
      vx: rand(-60, 25),
      vy: rand(-44, 8),
      life: rand(0.22, 0.5),
      maxLife: 0.5,
      radius: rand(3, 7),
      color
    });
  }
}

function resetGame() {
  running = false;
  ended = false;
  scoreSaved = false;
  lastTime = 0;
  score = 0;
  bread = 0;
  speed = 300;
  spawnTimer = 0;
  breadTimer = 0.7;
  powerupTimer = 5.5;
  obstacles = [];
  breads = [];
  powerups = [];
  dust = [];
  Object.assign(player, {
    y: groundY,
    vy: 0,
    grounded: true,
    coyote: 0,
    jumpBuffer: 0,
    jumpsLeft: 1,
    shield: 0,
    feather: 0,
    magnet: 0
  });
  services.resetClaimState("Collect bread, then crash or finish to get a claim code.");
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

function requestJump() {
  player.jumpBuffer = 0.14;
  if (!running && !ended) running = true;
}

function performJump() {
  player.vy = -710;
  player.grounded = false;
  player.coyote = 0;
  player.jumpBuffer = 0;
  player.jumpsLeft -= 1;
}

function spawnObstacle() {
  const tall = Math.random() < 0.28;
  obstacles.push({
    x: canvas.width + 70,
    y: groundY,
    width: tall ? 40 : 52,
    height: tall ? 88 : 52
  });
}

function spawnBread() {
  breads.push({
    x: canvas.width + 50,
    y: rand(282, 386),
    radius: 16,
    speedOffset: rand(-10, 50),
    spin: rand(0, Math.PI * 2)
  });
}

function spawnPowerup() {
  const types = ["shield", "feather", "magnet"];
  powerups.push({
    x: canvas.width + 60,
    y: rand(260, 360),
    radius: 18,
    type: types[Math.floor(Math.random() * types.length)],
    speedOffset: rand(-20, 30),
    phase: rand(0, Math.PI * 2)
  });
}

function applyPowerup(type) {
  if (type === "shield") player.shield = 8;
  if (type === "feather") {
    player.feather = 10;
    player.jumpsLeft = Math.max(player.jumpsLeft, 2);
  }
  if (type === "magnet") player.magnet = 8;
  updatePowerupStatus();
}

function intersectsRect(circle, rect) {
  const nearestX = clamp(circle.x, rect.x, rect.x + rect.width);
  const nearestY = clamp(circle.y, rect.y - rect.height, rect.y);
  const dx = circle.x - nearestX;
  const dy = circle.y - nearestY;
  return (dx * dx + dy * dy) < (circle.radius * circle.radius);
}

function update(dt) {
  if (!running || ended) return;

  score += dt * 16;
  speed = Math.min(680, speed + dt * 12);

  player.coyote = player.grounded ? 0.12 : Math.max(0, player.coyote - dt);
  player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
  player.shield = Math.max(0, player.shield - dt);
  player.feather = Math.max(0, player.feather - dt);
  player.magnet = Math.max(0, player.magnet - dt);
  if (player.feather <= 0 && player.grounded) {
    player.jumpsLeft = 1;
  }

  if ((keys.has(" ") || keys.has("ArrowUp") || keys.has("w")) && player.jumpBuffer <= 0.02) {
    player.jumpBuffer = 0.12;
  }
  if (player.jumpBuffer > 0) {
    const groundedJump = player.grounded || player.coyote > 0;
    if (groundedJump && player.jumpsLeft > 0) {
      player.jumpsLeft = player.feather > 0 ? 2 : 1;
      performJump();
    } else if (!player.grounded && player.feather > 0 && player.jumpsLeft > 1) {
      performJump();
    }
  }

  player.vy += 1820 * dt;
  player.y += player.vy * dt;
  if (player.y >= groundY) {
    if (!player.grounded && player.vy > 260) {
      puff(player.x - 18, groundY + 20, "rgba(238,246,233,0.55)", 6);
    }
    player.y = groundY;
    player.vy = 0;
    player.grounded = true;
    player.jumpsLeft = player.feather > 0 ? 2 : 1;
  } else {
    player.grounded = false;
  }

  spawnTimer -= dt;
  breadTimer -= dt;
  powerupTimer -= dt;
  if (spawnTimer <= 0) {
    spawnObstacle();
    spawnTimer = Math.max(0.45, 0.92 - score * 0.002) + rand(0.1, 0.28);
  }
  if (breadTimer <= 0) {
    spawnBread();
    breadTimer = rand(0.5, 0.95);
  }
  if (powerupTimer <= 0) {
    spawnPowerup();
    powerupTimer = rand(7, 10);
  }

  const magnetRange = player.magnet > 0 ? 150 : 0;
  obstacles.forEach((item) => {
    item.x -= speed * dt;
  });
  breads.forEach((item) => {
    item.x -= (speed + item.speedOffset) * dt;
    item.spin += dt * 5;
    if (magnetRange > 0) {
      const dx = player.x - item.x;
      const dy = (player.y - 18) - item.y;
      const dist = Math.hypot(dx, dy);
      if (dist < magnetRange && dist > 0.1) {
        const pull = (1 - dist / magnetRange) * 300 * dt;
        item.x += (dx / dist) * pull;
        item.y += (dy / dist) * pull;
      }
    }
  });
  powerups.forEach((item) => {
    item.x -= (speed + item.speedOffset) * dt;
    item.phase += dt * 4;
  });

  const playerHitbox = {
    x: player.x - player.width * 0.4,
    y: player.y - player.height * 0.92,
    width: player.width * 0.8,
    height: player.height * 0.96,
    radius: 26
  };

  breads = breads.filter((item) => {
    const combined = 24 + item.radius;
    if (distanceSq({ x: player.x, y: player.y - 18 }, item) < combined * combined) {
      bread += 1;
      score += 12;
      puff(item.x, item.y, "rgba(216,154,60,0.7)", 4);
      updateStats();
      return false;
    }
    return item.x > -40;
  });

  powerups = powerups.filter((item) => {
    const combined = 26 + item.radius;
    if (distanceSq({ x: player.x, y: player.y - 18 }, item) < combined * combined) {
      applyPowerup(item.type);
      puff(item.x, item.y, "rgba(128,255,180,0.7)", 7);
      return false;
    }
    return item.x > -40;
  });

  for (const obstacle of obstacles) {
    const collides = player.x + 18 > obstacle.x - obstacle.width / 2
      && player.x - 16 < obstacle.x + obstacle.width / 2
      && player.y > obstacle.y - obstacle.height
      && player.y - player.height < obstacle.y + 2;
    if (collides) {
      if (player.shield > 0) {
        player.shield = 0;
        obstacle.x = -120;
        updatePowerupStatus();
        continue;
      }
      endGame();
      break;
    }
  }
  obstacles = obstacles.filter((item) => item.x > -90);
  dust.forEach((particle) => {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.life -= dt;
  });
  dust = dust.filter((particle) => particle.life > 0);
  updateStats();
  updatePowerupStatus();
}

function drawPlayer() {
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.fillStyle = "#f7faf5";
  ctx.beginPath();
  ctx.ellipse(0, -16, 24, 28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#0c130f";
  ctx.beginPath();
  ctx.arc(-8, -20, 5, 0, Math.PI * 2);
  ctx.arc(8, -20, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f1d0bd";
  ctx.beginPath();
  ctx.ellipse(0, 8, 14, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d6dad2";
  ctx.fillRect(-16, 6, 12, 34);
  ctx.fillRect(4, 6, 12, 34);
  if (player.shield > 0) {
    ctx.strokeStyle = "rgba(111, 178, 255, 0.86)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, -8, 36, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBread(item) {
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.rotate(item.spin);
  ctx.fillStyle = "#d69a3c";
  ctx.strokeStyle = "#8d5a20";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(-16, -11, 32, 22, 8);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPowerup(item) {
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.rotate(item.phase * 0.2);
  if (item.type === "shield") {
    ctx.fillStyle = "#4f91f2";
    ctx.beginPath();
    ctx.arc(0, 0, item.radius, 0, Math.PI * 2);
    ctx.fill();
  } else if (item.type === "feather") {
    ctx.fillStyle = "#f7f2ff";
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, 18, Math.PI * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#9d8ad8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-4, -12);
    ctx.lineTo(6, 14);
    ctx.stroke();
  } else {
    ctx.strokeStyle = "#ef667b";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, item.radius - 3, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.strokeStyle = "#6dc3ff";
    ctx.beginPath();
    ctx.arc(0, 0, item.radius - 3, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.restore();
}

function drawObstacle(item) {
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.fillStyle = "#121a17";
  ctx.strokeStyle = "#4d5c54";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-item.width / 2, 0);
  ctx.lineTo(-item.width * 0.18, -item.height);
  ctx.lineTo(item.width / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawOverlay() {
  if (!running) {
    ctx.fillStyle = "rgba(5,12,10,0.48)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "900 54px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(ended ? "Ritual complete" : "Ritual Runner", canvas.width / 2, canvas.height / 2);
    ctx.font = "800 22px system-ui";
    ctx.fillText("Space, click, or tap to jump", canvas.width / 2, canvas.height / 2 + 42);
  }
}

function draw() {
  if (document.hidden) return;
  const background = drawBackground(Math.floor(score / 550));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(background, 0, 0);
  breads.forEach(drawBread);
  powerups.forEach(drawPowerup);
  obstacles.forEach(drawObstacle);
  dust.forEach((particle) => {
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
  if (ended) resetGame();
  running = true;
});
resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", () => services.loadLeaderboard());

canvas.addEventListener("pointerdown", () => {
  requestJump();
});

window.addEventListener("keydown", (event) => {
  keys.add(event.key);
  if (event.key === " " || event.key === "ArrowUp" || event.key === "w") {
    event.preventDefault();
    requestJump();
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key);
});

document.addEventListener("visibilitychange", () => {
  lastTime = performance.now();
  if (!document.hidden) draw();
});

resetGame();
services.renderLeaderboard();
services.loadLeaderboard();
requestAnimationFrame(loop);
