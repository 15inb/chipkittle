const PANEL_BASE = "https://panel.chipkittle.com";
const STORAGE_KEY = "chipkittleCasinoPrefs";
const ICONS = {
  loaf: "\u{1F35E}",
  nut: "\u{1F330}",
  leaf: "\u{1F343}",
  spark: "\u2726",
  horn: "\u2648",
  crown: "\u265B"
};
const SPIN_ICONS = Object.values(ICONS);

const account = document.querySelector("#casinoAccount");
const clientSeedInput = document.querySelector("#clientSeed");
const soundToggle = document.querySelector("#soundToggle");
const dailyRewardButton = document.querySelector("#dailyRewardButton");
const repeatBetButton = document.querySelector("#repeatBetButton");
const proofText = document.querySelector("#proofText");
const toast = document.querySelector("#casinoToast");
const recentRounds = document.querySelector("#recentRounds");
const leaderboardEl = document.querySelector("#casinoLeaderboard");
const achievementsEl = document.querySelector("#casinoAchievements");
const slotsForm = document.querySelector("#slotsForm");
const slotsStatus = document.querySelector("#slotsStatus");
const slotsNet = document.querySelector("#slotsNet");
const slotPayline = document.querySelector("#slotPayline");
const slotEls = ["#slotA", "#slotB", "#slotC"].map((selector) => document.querySelector(selector));
const crashForm = document.querySelector("#crashForm");
const crashStatus = document.querySelector("#crashStatus");
const crashReadout = document.querySelector("#crashReadout");
const crashBadge = document.querySelector("#crashBadge");
const crashCanvas = document.querySelector("#crashCanvas");
const crashMarkers = document.querySelector("#crashMarkers");
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
const splitButton = document.querySelector("#splitButton");
const insuranceButton = document.querySelector("#insuranceButton");

let prefs = loadPrefs();
let state = { balance: 0, wallet: 0, bank: 0, maxBet: 10000, user: null, recentRounds: [], leaderboard: [], achievements: [] };
let blackjackSessionId = "";
let currentBlackjackHand = null;
let busy = false;
let audioContext = null;

clientSeedInput.value = prefs.clientSeed || "chipkittle";
soundToggle.textContent = prefs.sound ? "Sound on" : "Sound off";

function loadPrefs() {
  try {
    return {
      sound: true,
      clientSeed: "chipkittle",
      bets: { slotsForm: "100", crashForm: "100", blackjackForm: "100" },
      target: "2.00",
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
    };
  } catch {
    return { sound: true, clientSeed: "chipkittle", bets: { slotsForm: "100", crashForm: "100", blackjackForm: "100" }, target: "2.00" };
  }
}

function savePrefs() {
  prefs.clientSeed = clientSeedInput.value.trim() || "chipkittle";
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function fmt(value) {
  return Math.floor(Number(value) || 0).toLocaleString();
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function tone(type = "click") {
  if (!prefs.sound) return;
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  if (!AudioEngine) return;
  audioContext ||= new AudioEngine();
  const now = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const map = {
    click: [260, 0.035, 0.035],
    spin: [420, 0.045, 0.045],
    win: [660, 0.18, 0.06],
    loss: [120, 0.14, 0.05],
    card: [330, 0.05, 0.04],
    reward: [780, 0.22, 0.07]
  };
  const [frequency, duration, volume] = map[type] || map.click;
  osc.frequency.setValueAtTime(frequency, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(80, frequency * 1.45), now + duration);
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain).connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function showToast(message, type = "neutral") {
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

function pulseBalance(nextBalance) {
  const previous = Number(state.balance) || 0;
  const delta = Number(nextBalance) - previous;
  setAccount({ balance: nextBalance });
  if (delta !== 0) showToast(`${delta > 0 ? "+" : ""}${fmt(delta)} bread`, delta > 0 ? "win" : "loss");
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
  const accountDetail = `${fmt(state.balance)} available | wallet ${fmt(state.wallet || 0)} | bank ${fmt(state.bank || 0)} | max bet ${fmt(state.maxBet)}`;
  account.innerHTML = `
    <img src="${state.user.avatarUrl || "/ckmascot.png"}" alt="">
    <span><b>${escapeHtml(state.user.displayName || "Chipkittle member")}</b><small>${accountDetail}</small></span>
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

function updateSidePanels(payload = {}) {
  if (Array.isArray(payload.recentRounds)) {
    state.recentRounds = payload.recentRounds;
  }
  if (Array.isArray(payload.leaderboard)) {
    state.leaderboard = payload.leaderboard;
  }
  if (Array.isArray(payload.achievements)) {
    const merged = new Map((state.achievements || []).map((item) => [item.id, item]));
    payload.achievements.forEach((item) => merged.set(item.id, item));
    state.achievements = [...merged.values()];
  }

  recentRounds.innerHTML = (state.recentRounds || []).length
    ? state.recentRounds.map((round) => `
      <article class="casino-feed-item ${Number(round.net) >= 0 ? "win" : "loss"}">
        <strong>${escapeHtml(round.displayName || "Someone")} ${Number(round.net) >= 0 ? "won" : "lost"} ${fmt(Math.abs(round.net))}</strong>
        <span>${escapeHtml(round.game || "casino")} | bet ${fmt(round.bet)} | paid ${fmt(round.payout)}</span>
        <small>${escapeHtml(round.label || "")}</small>
      </article>
    `).join("")
    : `<p class="casino-empty">No rounds yet. The bread is watching.</p>`;

  leaderboardEl.innerHTML = (state.leaderboard || []).length
    ? state.leaderboard.map((entry) => `
      <article class="casino-feed-item">
        <strong>#${entry.rank} ${escapeHtml(entry.displayName || entry.userId || "Member")}</strong>
        <span>Net ${entry.net >= 0 ? "+" : ""}${fmt(entry.net)} | wagered ${fmt(entry.wagered)}</span>
      </article>
    `).join("")
    : `<p class="casino-empty">Win bread to appear here.</p>`;

  achievementsEl.innerHTML = (state.achievements || []).length
    ? state.achievements.map((achievement) => `
      <article class="achievement-card unlocked">
        <strong>${escapeHtml(achievement.name)}</strong>
        <span>${escapeHtml(achievement.description)}</span>
      </article>
    `).join("")
    : `<p class="casino-empty">Achievements unlock while playing.</p>`;
}

function updateProof(proof = null) {
  if (!proof) return;
  const server = proof.serverSeed ? `server ${proof.serverSeed.slice(0, 10)}...` : `hash ${proof.serverSeedHash?.slice(0, 12) || "pending"}...`;
  proofText.textContent = `Fairness proof: ${server} | client ${proof.clientSeed || "chipkittle"} | nonce ${proof.nonce}`;
}

async function loadState() {
  try {
    const payload = await api("/api/public/casino/state");
    setAccount(payload);
    updateSidePanels(payload);
    dailyRewardButton.disabled = !payload.dailyReward?.available;
    dailyRewardButton.textContent = payload.dailyReward?.available ? "Claim daily crumbs" : "Daily claimed";
  } catch (error) {
    account.innerHTML = `
      <span>${escapeHtml(error.message || "Log in with Discord to gamble website bread.")}</span>
      <a class="button primary" href="${PANEL_BASE}/profile/login">Log in</a>
    `;
  }
}

function formBet(form) {
  const value = String(new FormData(form).get("bet") || "0");
  prefs.bets[form.id] = value;
  if (form.id === "crashForm") prefs.target = String(new FormData(form).get("target") || "2.00");
  savePrefs();
  return value;
}

function betPayload(form) {
  return {
    bet: formBet(form),
    clientSeed: clientSeedInput.value.trim() || "chipkittle"
  };
}

function syncBlackjackButtons() {
  const playing = currentBlackjackHand?.status === "playing";
  hitButton.disabled = busy || !playing;
  standButton.disabled = busy || !playing;
  doubleButton.disabled = busy || !currentBlackjackHand?.canDouble;
  splitButton.disabled = busy || !currentBlackjackHand?.canSplit;
  insuranceButton.disabled = busy || !currentBlackjackHand?.canInsurance;
}

function setButtons(disabled) {
  busy = disabled;
  document.querySelectorAll(".casino-controls button, .casino-chip-row button").forEach((button) => {
    button.disabled = disabled;
  });
  repeatBetButton.disabled = disabled;
  syncBlackjackButtons();
}

function applyNet(el, net) {
  el.textContent = `${net >= 0 ? "+" : ""}${fmt(net)}`;
  el.className = net >= 0 ? "win bump" : "loss bump";
  setTimeout(() => el.classList.remove("bump"), 460);
}

function animateSlots(reels = [], payline = [], bonus = null) {
  slotPayline.className = "slot-payline";
  slotEls.forEach((el, index) => {
    el.className = "slot-reel spinning";
    let ticks = 0;
    const limit = 16 + index * 10;
    const timer = setInterval(() => {
      const easing = ticks / limit;
      el.textContent = SPIN_ICONS[Math.floor(Math.random() * SPIN_ICONS.length)];
      el.style.transform = `translateY(${Math.sin(easing * Math.PI * 8) * 4}px) rotate(${ticks * 8}deg)`;
      ticks += 1;
      tone("spin");
      if (ticks > limit) {
        clearInterval(timer);
        const reel = reels[index] || {};
        el.textContent = reel.icon || ICONS[reel.id] || SPIN_ICONS[index];
        el.dataset.tier = reel.tier || "common";
        el.style.transform = "";
        el.className = `slot-reel ${payline.includes(index) ? "paying" : ""} pop`;
        setTimeout(() => el.classList.remove("pop"), 360);
      }
    }, 42 + index * 8);
  });
  setTimeout(() => {
    if (payline.length) slotPayline.className = `slot-payline show line-${payline.join("-")}`;
    if (bonus) showToast(`${bonus.name}: +${bonus.multiplier}x`, "win");
  }, 1260);
}

slotsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setButtons(true);
  tone("click");
  slotsStatus.textContent = "The reels are accelerating...";
  try {
    const payload = await api("/api/public/casino/play", {
      game: "slots",
      ...betPayload(slotsForm)
    });
    animateSlots(payload.result.reels || [], payload.result.payline || [], payload.result.bonus);
      setTimeout(() => {
        applyNet(slotsNet, payload.net);
        slotsStatus.textContent = `${payload.result.label}. Payout ${fmt(payload.payout)} bread.`;
        pulseBalance(payload.balance);
        setAccount({ wallet: payload.wallet, bank: payload.bank });
      updateProof(payload.proof);
      updateSidePanels(payload);
        if (payload.net > 0) tone("win");
        else tone("loss");
        if (slotsForm.elements.auto?.checked && payload.balance > 0) {
          slotsStatus.textContent += " Auto-spin queued.";
          setTimeout(() => slotsForm.requestSubmit(), 900);
        }
      }, 1500);
  } catch (error) {
    slotsStatus.textContent = error.message || "Slots failed.";
    tone("loss");
  } finally {
    setTimeout(() => setButtons(false), 1650);
  }
});

function drawCrash(progress, shown, target, done = false, won = false) {
  const ctx = crashCanvas.getContext("2d");
  const width = crashCanvas.width;
  const height = crashCanvas.height;
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(11, 29, 18, 0.96)");
  gradient.addColorStop(1, "rgba(2, 8, 5, 0.98)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(246, 200, 93, 0.1)";
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
  ctx.shadowColor = done && !won ? "#ff6b6b" : "#9dff6b";
  ctx.shadowBlur = 18;
  ctx.strokeStyle = done && !won ? "#ff6b6b" : "#9dff6b";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(28, height - 34);
  const steps = 90;
  for (let i = 0; i <= steps * progress; i += 1) {
    const t = i / steps;
    const x = 28 + t * (width - 70);
    const y = height - 34 - Math.pow(t, 1.86) * (height - 78);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  const targetX = Math.min(28 + ((target - 1) / Math.max(shown - 1, target - 1, 0.1)) * (width - 70), width - 38);
  ctx.strokeStyle = "rgba(246, 200, 93, 0.7)";
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(targetX, 24);
  ctx.lineTo(targetX, height - 24);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#f8e8a0";
  ctx.font = "800 28px system-ui";
  ctx.fillText(`${shown.toFixed(2)}x`, width - 138, 48);
  ctx.fillStyle = "rgba(255,255,255,0.76)";
  ctx.font = "700 16px system-ui";
  ctx.fillText(`auto ${target.toFixed(2)}x`, 28, 44);
}

function renderCrashMarkers(rounds = []) {
  const crashRounds = rounds.filter((round) => round.game === "crash").slice(0, 5);
  crashMarkers.innerHTML = crashRounds.map((round) => `
    <span class="${Number(round.net) >= 0 ? "win" : "loss"}">${Number(round.multiplier || 0).toFixed(2)}x</span>
  `).join("");
}

crashForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setButtons(true);
  tone("click");
  crashStatus.textContent = "Curve engaged. Hold your crumbs.";
  crashBadge.textContent = "climbing";
  try {
    const target = Number(new FormData(crashForm).get("target") || 2);
    const payload = await api("/api/public/casino/play", {
      game: "crash",
      targetMultiplier: target,
      ...betPayload(crashForm)
    });
    const point = Number(payload.result.crashPoint || 1);
    const targetMultiplier = Number(payload.result.targetMultiplier || target);
    const duration = Math.min(3100, 1050 + Math.log2(Math.max(point, 1)) * 520);
    const start = performance.now();
    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 2.45);
      const shown = 1 + (point - 1) * eased;
      crashReadout.textContent = `${shown.toFixed(2)}x`;
      drawCrash(progress, shown, targetMultiplier, false, payload.net >= 0);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        drawCrash(1, point, targetMultiplier, true, payload.net >= 0);
        crashReadout.textContent = `${point.toFixed(2)}x`;
        crashBadge.textContent = payload.net >= 0 ? "cashed" : "crashed";
        crashStatus.textContent = `${payload.result.label} Net ${payload.net >= 0 ? "+" : ""}${fmt(payload.net)} bread.`;
        pulseBalance(payload.balance);
        setAccount({ wallet: payload.wallet, bank: payload.bank });
        updateProof(payload.proof);
        updateSidePanels(payload);
        renderCrashMarkers(payload.recentRounds || []);
        tone(payload.net >= 0 ? "win" : "loss");
      }
    }
    requestAnimationFrame(step);
  } catch (error) {
    crashStatus.textContent = error.message || "Crash failed.";
    crashBadge.textContent = "jammed";
    tone("loss");
  } finally {
    setTimeout(() => setButtons(false), 3250);
  }
});

function cardHtml(card, hidden = false, index = 0) {
  if (hidden || !card) return `<span class="playing-card hidden-card" style="--delay:${index * 70}ms">?</span>`;
  const red = card.suit === "\u2665" || card.suit === "\u2666";
  return `<span class="playing-card ${red ? "red-card" : ""}" style="--delay:${index * 70}ms"><b>${escapeHtml(card.rank)}</b><small>${card.suit}</small></span>`;
}

function renderBlackjack(hand = {}) {
  currentBlackjackHand = hand || null;
  blackjackSessionId = hand.sessionId || "";
  dealerCards.innerHTML = (hand.dealer || []).map((card, index) => cardHtml(card, false, index)).join("");
  if (Array.isArray(hand.splitHands) && hand.splitHands.length) {
    playerCards.innerHTML = hand.splitHands.map((splitHand, handIndex) => `
      <div class="split-card-stack">
        <small>Hand ${handIndex + 1}</small>
        <div>${splitHand.map((card, index) => cardHtml(card, false, index)).join("")}</div>
      </div>
    `).join("");
  } else {
    playerCards.innerHTML = (hand.player || []).map((card, index) => cardHtml(card, false, index)).join("");
  }
  dealerValue.textContent = hand.dealerValue ?? 0;
  playerValue.textContent = hand.playerValue ?? 0;
  blackjackValue.textContent = hand.status === "playing" ? `${hand.playerValue}` : `${hand.payout ? "+" : ""}${fmt((hand.payout || 0) - (hand.bet || 0))}`;
  blackjackStatus.textContent = hand.result || `Bet ${fmt(hand.bet)} bread. Choose hit, stand, double, split, or insurance when available.`;
  syncBlackjackButtons();
  tone("card");
  if (hand.status === "finished") {
    pulseBalance(hand.balance);
    setAccount({ wallet: hand.wallet, bank: hand.bank });
  }
}

blackjackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setButtons(true);
  try {
    const payload = await api("/api/public/casino/blackjack/start", betPayload(blackjackForm));
    renderBlackjack(payload.blackjack);
    updateProof(payload.proof);
    updateSidePanels(payload);
    if (payload.blackjack?.status === "playing") {
      setAccount({ balance: payload.blackjack.balance, wallet: payload.blackjack.wallet, bank: payload.blackjack.bank });
    }
  } catch (error) {
    blackjackStatus.textContent = error.message || "Blackjack failed.";
    tone("loss");
  } finally {
    setTimeout(() => setButtons(false), 360);
  }
});

async function blackjackAction(action) {
  if (!blackjackSessionId || busy) return;
  setButtons(true);
  tone("click");
  try {
    const payload = await api("/api/public/casino/blackjack/action", { sessionId: blackjackSessionId, action });
    renderBlackjack(payload.blackjack);
    updateProof(payload.proof);
    updateSidePanels(payload);
    if (payload.blackjack?.status === "finished") tone(payload.blackjack.payout >= payload.blackjack.bet ? "win" : "loss");
  } catch (error) {
    blackjackStatus.textContent = error.message || "Blackjack action failed.";
    tone("loss");
  } finally {
    setTimeout(() => setButtons(false), 360);
  }
}

document.querySelectorAll(".casino-chip-row").forEach((row) => {
  row.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-chip]");
    if (!button) return;
    const form = document.querySelector(`#${row.dataset.target}`);
    const input = form?.querySelector("input[name='bet']");
    if (!input) return;
    input.value = button.dataset.chip;
    prefs.bets[form.id] = input.value;
    savePrefs();
    tone("click");
  });
});

dailyRewardButton.addEventListener("click", async () => {
  if (dailyRewardButton.disabled) return;
  try {
    const payload = await api("/api/public/casino/daily", {});
    setAccount(payload);
    updateSidePanels({ achievements: [payload.achievement] });
    dailyRewardButton.disabled = true;
    dailyRewardButton.textContent = "Daily claimed";
    showToast(`Daily crumbs claimed: +${fmt(payload.amount)}`, "win");
    tone("reward");
  } catch (error) {
    showToast(error.message || "Daily reward failed.", "loss");
  }
});

repeatBetButton.addEventListener("click", () => {
  slotsForm.querySelector("input[name='bet']").value = prefs.bets.slotsForm || "100";
  crashForm.querySelector("input[name='bet']").value = prefs.bets.crashForm || "100";
  crashForm.querySelector("input[name='target']").value = prefs.target || "2.00";
  blackjackForm.querySelector("input[name='bet']").value = prefs.bets.blackjackForm || "100";
  showToast("Last bets restored.", "neutral");
  tone("click");
});

soundToggle.addEventListener("click", () => {
  prefs.sound = !prefs.sound;
  savePrefs();
  soundToggle.textContent = prefs.sound ? "Sound on" : "Sound off";
  tone("click");
});

clientSeedInput.addEventListener("change", savePrefs);
hitButton.addEventListener("click", () => blackjackAction("hit"));
standButton.addEventListener("click", () => blackjackAction("stand"));
doubleButton.addEventListener("click", () => blackjackAction("double"));
splitButton.addEventListener("click", () => blackjackAction("split"));
insuranceButton.addEventListener("click", () => blackjackAction("insurance"));

slotsForm.querySelector("input[name='bet']").value = prefs.bets.slotsForm || "100";
crashForm.querySelector("input[name='bet']").value = prefs.bets.crashForm || "100";
crashForm.querySelector("input[name='target']").value = prefs.target || "2.00";
blackjackForm.querySelector("input[name='bet']").value = prefs.bets.blackjackForm || "100";
drawCrash(0, 1, 2);
renderBlackjack({ status: "idle", player: [], dealer: [], playerValue: 0, dealerValue: 0, bet: 0, payout: 0, balance: 0 });
updateSidePanels();
loadState();
