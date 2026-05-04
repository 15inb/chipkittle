const PANEL_BASE = "https://panel.chipkittle.com";

const account = document.querySelector("#casinoAccount");
const slotsForm = document.querySelector("#slotsForm");
const slotsStatus = document.querySelector("#slotsStatus");
const slotsNet = document.querySelector("#slotsNet");
const slotEls = ["#slotA", "#slotB", "#slotC"].map((selector) => document.querySelector(selector));
const crashForm = document.querySelector("#crashForm");
const crashStatus = document.querySelector("#crashStatus");
const crashReadout = document.querySelector("#crashReadout");
const crashBadge = document.querySelector("#crashBadge");
const crashCanvas = document.querySelector("#crashCanvas");
const blackjackForm = document.querySelector("#blackjackForm");
const blackjackStatus = document.querySelector("#blackjackStatus");
const dealerCards = document.querySelector("#dealerCards");
const playerCards = document.querySelector("#playerCards");
const dealerValue = document.querySelector("#dealerValue");
const playerValue = document.querySelector("#playerValue");
const blackjackValue = document.querySelector("#blackjackValue");
const hitButton = document.querySelector("#hitButton");
const standButton = document.querySelector("#standButton");
const doubleButton = document.querySelector("#doubleButton");

let state = { balance: 0, maxBet: 10000, user: null };
let blackjackSessionId = "";
let currentBlackjackHand = null;
let busy = false;

function fmt(value) {
  return Math.floor(Number(value) || 0).toLocaleString();
}

function setAccount(payload = state) {
  state = { ...state, ...payload };
  if (!state.user) {
    account.innerHTML = `
      <span>Log in with Discord to gamble bread from your wallet.</span>
      <a class="button primary" href="${PANEL_BASE}/profile/login">Log in</a>
    `;
    return;
  }
  account.innerHTML = `
    <img src="${state.user.avatarUrl || "/ckmascot.png"}" alt="">
    <span><b>${state.user.displayName || "Chipkittle member"}</b><small>${fmt(state.balance)} bread available · max bet ${fmt(state.maxBet)}</small></span>
  `;
}

async function api(path, body = null) {
  const response = await fetch(`${PANEL_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    credentials: "include",
    cache: "no-store",
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The bread table did not answer.");
  return payload;
}

async function loadState() {
  try {
    const payload = await api("/api/public/casino/state");
    setAccount(payload);
  } catch (error) {
    account.innerHTML = `
      <span>${error.message || "Log in with Discord to gamble website bread."}</span>
      <a class="button primary" href="${PANEL_BASE}/profile/login">Log in</a>
    `;
  }
}

function formBet(form) {
  return String(new FormData(form).get("bet") || "0");
}

function syncBlackjackButtons() {
  hitButton.disabled = busy || currentBlackjackHand?.status !== "playing";
  standButton.disabled = busy || currentBlackjackHand?.status !== "playing";
  doubleButton.disabled = busy || !currentBlackjackHand?.canDouble;
}

function setButtons(disabled) {
  document.querySelectorAll(".casino-controls button").forEach((button) => {
    if (button.matches("[data-theme-toggle]")) return;
    button.disabled = disabled;
  });
  busy = disabled;
  syncBlackjackButtons();
}

function animateSlots(reels) {
  const icons = ["🍞", "🌰", "🍃", "✦", "♈", "♛"];
  slotEls.forEach((el, index) => {
    el.classList.add("spinning");
    let ticks = 0;
    const timer = setInterval(() => {
      el.textContent = icons[Math.floor(Math.random() * icons.length)];
      ticks += 1;
      if (ticks > 8 + index * 5) {
        clearInterval(timer);
        el.textContent = reels[index]?.icon || icons[index];
        el.classList.remove("spinning");
        el.classList.add("pop");
        setTimeout(() => el.classList.remove("pop"), 280);
      }
    }, 70);
  });
}

slotsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  setButtons(true);
  slotsStatus.textContent = "The reels are chewing...";
  try {
    const payload = await api("/api/public/casino/play", {
      game: "slots",
      bet: formBet(slotsForm)
    });
    animateSlots(payload.result.reels || []);
    setTimeout(() => {
      slotsNet.textContent = `${payload.net >= 0 ? "+" : ""}${fmt(payload.net)}`;
      slotsNet.className = payload.net >= 0 ? "win" : "loss";
      slotsStatus.textContent = `${payload.result.label}. Payout ${fmt(payload.payout)} bread. Balance ${fmt(payload.balance)}.`;
      setAccount({ balance: payload.balance });
    }, 1100);
  } catch (error) {
    slotsStatus.textContent = error.message || "Slots failed.";
  } finally {
    setTimeout(() => {
      busy = false;
      setButtons(false);
    }, 1200);
  }
});

function drawCrash(progress, point, target, done = false) {
  const ctx = crashCanvas.getContext("2d");
  const width = crashCanvas.width;
  const height = crashCanvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(3, 12, 8, 0.76)";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(172, 255, 124, 0.12)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 76) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.strokeStyle = done && point < target ? "#ff5f5f" : "#9dff6b";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(28, height - 34);
  const steps = 42;
  for (let i = 0; i <= steps * progress; i += 1) {
    const t = i / steps;
    const x = 28 + t * (width - 70);
    const y = height - 34 - Math.pow(t, 1.72) * (height - 72);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#f8e8a0";
  ctx.font = "700 26px system-ui";
  ctx.fillText(`${point.toFixed(2)}x`, width - 130, 46);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "600 18px system-ui";
  ctx.fillText(`target ${target.toFixed(2)}x`, 28, 44);
}

crashForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  setButtons(true);
  crashStatus.textContent = "Launching bread graph...";
  crashBadge.textContent = "climbing";
  try {
    const target = Number(new FormData(crashForm).get("target") || 2);
    const payload = await api("/api/public/casino/play", {
      game: "crash",
      bet: formBet(crashForm),
      targetMultiplier: target
    });
    const point = Number(payload.result.crashPoint || 1);
    const targetMultiplier = Number(payload.result.targetMultiplier || target);
    const duration = 1400;
    const start = performance.now();
    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const shown = 1 + (point - 1) * progress;
      crashReadout.textContent = `${shown.toFixed(2)}x`;
      drawCrash(progress, shown, targetMultiplier, false);
      if (progress < 1) requestAnimationFrame(step);
      else {
        drawCrash(1, point, targetMultiplier, true);
        crashReadout.textContent = `${point.toFixed(2)}x`;
        crashBadge.textContent = payload.net >= 0 ? "cashed" : "crashed";
        crashStatus.textContent = `${payload.result.label} Net ${payload.net >= 0 ? "+" : ""}${fmt(payload.net)} bread. Balance ${fmt(payload.balance)}.`;
        setAccount({ balance: payload.balance });
      }
    }
    requestAnimationFrame(step);
  } catch (error) {
    crashStatus.textContent = error.message || "Crash failed.";
    crashBadge.textContent = "jammed";
  } finally {
    setTimeout(() => {
      busy = false;
      setButtons(false);
    }, 1550);
  }
});

function cardHtml(card, hidden = false) {
  if (hidden || !card) return `<span class="playing-card hidden-card">?</span>`;
  const red = card.suit === "♥" || card.suit === "♦";
  return `<span class="playing-card ${red ? "red-card" : ""}"><b>${card.rank}</b><small>${card.suit}</small></span>`;
}

function renderBlackjack(hand) {
  currentBlackjackHand = hand || null;
  blackjackSessionId = hand.sessionId || "";
  dealerCards.innerHTML = (hand.dealer || []).map((card) => cardHtml(card)).join("");
  playerCards.innerHTML = (hand.player || []).map((card) => cardHtml(card)).join("");
  dealerValue.textContent = hand.dealerValue ?? 0;
  playerValue.textContent = hand.playerValue ?? 0;
  blackjackValue.textContent = hand.status === "playing" ? `${hand.playerValue}` : `${hand.payout ? "+" : ""}${fmt(hand.payout - hand.bet)}`;
  blackjackStatus.textContent = hand.result || `Bet ${fmt(hand.bet)} bread. Choose hit, stand, or double.`;
  syncBlackjackButtons();
  if (hand.status === "finished") {
    setAccount({ balance: hand.balance });
  }
}

blackjackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/public/casino/blackjack/start", { bet: formBet(blackjackForm) });
    renderBlackjack(payload.blackjack);
    if (payload.blackjack?.status === "playing") {
      setAccount({ balance: payload.blackjack.balance });
    }
  } catch (error) {
    blackjackStatus.textContent = error.message || "Blackjack failed.";
  }
});

async function blackjackAction(action) {
  if (!blackjackSessionId) return;
  try {
    const payload = await api("/api/public/casino/blackjack/action", { sessionId: blackjackSessionId, action });
    renderBlackjack(payload.blackjack);
  } catch (error) {
    blackjackStatus.textContent = error.message || "Blackjack action failed.";
  }
}

hitButton.addEventListener("click", () => blackjackAction("hit"));
standButton.addEventListener("click", () => blackjackAction("stand"));
doubleButton.addEventListener("click", () => blackjackAction("double"));

drawCrash(0, 1, 2);
renderBlackjack({ status: "idle", player: [], dealer: [], playerValue: 0, dealerValue: 0, bet: 0, payout: 0, balance: 0 });
loadState();
