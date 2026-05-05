const PANEL_BASE = "https://panel.chipkittle.com";
const STORAGE_KEY = "chipkittleCasinoPrefs";
const ICONS = {
  loaf: "\u{1F35E}",
  nut: "\u{1F330}",
  leaf: "\u{1F343}",
  spark: "\u2726",
  horn: "\u2648",
  crown: "\u265B",
  blank: "\u25CB"
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
const slotsPaytableButton = document.querySelector("#slotsPaytableButton");
const slotsPaytableModal = document.querySelector("#slotsPaytableModal");
const crashPanels = [...document.querySelectorAll(".crash-bet-panel")];
const crashStatus = document.querySelector("#crashStatus");
const crashReadout = document.querySelector("#crashReadout");
const crashBadge = document.querySelector("#crashBadge");
const crashCanvas = document.querySelector("#crashCanvas");
const crashMarkers = document.querySelector("#crashMarkers");
const crashLiveFeed = document.querySelector("#crashLiveFeed");
const crashCountdown = document.querySelector("#crashCountdown");
const crashCenterReadout = document.querySelector("#crashCenterReadout");
const crashOverlay = document.querySelector("#crashOverlay");
const crashVerifyButton = document.querySelector("#crashVerifyButton");
const crashProofModal = document.querySelector("#crashProofModal");
const crashProofData = document.querySelector("#crashProofData");
const copyProofButton = document.querySelector("#copyProofButton");
const sessionStats = document.querySelector("#sessionStats");
const transactionHistory = document.querySelector("#transactionHistory");
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
let crashRound = null;
let crashFrame = 0;
let crashPollTimer = 0;
let crashServerOffset = 0;
let crashFeedTimer = 0;
let lastCrashProof = null;
let sessionTotals = { wagered: 0, won: 0, biggestWin: 0, bestCrash: 0 };
let transactionLog = [];
let busy = false;
let audioContext = null;
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;

clientSeedInput.value = prefs.clientSeed || "chipkittle";
soundToggle.textContent = prefs.sound ? "Sound on" : "Sound off";

function loadPrefs() {
  try {
    return {
      sound: true,
      clientSeed: "chipkittle",
      bets: { slotsForm: "100", crashForm: "100", blackjackForm: "100" },
      crashPanels: { A: { bet: "100", target: "2.00" }, B: { bet: "100", target: "3.00" } },
      target: "2.00",
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
    };
  } catch {
    return { sound: true, clientSeed: "chipkittle", bets: { slotsForm: "100", crashForm: "100", blackjackForm: "100" }, crashPanels: { A: { bet: "100", target: "2.00" }, B: { bet: "100", target: "3.00" } }, target: "2.00" };
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

function recordTransaction(game, bet, payout, net) {
  const entry = {
    game,
    bet: Math.max(Math.floor(Number(bet) || 0), 0),
    payout: Math.max(Math.floor(Number(payout) || 0), 0),
    net: Math.floor(Number(net) || 0),
    time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  };
  transactionLog.unshift(entry);
  transactionLog = transactionLog.slice(0, 20);
  sessionTotals.wagered += entry.bet;
  sessionTotals.won += entry.payout;
  sessionTotals.biggestWin = Math.max(sessionTotals.biggestWin, entry.net);
  updateSidePanels();
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
  if (payload.activeCrash) {
    adoptCrashRound(payload.activeCrash, false);
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

  sessionStats.innerHTML = `
    <article class="casino-feed-item"><strong>Total wagered</strong><span>${fmt(sessionTotals.wagered)} bread</span></article>
    <article class="casino-feed-item"><strong>Total won</strong><span>${fmt(sessionTotals.won)} bread</span></article>
    <article class="casino-feed-item ${sessionTotals.won - sessionTotals.wagered >= 0 ? "win" : "loss"}"><strong>Net</strong><span>${sessionTotals.won - sessionTotals.wagered >= 0 ? "+" : ""}${fmt(sessionTotals.won - sessionTotals.wagered)}</span></article>
    <article class="casino-feed-item"><strong>Best crash</strong><span>${sessionTotals.bestCrash.toFixed(2)}x</span></article>
  `;

  transactionHistory.innerHTML = transactionLog.length
    ? transactionLog.slice(0, 8).map((entry) => `
      <article class="casino-feed-item ${entry.net >= 0 ? "win" : "loss"}">
        <strong>${escapeHtml(entry.game)} ${entry.net >= 0 ? "+" : ""}${fmt(entry.net)}</strong>
        <span>Bet ${fmt(entry.bet)} | paid ${fmt(entry.payout)}</span>
        <small>${escapeHtml(entry.time)}</small>
      </article>
    `).join("")
    : `<p class="casino-empty">No transactions in this tab yet.</p>`;
}

function updateProof(proof = null) {
  if (!proof) return;
  const server = proof.serverSeed ? `server ${proof.serverSeed.slice(0, 10)}...` : `hash ${proof.serverSeedHash?.slice(0, 12) || "pending"}...`;
  const digest = proof.digest ? ` | digest ${proof.digest.slice(0, 14)}...` : "";
  proofText.textContent = `Fairness proof: ${server} | client ${proof.clientSeed || "chipkittle"} | nonce ${proof.nonce}${digest}`;
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
        const lineDetail = (payload.result.payline || []).length
          ? ` Payline ${payload.result.payline.map((index) => index + 1).join("-")}.`
          : "";
        slotsStatus.textContent = `${payload.result.label}. Payout ${fmt(payload.payout)} bread.${lineDetail}`;
      pulseBalance(payload.balance);
      setAccount({ wallet: payload.wallet, bank: payload.bank });
      recordTransaction("Slots", payload.bet, payload.payout, payload.net);
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

function crashMultiplierAt(elapsedMs = 0) {
  const seconds = Math.max(Number(elapsedMs) || 0, 0) / 1000;
  return Math.max(1, Math.floor((1 + Math.pow(seconds / 1.2, 1.72)) * 100) / 100);
}

function crashNow() {
  return Date.now() + crashServerOffset;
}

function panelForm(panel = "A") {
  return crashPanels.find((form) => form.dataset.panel === panel);
}

function panelValues(panel = "A") {
  const form = panelForm(panel);
  return {
    bet: String(form?.elements.bet?.value || "0"),
    target: Number(form?.elements.target?.value || 0)
  };
}

function saveCrashPanelPrefs(panel = "A") {
  prefs.crashPanels ||= {};
  prefs.crashPanels[panel] = panelValues(panel);
  savePrefs();
}

function activePanelBet(panel = "A") {
  return crashRound?.bets?.[panel] || null;
}

function queuedPanelBet(panel = "A") {
  return crashRound?.queued?.[panel] || null;
}

function setCrashPanelUi() {
  crashPanels.forEach((form) => {
    const panel = form.dataset.panel;
    const bet = activePanelBet(panel);
    const queued = queuedPanelBet(panel);
    const active = crashRound?.status === "active";
    const betting = crashRound?.status === "betting";
    const finished = crashRound?.status === "finished";
    const action = form.querySelector("[data-panel-action]");
    const cancel = form.querySelector("[data-panel-cancel]");
    const stateEl = form.querySelector("[data-panel-state]");
    const result = form.querySelector("[data-panel-result]");
    const inputs = form.querySelectorAll("input");
    const chips = form.querySelectorAll("[data-chip]");
    inputs.forEach((input) => { input.disabled = Boolean(bet && !finished); });
    chips.forEach((button) => { button.disabled = Boolean(bet && !finished); });
    cancel.disabled = !(bet && betting) && !queued;
    if (bet?.status === "cashed") {
      action.textContent = `Cashed @ ${Number(bet.cashoutMultiplier || 0).toFixed(2)}x`;
      action.disabled = true;
      stateEl.textContent = "Cashed-out bet";
      result.textContent = `Payout ${fmt(bet.payout)} | profit ${fmt(bet.payout - bet.amount)}`;
      form.dataset.state = "cashed";
    } else if (bet && active) {
      const multiplier = Number(crashRound?.multiplier || 1);
      action.textContent = `Cash Out at ${multiplier.toFixed(2)}x`;
      action.disabled = false;
      stateEl.textContent = `Current round bet: ${fmt(bet.amount)}`;
      result.textContent = `Potential ${fmt(Math.floor(bet.amount * multiplier))} | profit ${fmt(Math.floor(bet.amount * multiplier) - bet.amount)}`;
      form.dataset.state = "active";
    } else if (bet && betting) {
      action.textContent = "Bet Placed";
      action.disabled = true;
      stateEl.textContent = `Current round bet: ${fmt(bet.amount)}`;
      result.textContent = `Auto cashout ${Number(bet.autoCashout || 0).toFixed(2)}x`;
      form.dataset.state = "placed";
    } else if (queued) {
      action.textContent = "Queued Next Round";
      action.disabled = true;
      stateEl.textContent = "Queued next-round bet";
      result.textContent = `Bet ${escapeHtml(queued.amount)} | auto ${Number(queued.autoCashout || 0).toFixed(2)}x`;
      form.dataset.state = "queued";
    } else {
      action.textContent = active ? "Bet for Next Round" : "Place Bet";
      action.disabled = false;
      stateEl.textContent = active ? "Queue for next round" : "No current bet";
      result.textContent = "No bet placed.";
      form.dataset.state = "idle";
    }
  });
}

function drawCrash(progress, shown, target = 2, done = false, won = false, cashout = 0, crashPoint = 0) {
  const ctx = crashCanvas.getContext("2d");
  const width = crashCanvas.width;
  const height = crashCanvas.height;
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(11, 29, 18, 0.96)");
  gradient.addColorStop(1, "rgba(2, 8, 5, 0.98)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const maxShown = Math.max(shown, target, cashout, crashPoint, 2);
  ctx.strokeStyle = "rgba(246, 200, 93, 0.1)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const label = 1 + ((maxShown - 1) / 5) * i;
    const y = height - 34 - (i / 5) * (height - 78);
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(width - 24, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "700 12px system-ui";
    ctx.fillText(`${label.toFixed(1)}x`, 32, y - 5);
  }
  for (let i = 0; i <= 6; i += 1) {
    const x = 28 + (i / 6) * (width - 70);
    ctx.beginPath();
    ctx.moveTo(x, 20);
    ctx.lineTo(x, height - 26);
    ctx.stroke();
  }
  ctx.shadowColor = done && !won ? "#ff6b6b" : "#9dff6b";
  ctx.shadowBlur = 24;
  ctx.strokeStyle = done && !won ? "#ff6b6b" : "#9dff6b";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(28, height - 34);
  const steps = reduceMotion ? 24 : 110;
  for (let i = 0; i <= steps * progress; i += 1) {
    const t = i / steps;
    const x = 28 + t * (width - 70);
    const curveValue = 1 + (maxShown - 1) * Math.pow(t, 1.86);
    const y = height - 34 - ((curveValue - 1) / Math.max(maxShown - 1, 0.1)) * (height - 78);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  const targetX = Math.min(28 + ((target - 1) / Math.max(maxShown - 1, 0.1)) * (width - 70), width - 38);
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
  if (cashout > 0) {
    const x = Math.min(28 + ((cashout - 1) / Math.max(maxShown - 1, 0.1)) * (width - 70), width - 38);
    ctx.fillStyle = "#9dff6b";
    ctx.beginPath();
    ctx.arc(x, height - 34 - Math.pow((x - 28) / (width - 70), 1.86) * (height - 78), 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`you ${cashout.toFixed(2)}x`, Math.max(28, x - 36), height - 18);
  }
  if (crashPoint > 0) {
    const x = Math.min(28 + ((crashPoint - 1) / Math.max(maxShown - 1, 0.1)) * (width - 70), width - 38);
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 8, 22);
    ctx.lineTo(x + 8, 38);
    ctx.moveTo(x + 8, 22);
    ctx.lineTo(x - 8, 38);
    ctx.stroke();
  }
}

function renderCrashOverlay(text = "") {
  crashOverlay.textContent = text;
  crashOverlay.classList.toggle("show", Boolean(text));
}

function renderCrashMarkers(rounds = []) {
  const crashRounds = rounds.filter((round) => round.game === "crash").slice(0, 5);
  crashMarkers.innerHTML = crashRounds.map((round) => `
    <span class="${Number(round.multiplier || 0) >= 10 ? "high" : Number(round.multiplier || 0) >= 2 ? "medium" : "low"}">${Number(round.multiplier || 0).toFixed(2)}x</span>
  `).join("");
}

const crashPeople = [
  { name: "ByteFox", bet: 250, risk: 1.7 },
  { name: "MandoMilk", bet: 100, risk: 1.4 },
  { name: "Nova", bet: 500, risk: 2.8 },
  { name: "Loafgrim", bet: 50, risk: 1.25 },
  { name: "Tuski", bet: 1000, risk: 3.5 },
  { name: "CK Biscuit", bet: 300, risk: 2.1 }
];

function fakeCrashFeed(phase = "betting", multiplier = 1) {
  const player = crashPeople[Math.floor(Math.random() * crashPeople.length)];
  const text = phase === "betting"
    ? `${player.name} bet ${player.bet}`
    : phase === "lost"
      ? `${player.name} lost ${player.bet}`
      : multiplier >= player.risk
        ? `${player.name} cashed out @ ${Math.min(multiplier, player.risk + Math.random() * 0.35).toFixed(2)}x`
        : `${player.name} is holding ${player.bet}`;
  const item = document.createElement("span");
  item.textContent = text;
  crashLiveFeed.prepend(item);
  while (crashLiveFeed.children.length > 8) crashLiveFeed.lastElementChild.remove();
}

function clearCrashTimers() {
  if (crashFrame) cancelAnimationFrame(crashFrame);
  if (crashPollTimer) clearInterval(crashPollTimer);
  if (crashFeedTimer) clearInterval(crashFeedTimer);
  crashFrame = 0;
  crashPollTimer = 0;
  crashFeedTimer = 0;
}

function adoptCrashRound(crash, announce = true) {
  if (!crash) return;
  crashRound = { ...crash, multiplier: Number(crash.multiplier || 1) };
  crashServerOffset = Number(crash.serverNow || Date.now()) - Date.now();
  updateProof(crash.proof);
  setCrashPanelUi();
  if (announce) showToast("Crash round restored.", "neutral");
  if (crash.status === "betting") renderCrashCountdown();
  if (crash.status === "active") startCrashAnimation();
}

function renderCrashCountdown() {
  if (!crashRound) return;
  const remaining = Math.max(0, crashRound.startsAt - crashNow());
  crashBadge.textContent = "betting";
  crashCountdown.querySelector("strong").textContent = `Next round starts in ${(remaining / 1000).toFixed(1)}s`;
  crashCountdown.querySelector("span").style.width = `${Math.max(0, Math.min(100, 100 - (remaining / 3200) * 100))}%`;
  crashReadout.textContent = "1.00x";
  crashCenterReadout.querySelector("strong").textContent = "1.00x";
  crashCenterReadout.querySelector("span").textContent = "Bets are locked for the current round.";
  crashStatus.textContent = `Server hash ${crashRound.proof?.serverSeedHash?.slice(0, 14) || "pending"}...`;
  drawCrash(0, 1, Number(crashRound.autoCashout || prefs.target || 2));
  setCrashPanelUi();
  if (remaining <= 0) {
    startCrashAnimation();
    return;
  }
  crashFrame = requestAnimationFrame(renderCrashCountdown);
}

async function settleCrashRound() {
  if (!crashRound) return;
  try {
    const payload = await api("/api/public/casino/crash/action", { sessionId: crashRound.sessionId, action: "settle" });
    finishCrashRound(payload);
  } catch (error) {
    crashStatus.textContent = error.message || "Crash settlement failed.";
    crashRound = null;
    setCrashPanelUi();
  }
}

async function cashOutCrash(panel = "A") {
  if (!crashRound || crashRound.status !== "active") return;
  const form = panelForm(panel);
  const action = form?.querySelector("[data-panel-action]");
  if (action) action.textContent = "Cashing out...";
  try {
    const payload = await api("/api/public/casino/crash/action", { sessionId: crashRound.sessionId, action: "cashout", panel });
    crashRound = { ...payload.crash, multiplier: crashRound.multiplier || 1 };
    pulseBalance(payload.balance);
    setAccount({ wallet: payload.wallet, bank: payload.bank });
    setCrashPanelUi();
    showToast(payload.message || `Panel ${panel} cashed out.`, "win");
    tone("win");
  } catch (error) {
    crashStatus.textContent = error.message || "Cashout failed.";
    setCrashPanelUi();
  }
}

function startCrashAnimation() {
  if (!crashRound) return;
  clearCrashTimers();
  crashRound.status = "active";
  crashBadge.textContent = "live";
  crashCountdown.querySelector("strong").textContent = "Round live";
  crashCountdown.querySelector("span").style.width = "100%";
  renderCrashOverlay("");
  setCrashPanelUi();
  crashStatus.textContent = "Multiplier is live. Cash out before the graph snaps.";
  crashFeedTimer = setInterval(() => fakeCrashFeed("active", crashRound?.multiplier || 1), 1450);
  crashPollTimer = setInterval(async () => {
    if (!crashRound) return;
    try {
      const payload = await api("/api/public/casino/crash/action", { sessionId: crashRound.sessionId, action: "state" });
      if (payload.crash?.status === "finished") settleCrashRound();
    } catch {
      clearInterval(crashPollTimer);
      crashPollTimer = 0;
    }
  }, 350);

  const tick = () => {
    if (!crashRound || crashRound.status !== "active") return;
    const elapsed = Math.max(0, crashNow() - crashRound.startsAt);
    const multiplier = crashMultiplierAt(elapsed);
    crashRound.multiplier = multiplier;
    crashReadout.textContent = `${multiplier.toFixed(2)}x`;
    crashCenterReadout.querySelector("strong").textContent = `${multiplier.toFixed(2)}x`;
    const activeBets = Object.values(crashRound.bets || {}).filter((bet) => bet.status === "placed");
    const potential = activeBets.reduce((sum, bet) => sum + Math.floor(bet.amount * multiplier), 0);
    const wagered = activeBets.reduce((sum, bet) => sum + bet.amount, 0);
    crashCenterReadout.querySelector("span").textContent = activeBets.length ? `Potential ${fmt(potential)} | profit ${fmt(potential - wagered)}` : "All active bets cashed out.";
    drawCrash(Math.min(elapsed / 9000, 1), multiplier, Number(crashRound.autoCashout || prefs.target || 2));
    Object.entries(crashRound.bets || {}).forEach(([panel, bet]) => {
      if (bet.status === "placed" && Number(bet.autoCashout || 0) >= 1.05 && multiplier >= Number(bet.autoCashout)) {
        cashOutCrash(panel);
      }
    });
    setCrashPanelUi();
    crashFrame = requestAnimationFrame(tick);
  };
  crashFrame = requestAnimationFrame(tick);
}

function finishCrashRound(payload = {}) {
  clearCrashTimers();
  const crash = payload.crash || {};
  crashRound = { ...crash, status: "finished" };
  const won = Number(payload.payout || 0) > 0;
  crashBadge.textContent = won ? "cashed" : "crashed";
  crashReadout.textContent = `${Number(crash.crashPoint || crash.multiplier || 1).toFixed(2)}x`;
  crashCenterReadout.querySelector("strong").textContent = `CRASHED @ ${Number(crash.crashPoint || 1).toFixed(2)}x`;
  crashCenterReadout.querySelector("span").textContent = won ? `Final payout ${fmt(payload.payout)} | net ${payload.net >= 0 ? "+" : ""}${fmt(payload.net)}` : `Lost ${fmt(crash.bet || 0)} bread.`;
  renderCrashOverlay(`CRASHED @ ${Number(crash.crashPoint || 1).toFixed(2)}x`);
  drawCrash(1, Number(crash.crashPoint || crash.multiplier || 1), Number(crash.autoCashout || prefs.target || 2), true, won, Number(crash.cashoutMultiplier || 0), Number(crash.crashPoint || 0));
  crashStatus.textContent = crash.result || (won ? `Cashed out for +${fmt(payload.payout)}.` : `Crashed. Lost ${fmt(crash.bet)}.`);
  pulseBalance(payload.balance);
  setAccount({ wallet: payload.wallet, bank: payload.bank });
  updateProof(crash.proof || payload.proof);
  updateSidePanels(payload);
  renderCrashMarkers(payload.recentRounds || []);
  fakeCrashFeed(won ? "active" : "lost", Number(crash.crashPoint || 1));
  lastCrashProof = crash.proof || payload.proof || null;
  crashVerifyButton.disabled = !lastCrashProof;
  sessionTotals.bestCrash = Math.max(sessionTotals.bestCrash, Number(crash.cashoutMultiplier || 0));
  recordTransaction("Crash", crash.bet || 0, payload.payout || 0, payload.net || 0);
  tone(won ? "win" : "loss");
  const queuedForNextRound = { ...(crash.queued || {}) };
  setTimeout(() => {
    crashRound = { queued: queuedForNextRound };
    setCrashPanelUi();
    crashBadge.textContent = "armed";
    renderCrashOverlay("");
    startQueuedCrashBets();
  }, reduceMotion ? 300 : 1400);
}

async function placeCrashBet(panel = "A") {
  const form = panelForm(panel);
  if (!form) return;
  saveCrashPanelPrefs(panel);
  tone("click");
  crashStatus.textContent = "Locking bet and asking the server for a hidden crash point...";
  try {
    const payload = await api("/api/public/casino/crash/start", {
      panel,
      bet: panelValues(panel).bet,
      autoCashout: panelValues(panel).target,
      clientSeed: clientSeedInput.value.trim() || "chipkittle"
    });
    adoptCrashRound(payload.crash, false);
    if (payload.balance !== undefined) setAccount({ balance: payload.balance, wallet: payload.wallet, bank: payload.bank });
    updateSidePanels(payload);
    showToast(payload.message || (payload.queued ? `Panel ${panel} queued for next round.` : `Panel ${panel} bet placed.`), payload.queued ? "neutral" : "win");
    fakeCrashFeed("betting");
  } catch (error) {
    crashStatus.textContent = error.message || "Crash failed.";
    crashBadge.textContent = "jammed";
    setCrashPanelUi();
    tone("loss");
  }
}

async function cancelCrashBet(panel = "A") {
  const queued = queuedPanelBet(panel);
  if (queued && !activePanelBet(panel)) {
    delete crashRound.queued[panel];
    showToast(`Panel ${panel} queued bet cancelled.`, "neutral");
    setCrashPanelUi();
    return;
  }
  if (!crashRound?.sessionId) return;
  try {
    const payload = await api("/api/public/casino/crash/action", { sessionId: crashRound.sessionId, action: "cancel", panel });
    if (payload.crash) adoptCrashRound(payload.crash, false);
    else crashRound = null;
    if (payload.balance !== undefined) setAccount({ balance: payload.balance, wallet: payload.wallet, bank: payload.bank });
    setCrashPanelUi();
    showToast(payload.message || `Panel ${panel} bet cancelled.`, "neutral");
  } catch (error) {
    crashStatus.textContent = error.message || "Cancel failed.";
  }
}

function startQueuedCrashBets() {
  const queued = crashRound?.queued || {};
  crashRound = null;
  Object.keys(queued).forEach((panel) => {
    const form = panelForm(panel);
    if (!form) return;
    form.elements.bet.value = queued[panel].amount;
    form.elements.target.value = queued[panel].autoCashout || form.elements.target.value;
    setTimeout(() => placeCrashBet(panel), panel === "A" ? 100 : 350);
  });
}

crashPanels.forEach((form) => {
  const panel = form.dataset.panel;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (activePanelBet(panel)?.status === "placed" && crashRound?.status === "active") {
      cashOutCrash(panel);
      return;
    }
    placeCrashBet(panel);
  });
  form.querySelector("[data-panel-cancel]").addEventListener("click", () => cancelCrashBet(panel));
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
    recordTransaction("Blackjack", hand.bet || 0, hand.payout || 0, (hand.payout || 0) - (hand.bet || 0));
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
    const form = row.dataset.panelChips
      ? panelForm(row.dataset.panelChips)
      : document.querySelector(`#${row.dataset.target}`);
    const input = form?.querySelector("input[name='bet']");
    if (!input) return;
    input.value = button.dataset.chip;
    if (row.dataset.panelChips) {
      saveCrashPanelPrefs(row.dataset.panelChips);
    } else {
      prefs.bets[form.id] = input.value;
    }
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
  crashPanels.forEach((form) => {
    const panel = form.dataset.panel;
    form.elements.bet.value = prefs.crashPanels?.[panel]?.bet || "100";
    form.elements.target.value = prefs.crashPanels?.[panel]?.target || (panel === "A" ? "2.00" : "3.00");
  });
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
slotsPaytableButton.addEventListener("click", () => slotsPaytableModal.showModal());
document.querySelector("[data-paytable-close]")?.addEventListener("click", () => slotsPaytableModal.close());
crashPanels.forEach((form) => {
  form.addEventListener("change", () => saveCrashPanelPrefs(form.dataset.panel));
});
crashVerifyButton.addEventListener("click", () => {
  if (!lastCrashProof) return;
  crashProofData.textContent = JSON.stringify(lastCrashProof, null, 2);
  crashProofModal.showModal();
});
document.querySelector("[data-proof-close]")?.addEventListener("click", () => crashProofModal.close());
copyProofButton.addEventListener("click", async () => {
  if (!lastCrashProof) return;
  await navigator.clipboard?.writeText(JSON.stringify(lastCrashProof, null, 2));
  showToast("Proof data copied.", "neutral");
});
document.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (["input", "textarea", "select"].includes(tag)) return;
  if (event.key === " " && crashRound?.status === "active") {
    event.preventDefault();
    cashOutCrash("A");
  } else if (event.key === "Enter" && !crashRound) {
    event.preventDefault();
    placeCrashBet("A");
  } else if (event.key === "Escape") {
    if (crashProofModal.open) crashProofModal.close();
    else if (queuedPanelBet("A")) cancelCrashBet("A");
  }
});
hitButton.addEventListener("click", () => blackjackAction("hit"));
standButton.addEventListener("click", () => blackjackAction("stand"));
doubleButton.addEventListener("click", () => blackjackAction("double"));
splitButton.addEventListener("click", () => blackjackAction("split"));
insuranceButton.addEventListener("click", () => blackjackAction("insurance"));

slotsForm.querySelector("input[name='bet']").value = prefs.bets.slotsForm || "100";
crashPanels.forEach((form) => {
  const panel = form.dataset.panel;
  form.elements.bet.value = prefs.crashPanels?.[panel]?.bet || "100";
  form.elements.target.value = prefs.crashPanels?.[panel]?.target || (panel === "A" ? "2.00" : "3.00");
});
blackjackForm.querySelector("input[name='bet']").value = prefs.bets.blackjackForm || "100";
drawCrash(0, 1, 2);
renderBlackjack({ status: "idle", player: [], dealer: [], playerValue: 0, dealerValue: 0, bet: 0, payout: 0, balance: 0 });
updateSidePanels();
loadState();
