import { createGameServices, rand } from "/game-common.js";

const gameId = "mines";
const board = document.querySelector("#minesBoard");
const scoreValue = document.querySelector("#scoreValue");
const breadValue = document.querySelector("#breadValue");
const safeValue = document.querySelector("#safeValue");
const boonStatus = document.querySelector("#boonStatus");
const playerName = document.querySelector("#playerName");
const cashOutButton = document.querySelector("#cashOut");
const resetButton = document.querySelector("#resetGame");
const refreshLeaderboard = document.querySelector("#refreshLeaderboard");

const services = createGameServices(gameId, {
  leaderboardList: document.querySelector("#leaderboardList"),
  leaderboardStatus: document.querySelector("#leaderboardStatus"),
  claimCard: document.querySelector("#claimCard"),
  playerName,
  emptyText: "No boards saved yet"
});

const tileCount = 16;
const mineCount = 3;
let tiles = [];
let ended = false;
let scoreSaved = false;
let score = 0;
let bread = 0;
let safe = 0;
let safeStreak = 0;
let boon = null;

function updateStats() {
  scoreValue.textContent = String(score);
  breadValue.textContent = String(bread);
  safeValue.textContent = String(safe);
}

function updateBoonStatus() {
  if (!boon) {
    boonStatus.textContent = "Boon: None";
    return;
  }
  if (boon.type === "ward") {
    boonStatus.textContent = "Boon: Ward (blocks the next mine)";
  } else if (boon.type === "scout") {
    boonStatus.textContent = "Boon: Scout (reveals a safe tile)";
  } else {
    boonStatus.textContent = "Boon: Multiplier (next safe tile is doubled)";
  }
}

function setBoon(nextBoon) {
  boon = nextBoon;
  updateBoonStatus();
  if (boon?.type === "scout") {
    const hiddenSafeTiles = tiles
      .map((tile, index) => ({ tile, index }))
      .filter(({ tile }) => !tile.mine && !tile.revealed);
    if (hiddenSafeTiles.length) {
      const pick = hiddenSafeTiles[Math.floor(Math.random() * hiddenSafeTiles.length)];
      queueMicrotask(() => {
        const button = board.children[pick.index];
        if (button) {
          revealSafeTile(pick.index, button, true);
        }
      });
    } else {
      boon = null;
      updateBoonStatus();
    }
  }
}

function maybeGrantBoon() {
  if (boon || safeStreak === 0 || safeStreak % 3 !== 0) return;
  const types = ["ward", "scout", "multiplier"];
  setBoon({ type: types[Math.floor(Math.random() * types.length)] });
}

function revealAll() {
  [...board.children].forEach((button, index) => {
    button.disabled = true;
    button.classList.add(tiles[index].mine ? "is-mine" : "is-safe");
    button.textContent = tiles[index].mine ? "X" : String(tiles[index].bread);
  });
}

function finish(message, keepBread) {
  if (ended) return;
  ended = true;
  if (!keepBread) bread = 0;
  revealAll();
  services.setClaimCard(message);
  updateStats();
  if (keepBread) {
    services.createClaimCode({ score, bread });
    if (!scoreSaved) {
      scoreSaved = true;
      services.submitScore({ score, bread });
    }
  }
}

function revealSafeTile(index, button, fromScout = false) {
  if (ended || tiles[index].revealed) return;
  tiles[index].revealed = true;
  button.disabled = true;

  let found = tiles[index].bread;
  let scoreGain = found * 12 + (safe + 1) * 5;
  if (boon?.type === "multiplier") {
    found *= 2;
    scoreGain *= 2;
    boon = null;
  } else if (boon?.type === "scout" && fromScout) {
    boon = null;
  }

  bread += found;
  safe += 1;
  safeStreak += 1;
  score += scoreGain;
  button.classList.add("is-safe");
  button.textContent = String(found);
  updateStats();
  updateBoonStatus();
  maybeGrantBoon();

  if (safe >= tileCount - mineCount) {
    finish("Perfect board. Claim code incoming.", true);
  }
}

function handleMine(index, button) {
  if (boon?.type === "ward") {
    boon = null;
    tiles[index].revealed = true;
    button.disabled = true;
    button.classList.add("is-safe");
    button.textContent = "Ward";
    safeStreak = 0;
    updateBoonStatus();
    return;
  }

  button.classList.add("is-mine");
  button.textContent = "X";
  score = Math.max(score - 25, 0);
  safeStreak = 0;
  finish("A cursed mine ate the run. No bread can be claimed.", false);
}

function handleTile(index, button) {
  if (ended || tiles[index].revealed) return;
  if (tiles[index].mine) {
    handleMine(index, button);
    return;
  }
  revealSafeTile(index, button);
}

function resetGame() {
  ended = false;
  scoreSaved = false;
  score = 0;
  bread = 0;
  safe = 0;
  safeStreak = 0;
  boon = null;

  const mines = new Set();
  while (mines.size < mineCount) {
    mines.add(Math.floor(Math.random() * tileCount));
  }
  tiles = Array.from({ length: tileCount }, (_, index) => ({
    mine: mines.has(index),
    bread: 1 + Math.floor(rand(0, 3)),
    revealed: false
  }));

  board.innerHTML = "";
  tiles.forEach((_tile, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mine-tile";
    button.textContent = "?";
    button.addEventListener("click", () => handleTile(index, button));
    board.appendChild(button);
  });

  services.resetClaimState("Find bread and cash out to get a claim code.");
  updateStats();
  updateBoonStatus();
}

cashOutButton.addEventListener("click", () => {
  if (bread > 0) {
    finish("Cash out locked. Claim code incoming.", true);
  } else {
    services.setClaimCard("Find at least 1 bread before cashing out.");
  }
});
resetButton.addEventListener("click", resetGame);
refreshLeaderboard.addEventListener("click", () => services.loadLeaderboard());

resetGame();
services.renderLeaderboard();
services.loadLeaderboard();
