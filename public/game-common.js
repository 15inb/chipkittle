const PANEL_BASE = "https://panel.chipkittle.com";
const PLAYER_NAME_KEY = "chipkittle-player-name";
const DISCORD_ID_KEY = "chipkittle-discord-id";

export function safeName(value) {
  return String(value || "")
    .replace(/[^\w .#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24) || "Anonymous Chipkittle";
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (match) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[match]));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function rand(min, max) {
  return min + Math.random() * (max - min);
}

export function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function loadLocalLeaderboard(storageKey) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalLeaderboard(storageKey, scores) {
  localStorage.setItem(storageKey, JSON.stringify(scores.slice(0, 10)));
}

export function createBackgroundCache(canvas, renderer) {
  let cacheCanvas = null;
  let cacheKey = null;

  return function drawCached(key) {
    if (!cacheCanvas || cacheKey !== key) {
      cacheCanvas = document.createElement("canvas");
      cacheCanvas.width = canvas.width;
      cacheCanvas.height = canvas.height;
      const cacheCtx = cacheCanvas.getContext("2d");
      renderer(cacheCtx, canvas, key);
      cacheKey = key;
    }
    return cacheCanvas;
  };
}

export function createGameServices(gameId, options) {
  const {
    leaderboardList,
    leaderboardStatus,
    claimCard,
    playerName,
    emptyText
  } = options;
  const leaderboardUrl = `${PANEL_BASE}/api/public/game-leaderboard?game=${encodeURIComponent(gameId)}`;
  const claimUrl = `${PANEL_BASE}/api/public/dash-claim`;
  const claimRedeemUrl = `${PANEL_BASE}/api/public/dash-claim/redeem`;
  const leaderboardKey = `chipkittle-${gameId}-leaderboard`;
  let claimRequested = false;
  let activeClaim = null;
  let currentUser = window.ChipkittleSite?.currentUser || null;

  async function loadCurrentUser() {
    if (currentUser) return currentUser;
    try {
      const response = await fetch(`${PANEL_BASE}/api/public/me`, { cache: "no-store", credentials: "include" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload?.authenticated && payload.user) {
        currentUser = payload.user;
        return currentUser;
      }
    } catch {}
    return null;
  }

  window.addEventListener("chipkittle:account", (event) => {
    currentUser = event.detail || null;
    if (activeClaim?.code) setClaimCard("", activeClaim.code, activeClaim.amount);
  });

  function hydratePlayerName() {
    if (!playerName) return;
    if (!playerName.value) {
      playerName.value = localStorage.getItem(PLAYER_NAME_KEY) || "";
    }
  }

  function persistPlayerName({ allowAnonymous = false } = {}) {
    if (!playerName) return allowAnonymous ? "Anonymous Chipkittle" : "";
    const rawValue = String(playerName.value || "").trim() || localStorage.getItem(PLAYER_NAME_KEY) || "";
    if (!rawValue && !allowAnonymous) {
      playerName.value = "";
      return "";
    }
    const nextName = safeName(rawValue);
    playerName.value = allowAnonymous || rawValue ? nextName : "";
    if (rawValue) {
      localStorage.setItem(PLAYER_NAME_KEY, nextName);
    }
    return nextName;
  }

  function hasPlayerName() {
    return Boolean(String(playerName?.value || "").trim() || localStorage.getItem(PLAYER_NAME_KEY) || "");
  }

  function focusPlayerName() {
    playerName?.focus();
    playerName?.select?.();
  }

  function setLeaderboardStatus(message = "") {
    leaderboardStatus.hidden = !message;
    leaderboardStatus.textContent = message;
  }

  function setClaimCard(message, code = "", amount = 0) {
    activeClaim = code ? { code, amount: Number(amount) || 0 } : null;
    const savedDiscordId = localStorage.getItem(DISCORD_ID_KEY) || "";
    const accountLine = currentUser
      ? `<small>Signed in as ${escapeHtml(currentUser.displayName || currentUser.username || "your account")}. This will claim straight to you.</small>`
      : `<small>Log in first to claim this bread without copying your Discord ID.</small>`;
    claimCard.innerHTML = code
      ? `
          <span>Discord claim</span>
          <strong>${escapeHtml(code)}</strong>
          <small>Use <code>!claimdash ${escapeHtml(code)}</code> for ${Number(amount) || 0} bread, or claim straight from here.</small>
          <div class="claim-actions">
            <button type="button" data-copy-claim>Copy Command</button>
          </div>
          ${accountLine}
          <form class="claim-direct-form" data-direct-claim>
            <label ${currentUser ? "hidden" : ""}>
              Discord ID
              <input name="discordId" inputmode="numeric" maxlength="22" value="${escapeHtml(savedDiscordId)}" placeholder="Your Discord user ID">
            </label>
            <button type="submit">${currentUser ? "Claim to my account" : "Claim to Discord"}</button>
          </form>
          ${currentUser ? "" : `<a class="button secondary" href="${PANEL_BASE}/profile/login">Log in to auto-claim</a>`}
          <small data-claim-status></small>
        `
      : `<span>Discord claim</span><small>${escapeHtml(message)}</small>`;
  }

  function setClaimStatus(message = "") {
    const status = claimCard?.querySelector("[data-claim-status]");
    if (status) status.textContent = message;
  }

  async function copyClaimCommand() {
    if (!activeClaim?.code) return;
    const command = `!claimdash ${activeClaim.code}`;
    try {
      await navigator.clipboard.writeText(command);
      setClaimStatus("Copied claim command.");
    } catch {
      setClaimStatus(`Copy failed. Command: ${command}`);
    }
  }

  async function redeemClaimDirect(form) {
    if (!activeClaim?.code) return;
    const user = await loadCurrentUser();
    const discordId = String(new FormData(form).get("discordId") || "").replace(/\D/g, "");
    if (!user && !/^\d{16,22}$/.test(discordId)) {
      setClaimStatus("Enter a valid Discord user ID.");
      form.querySelector("input[name='discordId']")?.focus();
      return;
    }

    if (!user) localStorage.setItem(DISCORD_ID_KEY, discordId);
    setClaimStatus("Claiming bread...");
    try {
      const response = await fetch(claimRedeemUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: user ? "include" : "omit",
        body: JSON.stringify(user ? { code: activeClaim.code } : { code: activeClaim.code, discordId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Claim failed.");
      setClaimCard(`Claimed ${Number(payload.bread || 0).toLocaleString()} bread for ${payload.userTag || user?.displayName || discordId}. Balance: ${Number(payload.balance || 0).toLocaleString()} bread.`);
      claimRequested = true;
    } catch (error) {
      setClaimStatus(error?.message || "Claim failed.");
    }
  }

  function renderLeaderboard(scores = loadLocalLeaderboard(leaderboardKey)) {
    if (!scores.length) {
      leaderboardList.innerHTML = `<li><span>${escapeHtml(emptyText)}</span><strong>0</strong></li>`;
      return;
    }

    leaderboardList.innerHTML = scores.slice(0, 10).map((entry) => `
      <li>
        <span>${escapeHtml(safeName(entry.name))}</span>
        <strong>${Number(entry.score) || 0}</strong>
      </li>
    `).join("");
  }

  async function loadLeaderboard() {
    try {
      const response = await fetch(leaderboardUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("Leaderboard request failed.");
      const payload = await response.json();
      if (!Array.isArray(payload.scores)) throw new Error("Leaderboard response was invalid.");
      saveLocalLeaderboard(leaderboardKey, payload.scores);
      renderLeaderboard(payload.scores);
      setLeaderboardStatus("");
    } catch {
      renderLeaderboard();
    }
  }

  async function submitScore({ score, bread }) {
    if (score <= 0) return;
    const name = persistPlayerName({ allowAnonymous: true });
    const entry = {
      game: gameId,
      name,
      score: Math.floor(score),
      bread: Math.floor(bread),
      createdAt: new Date().toISOString()
    };

    const localScores = [...loadLocalLeaderboard(leaderboardKey), entry]
      .sort((a, b) => (b.score - a.score) || (b.bread - a.bread))
      .slice(0, 10);
    saveLocalLeaderboard(leaderboardKey, localScores);
    renderLeaderboard(localScores);

    try {
      const response = await fetch(leaderboardUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Leaderboard save failed.");
      if (Array.isArray(payload.scores)) {
        saveLocalLeaderboard(leaderboardKey, payload.scores);
        renderLeaderboard(payload.scores);
      }
      setLeaderboardStatus("Saved to the leaderboard.");
    } catch (error) {
      setLeaderboardStatus(error?.message || "The leaderboard save failed.");
      renderLeaderboard(localScores);
    }
  }

  async function createClaimCode({ score, bread }) {
    if (claimRequested) return;
    claimRequested = true;

    if (bread <= 0) {
      setClaimCard("This run ended with 0 bread, so there is nothing to claim.");
      return;
    }

    setClaimCard("Creating your Discord claim code...");
    try {
      const response = await fetch(claimUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game: gameId,
          name: persistPlayerName({ allowAnonymous: true }),
          score: Math.floor(score),
          bread: Math.floor(bread)
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Claim request failed.");
      if (!payload.claimCode) throw new Error("Claim response was invalid.");
      setClaimCard("", payload.claimCode, payload.claimBread);
      const user = await loadCurrentUser();
      if (user) {
        setClaimCard("", payload.claimCode, payload.claimBread);
        const form = claimCard?.querySelector("[data-direct-claim]");
        if (form) redeemClaimDirect(form);
      }
    } catch (error) {
      claimRequested = false;
      setClaimCard(error?.message || "The claim code request failed. Try again after the panel updates.");
    }
  }

  function resetClaimState(message) {
    claimRequested = false;
    setClaimCard(message);
    setLeaderboardStatus("");
  }

  hydratePlayerName();
  loadCurrentUser().then((user) => {
    if (user && activeClaim?.code) setClaimCard("", activeClaim.code, activeClaim.amount);
  });
  if (playerName) {
    playerName.addEventListener("change", () => {
      persistPlayerName();
    });
    playerName.addEventListener("blur", () => {
      persistPlayerName();
    });
  }
  claimCard?.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-copy-claim]")) {
      copyClaimCommand();
    }
  });
  claimCard?.addEventListener("submit", (event) => {
    const form = event.target?.closest?.("[data-direct-claim]");
    if (!form) return;
    event.preventDefault();
    redeemClaimDirect(form);
  });

  return {
    hydratePlayerName,
    persistPlayerName,
    hasPlayerName,
    focusPlayerName,
    renderLeaderboard,
    loadLeaderboard,
    submitScore,
    createClaimCode,
    resetClaimState,
    setClaimCard,
    setLeaderboardStatus,
    safeName
  };
}
