import {
  clamp,
  createBackgroundCache,
  createGameServices,
  rand
} from "/game-common.js";

const canvas = document.querySelector("#hopperCanvas");
const ctx = canvas.getContext("2d");
const scoreValue = document.querySelector("#scoreValue");
const breadValue = document.querySelector("#breadValue");
const livesValue = document.querySelector("#livesValue");
const statusValue = document.querySelector("#statusValue");
const playerName = document.querySelector("#playerName");
const startButton = document.querySelector("#startGame");
const resetButton = document.querySelector("#resetGame");
const refreshLeaderboard = document.querySelector("#refreshLeaderboard");

const services = createGameServices("loaf", {
  leaderboardList: document.querySelector("#leaderboardList"),
  leaderboardStatus: document.querySelector("#leaderboardStatus"),
  claimCard: document.querySelector("#claimCard"),
  playerName,
  emptyText: "No hopper runs saved yet"
});

const cols = 10;
const rows = 9;
const cellWidth = canvas.width / cols;
const cellHeight = 56;
const boardTop = 18;
const boardBottom = boardTop + rows * cellHeight;
const altarRow = 0;
const startRow = rows - 1;

const laneConfigs = [
  { type: "altar" },
  { type: "road", dir: 1, speed: 135, size: 74, spacing: 214, color: "#4252c9" },
  { type: "bread", dir: -1, speed: 118, size: 92, spacing: 226, color: "#d99a3b" },
  { type: "road", dir: -1, speed: 168, size: 58, spacing: 180, color: "#111917" },
  { type: "safe" },
  { type: "road", dir: 1, speed: 196, size: 66, spacing: 172, color: "#7e3147" },
  { type: "bread", dir: -1, speed: 138, size: 90, spacing: 222, color: "#cf8f31" },
  { type: "road", dir: 1, speed: 146, size: 80, spacing: 236, color: "#23844d" },
  { type: "start" }
];

const altarSlots = [0, 2, 4, 6, 8];
const laneEntities = [];
const breadPickups = [];
const sparks = [];
let running = false;
let ended = false;
let scoreSaved = false;
let score = 0;
let bread = 0;
let lives = 3;
let level = 1;
let lastTime = 0;
let moveCooldown = 0;
let pointerRect = null;
let statusText = "";
let lastStatsText = "";

const player = {
  col: Math.floor(cols / 2),
  row: startRow,
  blink: 0,
  invulnerable: 0
};

let altars = altarSlots.map((col) => ({ col, filled: false }));

const drawBackground = createBackgroundCache(canvas, (cacheCtx, targetCanvas) => {
  const gradient = cacheCtx.createLinearGradient(0, 0, 0, targetCanvas.height);
  gradient.addColorStop(0, "#eff7ec");
  gradient.addColorStop(0.52, "#dbe6d9");
  gradient.addColorStop(1, "#97ac9f");
  cacheCtx.fillStyle = gradient;
  cacheCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
});

function setStatus(next) {
  if (next === statusText) return;
  statusText = next;
  statusValue.textContent = next;
}

function updateStats() {
  const next = `${score}:${bread}:${lives}`;
  if (next === lastStatsText) return;
  lastStatsText = next;
  scoreValue.textContent = String(score);
  breadValue.textContent = String(bread);
  livesValue.textContent = String(lives);
}

function ensurePlayerReady() {
  if (services.hasPlayerName()) {
    services.persistPlayerName();
    services.setLeaderboardStatus("");
    return true;
  }
  services.setLeaderboardStatus("Add your player name before starting Loaf Hopper.");
  services.focusPlayerName();
  return false;
}

function rowCenter(row) {
  return boardTop + row * cellHeight + cellHeight / 2;
}

function colCenter(col) {
  return col * cellWidth + cellWidth / 2;
}

function playerPosition() {
  return { x: colCenter(player.col), y: rowCenter(player.row) };
}

function spawnLanes() {
  laneEntities.length = 0;
  breadPickups.length = 0;
  for (let row = 1; row < rows - 1; row += 1) {
    const config = laneConfigs[row];
    if (config.type === "safe") continue;
    const speed = config.speed + (level - 1) * 12;
    const offset = rand(0, config.spacing);
    for (let x = -config.spacing; x < canvas.width + config.spacing; x += config.spacing) {
      laneEntities.push({
        row,
        type: config.type,
        x: x + offset,
        y: rowCenter(row),
        dir: config.dir,
        speed,
        size: config.size,
        color: config.color
      });
    }
    if (config.type === "bread") {
      for (let pick = 0; pick < 2; pick += 1) {
        breadPickups.push({
          row,
          x: rand(70, canvas.width - 70),
          taken: false,
          wobble: rand(0, Math.PI * 2)
        });
      }
    }
  }
}

function addSpark(x, y, color, count = 7) {
  for (let index = 0; index < count; index += 1) {
    sparks.push({
      x,
      y,
      vx: rand(-90, 90),
      vy: rand(-120, 30),
      life: rand(0.2, 0.45),
      maxLife: 0.45,
      radius: rand(2, 5),
      color
    });
  }
}

function resetPlayer() {
  player.col = Math.floor(cols / 2);
  player.row = startRow;
  player.invulnerable = 1.25;
}

function loseLife() {
  if (player.invulnerable > 0 || ended) return;
  lives -= 1;
  updateStats();
  addSpark(colCenter(player.col), rowCenter(player.row), "#ff8d8d", 10);
  if (lives <= 0) {
    endGame();
    return;
  }
  setStatus("A cursed lane clipped you. Hop again.");
  resetPlayer();
}

function completeLevel() {
  level += 1;
  score += 120;
  bread += 2;
  altars = altarSlots.map((col) => ({ col, filled: false }));
  spawnLanes();
  resetPlayer();
  updateStats();
  setStatus(`Altars restored. Level ${level} begins.`);
}

function endGame() {
  if (ended) return;
  ended = true;
  running = false;
  setStatus("The loaf crossing collapsed.");
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
  lives = 3;
  level = 1;
  lastTime = 0;
  moveCooldown = 0;
  statusText = "";
  lastStatsText = "";
  sparks.length = 0;
  altars = altarSlots.map((col) => ({ col, filled: false }));
  resetPlayer();
  spawnLanes();
  updateStats();
  setStatus("Altars open. Hop with arrows, WASD, or tap nearby.");
  services.resetClaimState("Collect bread and survive as long as you can to get a claim code.");
  draw();
}

function attemptMove(dx, dy) {
  if (moveCooldown > 0 || ended) return;
  const nextCol = clamp(player.col + dx, 0, cols - 1);
  const nextRow = clamp(player.row + dy, 0, rows - 1);
  if (nextCol === player.col && nextRow === player.row) return;
  player.col = nextCol;
  player.row = nextRow;
  moveCooldown = 0.11;
  player.blink = 0.12;
  if (dy < 0) score += 6;
  updateStats();

  if (player.row === altarRow) {
    const altar = altars.find((slot) => slot.col === player.col);
    if (!altar || altar.filled) {
      loseLife();
      return;
    }
    altar.filled = true;
    score += 60;
    bread += 1;
    addSpark(colCenter(player.col), rowCenter(player.row), "#f5d35c", 12);
    updateStats();
    setStatus(`${altars.filter((slot) => slot.filled).length}/${altars.length} altars sealed.`);
    if (altars.every((slot) => slot.filled)) {
      completeLevel();
    } else {
      resetPlayer();
    }
  }
}

function handlePointer(event) {
  if (!ensurePlayerReady()) return;
  if (!pointerRect) pointerRect = canvas.getBoundingClientRect();
  const point = event.touches?.[0] || event;
  const x = (point.clientX - pointerRect.left) * (canvas.width / pointerRect.width);
  const y = (point.clientY - pointerRect.top) * (canvas.height / pointerRect.height);
  const playerPos = playerPosition();
  const dx = x - playerPos.x;
  const dy = y - playerPos.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    attemptMove(dx > 0 ? 1 : -1, 0);
  } else {
    attemptMove(0, dy > 0 ? 1 : -1);
  }
  if (!ended) running = true;
}

function update(dt) {
  if (!running || ended) return;

  moveCooldown = Math.max(0, moveCooldown - dt);
  player.blink = Math.max(0, player.blink - dt);
  player.invulnerable = Math.max(0, player.invulnerable - dt);

  for (let index = 0; index < laneEntities.length; index += 1) {
    const entity = laneEntities[index];
    entity.x += entity.dir * entity.speed * dt;
    if (entity.dir > 0 && entity.x - entity.size / 2 > canvas.width + 40) entity.x = -entity.size;
    if (entity.dir < 0 && entity.x + entity.size / 2 < -40) entity.x = canvas.width + entity.size;
  }

  for (let index = 0; index < breadPickups.length; index += 1) {
    const pickup = breadPickups[index];
    if (pickup.taken) continue;
    pickup.wobble += dt * 4;
    const dx = colCenter(player.col) - pickup.x;
    const dy = rowCenter(player.row) - rowCenter(pickup.row);
    if (Math.abs(dy) < cellHeight * 0.35 && Math.abs(dx) < cellWidth * 0.32) {
      pickup.taken = true;
      bread += 1;
      score += 18;
      addSpark(pickup.x, rowCenter(pickup.row), "#d99a3b", 6);
      updateStats();
    }
  }

  const playerX = colCenter(player.col);
  for (let index = 0; index < laneEntities.length; index += 1) {
    const entity = laneEntities[index];
    if (entity.row !== player.row || player.invulnerable > 0) continue;
    if (Math.abs(entity.x - playerX) < entity.size * 0.42) {
      loseLife();
      break;
    }
  }

  for (let index = sparks.length - 1; index >= 0; index -= 1) {
    const spark = sparks[index];
    spark.x += spark.vx * dt;
    spark.y += spark.vy * dt;
    spark.vy += 210 * dt;
    spark.life -= dt;
    if (spark.life <= 0) sparks.splice(index, 1);
  }
}

function drawBoard() {
  ctx.drawImage(drawBackground("base"), 0, 0);
  for (let row = 0; row < rows; row += 1) {
    const top = boardTop + row * cellHeight;
    const lane = laneConfigs[row];
    if (lane.type === "altar") {
      ctx.fillStyle = "#182d21";
    } else if (lane.type === "safe" || lane.type === "start") {
      ctx.fillStyle = row === startRow ? "#5d735f" : "#829182";
    } else if (lane.type === "bread") {
      ctx.fillStyle = "#4d5f87";
    } else {
      ctx.fillStyle = "#30363c";
    }
    ctx.fillRect(0, top, canvas.width, cellHeight - 2);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  for (let col = 0; col <= cols; col += 1) {
    const x = col * cellWidth;
    ctx.beginPath();
    ctx.moveTo(x, boardTop);
    ctx.lineTo(x, boardBottom);
    ctx.stroke();
  }

  for (let index = 0; index < altars.length; index += 1) {
    const altar = altars[index];
    const x = altar.col * cellWidth + cellWidth * 0.14;
    const y = boardTop + 8;
    ctx.fillStyle = altar.filled ? "#79d66f" : "#1d3b2a";
    ctx.strokeStyle = altar.filled ? "#ecffde" : "#7aa285";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, cellWidth * 0.72, cellHeight - 18, 16);
    ctx.fill();
    ctx.stroke();
  }
}

function drawEntities() {
  for (let index = 0; index < laneEntities.length; index += 1) {
    const entity = laneEntities[index];
    ctx.save();
    ctx.translate(entity.x, entity.y);
    if (entity.type === "bread") {
      ctx.fillStyle = entity.color;
      ctx.strokeStyle = "#774315";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-entity.size * 0.45, -17, entity.size * 0.9, 34, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(-entity.size * 0.18, -6, entity.size * 0.36, 5);
    } else {
      ctx.fillStyle = entity.color;
      ctx.beginPath();
      ctx.roundRect(-entity.size * 0.5, -18, entity.size, 36, 12);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(-entity.size * 0.22, -9, entity.size * 0.44, 8);
    }
    ctx.restore();
  }

  for (let index = 0; index < breadPickups.length; index += 1) {
    const pickup = breadPickups[index];
    if (pickup.taken) continue;
    ctx.save();
    ctx.translate(pickup.x, rowCenter(pickup.row) + Math.sin(pickup.wobble) * 4);
    ctx.rotate(pickup.wobble * 0.2);
    ctx.fillStyle = "#f1c768";
    ctx.strokeStyle = "#8d5a20";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-12, -9, 24, 18, 7);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawPlayer() {
  const { x, y } = playerPosition();
  if (player.invulnerable > 0 && Math.floor(player.invulnerable * 12) % 2 === 0) return;
  ctx.save();
  ctx.translate(x, y + (player.blink > 0 ? -6 : 0));
  ctx.fillStyle = "#f7faf5";
  ctx.beginPath();
  ctx.ellipse(0, 0, 22, 24, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111917";
  ctx.beginPath();
  ctx.arc(-7, -5, 4, 0, Math.PI * 2);
  ctx.arc(7, -5, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f1d0bd";
  ctx.beginPath();
  ctx.ellipse(0, 10, 12, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawOverlay() {
  if (!running && !ended) {
    ctx.fillStyle = "rgba(7,12,10,0.42)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "900 54px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Loaf Hopper", canvas.width / 2, canvas.height / 2 - 8);
    ctx.font = "800 22px system-ui";
    ctx.fillText("Reach the altar pads and dodge the cursed lanes", canvas.width / 2, canvas.height / 2 + 34);
  }
  if (ended) {
    ctx.fillStyle = "rgba(7,12,10,0.56)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "900 56px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Ritual lost", canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = "800 24px system-ui";
    ctx.fillText(`Score ${score} | Bread ${bread}`, canvas.width / 2, canvas.height / 2 + 30);
  }
}

function draw() {
  if (document.hidden) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBoard();
  drawEntities();
  for (let index = 0; index < sparks.length; index += 1) {
    const spark = sparks[index];
    ctx.globalAlpha = Math.max(0, spark.life / spark.maxLife);
    ctx.fillStyle = spark.color;
    ctx.beginPath();
    ctx.arc(spark.x, spark.y, spark.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
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
  if (!ensurePlayerReady()) return;
  if (ended) resetGame();
  running = true;
});

resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", () => services.loadLeaderboard());

window.addEventListener("keydown", (event) => {
  const lowerKey = event.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", " "].includes(lowerKey)) {
    event.preventDefault();
  } else {
    return;
  }
  if (!ensurePlayerReady()) return;
  if (lowerKey === "arrowup" || lowerKey === "w") attemptMove(0, -1);
  if (lowerKey === "arrowdown" || lowerKey === "s") attemptMove(0, 1);
  if (lowerKey === "arrowleft" || lowerKey === "a") attemptMove(-1, 0);
  if (lowerKey === "arrowright" || lowerKey === "d") attemptMove(1, 0);
  if (!ended) running = true;
});

canvas.addEventListener("pointerdown", handlePointer);
window.addEventListener("resize", () => {
  pointerRect = null;
});

document.addEventListener("visibilitychange", () => {
  lastTime = performance.now();
  if (!document.hidden) draw();
});

resetGame();
services.renderLeaderboard();
services.loadLeaderboard();
requestAnimationFrame(loop);
