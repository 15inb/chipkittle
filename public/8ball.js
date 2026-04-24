(function () {
  const apiRoot = ["localhost", "127.0.0.1", "panel.chipkittle.com"].includes(window.location.hostname)
    ? `${window.location.origin}/api/public/eight-ball`
    : "https://panel.chipkittle.com/api/public/eight-ball";

  const storageKeys = {
    name: "chipkittle-8ball-name",
    room: "chipkittle-8ball-room",
    tokens: "chipkittle-8ball-tokens"
  };
  const MAX_RENDER_DPR = 1.5;

  const tableFallback = {
    width: 1180,
    height: 680,
    rail: 42,
    ballRadius: 17,
    cornerPocketRadius: 40,
    sidePocketRadius: 36,
    cornerPocketMouth: 108,
    sidePocketHalf: 78,
    sideJawInset: 28,
    sideJawDepth: 94,
    pocketPullRadius: 98,
    headX: 286,
    footX: 862,
    centerY: 340
  };

  const ballStyles = {
    0: { color: "#f8fbf7", accent: "#d9e2d6", label: "" },
    1: { color: "#f4d241", accent: "#f5f5f2", label: "1" },
    2: { color: "#4769d8", accent: "#f5f5f2", label: "2" },
    3: { color: "#d24e3f", accent: "#f5f5f2", label: "3" },
    4: { color: "#8150d3", accent: "#f5f5f2", label: "4" },
    5: { color: "#ef8f39", accent: "#f5f5f2", label: "5" },
    6: { color: "#2f9f65", accent: "#f5f5f2", label: "6" },
    7: { color: "#7a231d", accent: "#f5f5f2", label: "7" },
    8: { color: "#0b0f0d", accent: "#74ef70", label: "8" },
    9: { color: "#f4d241", accent: "#f5f5f2", label: "9" },
    10: { color: "#4769d8", accent: "#f5f5f2", label: "10" },
    11: { color: "#d24e3f", accent: "#f5f5f2", label: "11" },
    12: { color: "#8150d3", accent: "#f5f5f2", label: "12" },
    13: { color: "#ef8f39", accent: "#f5f5f2", label: "13" },
    14: { color: "#2f9f65", accent: "#f5f5f2", label: "14" },
    15: { color: "#7a231d", accent: "#f5f5f2", label: "15" }
  };

  const canvas = document.querySelector("#eightBallCanvas");
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const playerNameInput = document.querySelector("#playerName");
  const roomCodeInput = document.querySelector("#roomCode");
  const createRoomButton = document.querySelector("#createRoom");
  const joinRoomButton = document.querySelector("#joinRoom");
  const copyLinkButton = document.querySelector("#copyLink");
  const leaveRoomButton = document.querySelector("#leaveRoom");
  const copyCodeButton = document.querySelector("#copyCode");
  const resetTableButton = document.querySelector("#resetTable");
  const roomValue = document.querySelector("#roomValue");
  const seatValue = document.querySelector("#seatValue");
  const turnValue = document.querySelector("#turnValue");
  const matchState = document.querySelector("#matchState");
  const turnBanner = document.querySelector("#turnBanner");
  const tableNote = document.querySelector("#tableNote");
  const shotMeta = document.querySelector("#shotMeta");
  const lastShotSummary = document.querySelector("#lastShotSummary");
  const rackGrid = document.querySelector("#rackGrid");
  const rackStatus = document.querySelector("#rackStatus");
  const playersList = document.querySelector("#playersList");
  const playerSummary = document.querySelector("#playerSummary");
  const objectiveBadge = document.querySelector("#objectiveBadge");
  const objectiveValue = document.querySelector("#objectiveValue");
  const ballInHandValue = document.querySelector("#ballInHandValue");
  const powerSlider = document.querySelector("#powerSlider");
  const powerValue = document.querySelector("#powerValue");

  let state = null;
  let renderedBalls = createFallbackBalls();
  let renderedShotId = -1;
  let previewCuePlacement = null;
  let aiming = false;
  let placingCue = false;
  let animating = false;
  let pendingRequest = false;
  let pointerId = null;
  let pollTimer = 0;
  let animationHandle = 0;
  let drawQueued = false;
  let transientNote = "";
  let transientTimer = 0;
  let cuePlacementValid = true;
  const pointer = { x: 0, y: 0, moved: false };
  const backgroundCache = { key: "", canvas: null };
  const ballSpriteCache = new Map();

  playerNameInput.value = localStorage.getItem(storageKeys.name) || "";
  powerValue.textContent = `${powerSlider.value}%`;
  ctx.imageSmoothingEnabled = true;

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(Math.max(number, min), max);
  }

  function safeName(value) {
    return String(value || "")
      .replace(/[^\w .#-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24) || "Anonymous Chipkittle";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function currentTable() {
    return state?.table || tableFallback;
  }

  function pocketsForTable(table) {
    return [
      { id: "tl", x: table.rail + 12, y: table.rail + 12, radius: table.cornerPocketRadius, kind: "corner" },
      { id: "tm", x: table.width / 2, y: table.rail + 2, radius: table.sidePocketRadius, kind: "side" },
      { id: "tr", x: table.width - table.rail - 12, y: table.rail + 12, radius: table.cornerPocketRadius, kind: "corner" },
      { id: "bl", x: table.rail + 12, y: table.height - table.rail - 12, radius: table.cornerPocketRadius, kind: "corner" },
      { id: "bm", x: table.width / 2, y: table.height - table.rail - 2, radius: table.sidePocketRadius, kind: "side" },
      { id: "br", x: table.width - table.rail - 12, y: table.height - table.rail - 12, radius: table.cornerPocketRadius, kind: "corner" }
    ];
  }

  function cushionSegmentsForTable(table) {
    const left = table.rail + table.ballRadius;
    const right = table.width - table.rail - table.ballRadius;
    const top = table.rail + table.ballRadius;
    const bottom = table.height - table.rail - table.ballRadius;
    const centerX = table.width / 2;
    const corner = table.cornerPocketMouth;
    const sideHalf = table.sidePocketHalf;
    const sideJawInset = table.sideJawInset;
    const sideJawDepth = table.sideJawDepth;

    return [
      { ax: corner, ay: top, bx: centerX - sideHalf, by: top },
      { ax: centerX + sideHalf, ay: top, bx: table.width - corner, by: top },
      { ax: corner, ay: bottom, bx: centerX - sideHalf, by: bottom },
      { ax: centerX + sideHalf, ay: bottom, bx: table.width - corner, by: bottom },
      { ax: left, ay: corner, bx: left, by: table.height - corner },
      { ax: right, ay: corner, bx: right, by: table.height - corner },
      { ax: corner, ay: top, bx: left, by: corner },
      { ax: table.width - corner, ay: top, bx: right, by: corner },
      { ax: corner, ay: bottom, bx: left, by: table.height - corner },
      { ax: table.width - corner, ay: bottom, bx: right, by: table.height - corner },
      { ax: centerX - sideHalf, ay: top, bx: centerX - sideJawInset, by: sideJawDepth },
      { ax: centerX + sideHalf, ay: top, bx: centerX + sideJawInset, by: sideJawDepth },
      { ax: centerX - sideHalf, ay: bottom, bx: centerX - sideJawInset, by: table.height - sideJawDepth },
      { ax: centerX + sideHalf, ay: bottom, bx: centerX + sideJawInset, by: table.height - sideJawDepth }
    ];
  }

  function lerp(start, end, amount) {
    return start + (end - start) * amount;
  }

  function tokenMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKeys.tokens) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveToken(roomCode, token) {
    if (!roomCode || !token) return;
    const tokens = tokenMap();
    tokens[String(roomCode).toUpperCase()] = String(token);
    localStorage.setItem(storageKeys.tokens, JSON.stringify(tokens));
  }

  function clearToken(roomCode) {
    const code = String(roomCode || "").toUpperCase();
    if (!code) return;
    const tokens = tokenMap();
    delete tokens[code];
    localStorage.setItem(storageKeys.tokens, JSON.stringify(tokens));
  }

  function tokenFor(roomCode) {
    return tokenMap()[String(roomCode || "").toUpperCase()] || "";
  }

  function currentRoomCode() {
    return String(localStorage.getItem(storageKeys.room) || "").toUpperCase();
  }

  function setRoomQuery(roomCode) {
    const url = new URL(window.location.href);
    if (roomCode) {
      url.searchParams.set("room", roomCode);
    } else {
      url.searchParams.delete("room");
    }
    window.history.replaceState({}, "", url.toString());
  }

  function rememberRoom(roomCode, token) {
    const code = String(roomCode || "").toUpperCase();
    if (!code) return;
    localStorage.setItem(storageKeys.room, code);
    roomCodeInput.value = code;
    setRoomQuery(code);
    if (token) {
      saveToken(code, token);
    }
  }

  function clearRoomState() {
    const code = currentRoomCode();
    if (code) {
      clearToken(code);
    }
    localStorage.removeItem(storageKeys.room);
    setRoomQuery("");
    state = null;
    syncRenderBuffer(createFallbackBalls());
    renderedShotId = -1;
    previewCuePlacement = null;
    aiming = false;
    placingCue = false;
    animating = false;
    pendingRequest = false;
    cancelAnimationFrame(animationHandle);
    clearTimeout(pollTimer);
    updatePanel();
    requestDraw();
  }

  function flashNote(message) {
    transientNote = String(message || "");
    clearTimeout(transientTimer);
    if (transientNote) {
      transientTimer = setTimeout(() => {
        transientNote = "";
        updatePanel();
      }, 2400);
    }
    updatePanel();
  }

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${apiRoot}${path}`, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (_error) {
      throw new Error("The Chipkittle room server is offline right now. Restart the VPS panel process and try again.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error("The Chipkittle room server is having trouble right now. Restart the VPS panel process and try again.");
      }
      throw new Error(payload.error || "The Chipkittle table did not answer.");
    }
    return payload;
  }

  function groupForNumber(number) {
    if (number >= 1 && number <= 7) return "solids";
    if (number >= 9 && number <= 15) return "stripes";
    if (number === 8) return "eight";
    return "cue";
  }

  function rackPositions() {
    const positions = [];
    const rowSpacing = tableFallback.ballRadius * 2 + 1.2;
    const colSpacing = Math.sqrt(3) * tableFallback.ballRadius + 0.8;
    let index = 0;
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col <= row; col += 1) {
        positions[index] = {
          x: tableFallback.footX + row * colSpacing,
          y: tableFallback.centerY + (col - row / 2) * rowSpacing
        };
        index += 1;
      }
    }
    return positions;
  }

  function createBall(number, x, y) {
    return {
      id: number === 0 ? "cue" : `ball-${number}`,
      number,
      kind: groupForNumber(number),
      style: ballStyles[number] || ballStyles[0],
      x,
      y,
      pocketed: false
    };
  }

  function assignBallState(target, source) {
    const number = Number(source?.number) || 0;
    target.id = number === 0 ? "cue" : `ball-${number}`;
    target.number = number;
    target.kind = source?.kind || groupForNumber(number);
    target.style = ballStyles[number] || ballStyles[0];
    target.x = Number(source?.x) || 0;
    target.y = Number(source?.y) || 0;
    target.pocketed = Boolean(source?.pocketed);
    return target;
  }

  function syncRenderBuffer(sourceBalls) {
    const length = Array.isArray(sourceBalls) ? sourceBalls.length : 0;
    renderedBalls.length = length;
    for (let index = 0; index < length; index += 1) {
      const source = sourceBalls[index];
      renderedBalls[index] = assignBallState(renderedBalls[index] || {}, source);
    }
    return renderedBalls;
  }

  function interpolateIntoRenderBuffer(fromFrame, toFrame, amount) {
    const length = Math.max(fromFrame?.length || 0, toFrame?.length || 0);
    renderedBalls.length = length;
    for (let index = 0; index < length; index += 1) {
      const target = renderedBalls[index] || {};
      const next = toFrame?.[index] || fromFrame?.[index];
      const previous = fromFrame?.[index] || next;
      assignBallState(target, next);
      if (previous && next && !previous.pocketed && !next.pocketed) {
        target.x = lerp(Number(previous.x) || 0, Number(next.x) || 0, amount);
        target.y = lerp(Number(previous.y) || 0, Number(next.y) || 0, amount);
      }
      renderedBalls[index] = target;
    }
    return renderedBalls;
  }

  function createFallbackBalls() {
    const cue = createBall(0, tableFallback.headX, tableFallback.centerY);
    const rack = [1, 10, 2, 11, 8, 3, 12, 4, 13, 9, 5, 14, 6, 15, 7];
    const positions = rackPositions();
    return [cue, ...rack.map((number, index) => createBall(number, positions[index].x, positions[index].y))];
  }

  function activeBallNumbers() {
    return new Set((state?.balls || renderedBalls).filter((ball) => !ball.pocketed).map((ball) => ball.number));
  }

  function ballByNumber(balls, number) {
    return (balls || []).find((ball) => ball.number === number) || null;
  }

  function cueBallForDraw() {
    const sourceCue = ballByNumber(renderedBalls, 0);
    if (!sourceCue) return null;
    if (!animating && hasBallInHand() && previewCuePlacement) {
      return {
        ...sourceCue,
        x: previewCuePlacement.x,
        y: previewCuePlacement.y,
        pocketed: false
      };
    }
    return sourceCue;
  }

  function myIndex() {
    return Number.isInteger(state?.selfPlayerIndex) ? state.selfPlayerIndex : -1;
  }

  function myPlayer() {
    return state?.players?.[myIndex()] || null;
  }

  function myTurn() {
    return Boolean(state) && state.status === "active" && state.currentTurn === myIndex();
  }

  function hasBallInHand() {
    return Boolean(state) && state.ballInHandPlayerIndex === myIndex();
  }

  function myObjective() {
    return myPlayer()?.objective || "Open table";
  }

  function powerRatio() {
    return clamp(Number(powerSlider.value) / 100, 0.2, 1);
  }

  function ballLabel(number) {
    if (number === 8) return "the 8";
    if (number === 0) return "the cue";
    return `${number}`;
  }

  function describeLastShot() {
    if (!state?.lastShot || state.lastShot.byPlayerIndex < 0) {
      return "No shot has been taken yet.";
    }

    const shot = state.lastShot;
    const shooter = state.players?.[shot.byPlayerIndex]?.name || "A Chipkittle";
    const parts = [];

    if (shot.pocketedNumbers?.length) {
      parts.push(`${shooter} pocketed ${shot.pocketedNumbers.map(ballLabel).join(", ")}.`);
    } else {
      parts.push(`${shooter} left the table unchanged.`);
    }

    if (shot.assignedGroup) {
      parts.push(`${shooter} claimed ${shot.assignedGroup}.`);
    }

    if (shot.foul && shot.foulReasons?.length) {
      parts.push(shot.foulReasons.join(" "));
    } else if (shot.legalEight) {
      parts.push("That was the winning 8-ball.");
    } else if (shot.retainedTurn) {
      parts.push("They keep shooting.");
    } else {
      parts.push("The turn passes.");
    }

    return parts.join(" ");
  }

  function statusText() {
    if (!state) return "No room";
    if (state.status === "finished") return "Finished";
    if (state.status === "waiting") return "Waiting";
    if (hasBallInHand()) return "Ball in hand";
    return "Live";
  }

  function turnText() {
    if (!state) return "-";
    if (state.status === "waiting") return "Waiting";
    if (state.status === "finished") {
      const winner = state.players?.[state.winnerIndex]?.name;
      return winner ? `${winner} won` : "Finished";
    }
    return state.players?.[state.currentTurn]?.name || "-";
  }

  function turnBannerText() {
    if (!state) {
      return "Create a room or join one and the table will wake up.";
    }
    if (state.status === "waiting") {
      return `Share room ${state.roomCode} and wait for the second Chipkittle to sit down.`;
    }
    if (state.status === "finished") {
      const winner = state.players?.[state.winnerIndex]?.name || "A Chipkittle";
      return `${winner} owns this table. Rack them again when you are ready.`;
    }
    if (pendingRequest) {
      return "Sending the shot to the table...";
    }
    if (myTurn()) {
      if (hasBallInHand()) {
        return "Ball in hand. Grab the cue ball, place it anywhere clear, then drag to shoot.";
      }
      return "Your turn. Drag on the table and release to fire the shot.";
    }
    return `${state.players?.[state.currentTurn]?.name || "Another player"} is at the table.`;
  }

  function noteText() {
    if (transientNote) return transientNote;
    if (!state) {
      return "When it is your turn, drag on the table and release to shoot. If you have ball-in-hand, grab the cue ball first and place it where you want.";
    }
    if (state.status === "waiting") {
      return "Copy the invite link and send it to the other player so they land in the same room.";
    }
    if (hasBallInHand()) {
      return "You have ball-in-hand. Drag the cue ball itself to a clean spot, release it, then drag anywhere on the felt to shoot.";
    }
    if (myTurn()) {
      return "Aim by dragging across the table. Power comes from the slider, so the shot line stays predictable.";
    }
    return state.message || "Wait for the other player to finish their turn.";
  }

  function updateStatusPill() {
    matchState.textContent = statusText();
    matchState.classList.remove("is-live", "is-waiting", "is-finished", "is-alert");
    if (!state) {
      matchState.classList.add("is-waiting");
      return;
    }
    if (state.status === "finished") {
      matchState.classList.add("is-finished");
    } else if (hasBallInHand()) {
      matchState.classList.add("is-alert");
    } else if (state.status === "active") {
      matchState.classList.add("is-live");
    } else {
      matchState.classList.add("is-waiting");
    }
  }

  function renderPlayers() {
    if (!state?.players?.length) {
      playersList.innerHTML = '<li class="player-card"><strong>Waiting for room</strong><span>Create or join a table to start.</span></li>';
      playerSummary.textContent = "Waiting for challengers";
      return;
    }

    playerSummary.textContent = `${state.players.length}/2 seated`;
    playersList.innerHTML = state.players
      .map((player, index) => {
        const classes = ["player-card"];
        if (state.currentTurn === index && state.status === "active") classes.push("is-turn");
        if (state.selfPlayerIndex === index) classes.push("is-you");
        if (state.winnerIndex === index && state.status === "finished") classes.push("is-winner");
        const group = player.group ? player.group[0].toUpperCase() + player.group.slice(1) : "Open table";
        const seat = state.selfPlayerIndex === index ? "You" : `Seat ${index + 1}`;
        const progress = player.canShootEight
          ? "On the 8"
          : player.group
            ? `${state.remaining?.[player.group] ?? 0} left`
            : "Unclaimed";
        return `
          <li class="${classes.join(" ")}">
            <strong>${escapeHtml(player.name)}</strong>
            <span>${escapeHtml(player.objective || "Open table")}</span>
            <small>${escapeHtml(seat)} &middot; ${escapeHtml(group)} &middot; ${escapeHtml(progress)}</small>
          </li>
        `;
      })
      .join("");
  }

  function renderRack() {
    const activeNumbers = activeBallNumbers();
    const highlightedGroup = myPlayer()?.canShootEight ? "eight" : myPlayer()?.group || "";
    rackGrid.innerHTML = Array.from({ length: 15 }, (_unused, index) => index + 1)
      .map((number) => {
        const kind = groupForNumber(number);
        const classes = ["rack-pill", `is-${kind}`];
        if (!activeNumbers.has(number)) classes.push("is-pocketed");
        if (highlightedGroup && highlightedGroup === kind) classes.push("is-target");
        return `<div class="${classes.join(" ")}">${number}</div>`;
      })
      .join("");

    if (!state) {
      rackStatus.textContent = "15 balls waiting";
      return;
    }

    rackStatus.textContent = `${state.remaining.solids} solids left, ${state.remaining.stripes} stripes left`;
  }

  function updateButtonState() {
    const hasRoom = Boolean(state?.roomCode || currentRoomCode());
    const hasToken = Boolean(tokenFor(currentRoomCode()));
    const locked = pendingRequest || animating;
    createRoomButton.disabled = locked;
    joinRoomButton.disabled = locked;
    copyLinkButton.disabled = !hasRoom;
    leaveRoomButton.disabled = !hasRoom;
    copyCodeButton.disabled = !hasRoom;
    resetTableButton.disabled = !hasRoom || !hasToken || locked;
  }

  function updatePanel() {
    roomValue.textContent = state?.roomCode || "-----";
    seatValue.textContent = state?.selfPlayerIndex >= 0 ? `Seat ${state.selfPlayerIndex + 1}` : "-";
    turnValue.textContent = turnText();
    turnBanner.textContent = turnBannerText();
    shotMeta.textContent = state?.message || "Waiting for a room";
    lastShotSummary.textContent = describeLastShot();
    objectiveBadge.textContent = myPlayer()?.group ? `You are ${myPlayer().group}` : "Open table";
    objectiveValue.textContent = myObjective();
    ballInHandValue.textContent = hasBallInHand() ? "Yes" : "No";
    tableNote.textContent = noteText();
    tableNote.classList.toggle("is-alert", Boolean(transientNote));
    updateStatusPill();
    renderPlayers();
    renderRack();
    updateButtonState();
  }

  function updateStoredName() {
    localStorage.setItem(storageKeys.name, safeName(playerNameInput.value));
  }

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      if (!animating) {
        draw();
      }
    });
  }

  function ensureCanvasResolution() {
    const table = currentTable();
    const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 900 ? 1.25 : MAX_RENDER_DPR);
    const width = Math.round(table.width * dpr);
    const height = Math.round(table.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function createSurface(width, height) {
    const surface = document.createElement("canvas");
    surface.width = width;
    surface.height = height;
    return surface;
  }

  function roundRectPath(x, y, width, height, radius, context = ctx) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function backgroundKey(table) {
    return [
      table.width,
      table.height,
      table.rail,
      table.ballRadius,
      table.cornerPocketRadius,
      table.sidePocketRadius,
      table.cornerPocketMouth,
      table.sidePocketHalf,
      table.sideJawInset,
      table.sideJawDepth
    ].join(":");
  }

  function renderTableBackground(targetCtx, table) {
    const pockets = pocketsForTable(table);
    const cushionSegments = cushionSegmentsForTable(table);

    targetCtx.clearRect(0, 0, table.width, table.height);

    const roomGlow = targetCtx.createRadialGradient(table.width * 0.64, table.height * 0.46, 40, table.width * 0.64, table.height * 0.46, 540);
    roomGlow.addColorStop(0, "rgba(87, 236, 115, 0.20)");
    roomGlow.addColorStop(0.36, "rgba(39, 111, 65, 0.18)");
    roomGlow.addColorStop(1, "rgba(4, 12, 10, 0)");
    targetCtx.fillStyle = roomGlow;
    targetCtx.fillRect(0, 0, table.width, table.height);

    const wood = targetCtx.createLinearGradient(0, 0, 0, table.height);
    wood.addColorStop(0, "#4b3423");
    wood.addColorStop(0.45, "#2d1e14");
    wood.addColorStop(1, "#1c120c");
    roundRectPath(10, 10, table.width - 20, table.height - 20, 52, targetCtx);
    targetCtx.fillStyle = wood;
    targetCtx.fill();

    const feltInset = table.rail;
    const feltWidth = table.width - feltInset * 2;
    const feltHeight = table.height - feltInset * 2;
    const felt = targetCtx.createRadialGradient(table.width * 0.55, table.height * 0.48, 80, table.width * 0.55, table.height * 0.48, table.width * 0.6);
    felt.addColorStop(0, "#1f8e53");
    felt.addColorStop(0.48, "#13673a");
    felt.addColorStop(1, "#0a321f");
    roundRectPath(feltInset, feltInset, feltWidth, feltHeight, 34, targetCtx);
    targetCtx.fillStyle = felt;
    targetCtx.fill();

    targetCtx.save();
    targetCtx.globalCompositeOperation = "destination-out";
    for (const pocket of pockets) {
      targetCtx.beginPath();
      targetCtx.arc(pocket.x, pocket.y, pocket.radius + 3, 0, Math.PI * 2);
      targetCtx.fill();
    }
    targetCtx.restore();

    targetCtx.save();
    roundRectPath(feltInset, feltInset, feltWidth, feltHeight, 34, targetCtx);
    targetCtx.clip();
    targetCtx.strokeStyle = "rgba(183, 255, 200, 0.05)";
    targetCtx.lineWidth = 1;
    for (let index = -2; index < 20; index += 1) {
      const y = 70 + index * 34;
      targetCtx.beginPath();
      targetCtx.moveTo(feltInset - 30, y);
      targetCtx.bezierCurveTo(table.width * 0.24, y + 12, table.width * 0.48, y - 12, table.width - feltInset + 30, y + 8);
      targetCtx.stroke();
    }

    targetCtx.lineWidth = 6;
    targetCtx.lineCap = "round";
    targetCtx.strokeStyle = "rgba(3, 8, 6, 0.96)";
    for (const segment of cushionSegments) {
      targetCtx.beginPath();
      targetCtx.moveTo(segment.ax, segment.ay);
      targetCtx.lineTo(segment.bx, segment.by);
      targetCtx.stroke();
    }

    targetCtx.lineWidth = 1.6;
    targetCtx.strokeStyle = "rgba(225, 248, 220, 0.10)";
    for (const segment of cushionSegments.slice(0, 6)) {
      targetCtx.beginPath();
      targetCtx.moveTo(segment.ax, segment.ay);
      targetCtx.lineTo(segment.bx, segment.by);
      targetCtx.stroke();
    }
    targetCtx.restore();

    targetCtx.strokeStyle = "rgba(245, 255, 247, 0.16)";
    targetCtx.lineWidth = 2;
    targetCtx.setLineDash([10, 14]);
    targetCtx.beginPath();
    targetCtx.moveTo(table.headX, feltInset + 18);
    targetCtx.lineTo(table.headX, table.height - feltInset - 18);
    targetCtx.stroke();
    targetCtx.setLineDash([]);

    targetCtx.fillStyle = "rgba(241, 251, 241, 0.72)";
    targetCtx.beginPath();
    targetCtx.arc(table.footX, table.centerY, 4.5, 0, Math.PI * 2);
    targetCtx.fill();

    for (const pocket of pockets) {
      const rim = targetCtx.createRadialGradient(pocket.x, pocket.y, 4, pocket.x, pocket.y, pocket.radius + 10);
      rim.addColorStop(0, "#010202");
      rim.addColorStop(0.62, "#0b0f0c");
      rim.addColorStop(1, "rgba(196, 146, 85, 0.3)");
      targetCtx.beginPath();
      targetCtx.arc(pocket.x, pocket.y, pocket.radius + 8, 0, Math.PI * 2);
      targetCtx.fillStyle = rim;
      targetCtx.fill();

      const throat = targetCtx.createRadialGradient(pocket.x, pocket.y, 0, pocket.x, pocket.y, pocket.radius + 3);
      throat.addColorStop(0, "rgba(0, 0, 0, 0.98)");
      throat.addColorStop(0.55, "rgba(3, 5, 4, 0.96)");
      throat.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.beginPath();
      targetCtx.arc(pocket.x, pocket.y, pocket.radius + 3, 0, Math.PI * 2);
      targetCtx.fillStyle = throat;
      targetCtx.fill();
    }

    const diamonds = [
      [table.width * 0.19, 22],
      [table.width * 0.38, 22],
      [table.width * 0.62, 22],
      [table.width * 0.81, 22],
      [table.width * 0.19, table.height - 22],
      [table.width * 0.38, table.height - 22],
      [table.width * 0.62, table.height - 22],
      [table.width * 0.81, table.height - 22],
      [22, table.height * 0.24],
      [22, table.height * 0.5],
      [22, table.height * 0.76],
      [table.width - 22, table.height * 0.24],
      [table.width - 22, table.height * 0.5],
      [table.width - 22, table.height * 0.76]
    ];

    targetCtx.fillStyle = "rgba(255, 238, 191, 0.86)";
    for (const [x, y] of diamonds) {
      targetCtx.save();
      targetCtx.translate(x, y);
      targetCtx.rotate(Math.PI / 4);
      targetCtx.fillRect(-4, -4, 8, 8);
      targetCtx.restore();
    }
  }

  function getBackgroundCanvas(table) {
    const key = backgroundKey(table);
    if (backgroundCache.key === key && backgroundCache.canvas) {
      return backgroundCache.canvas;
    }
    const surface = createSurface(table.width, table.height);
    const backgroundCtx = surface.getContext("2d", { alpha: false, desynchronized: true });
    renderTableBackground(backgroundCtx, table);
    backgroundCache.key = key;
    backgroundCache.canvas = surface;
    return surface;
  }

  function drawBackground(table) {
    ctx.drawImage(getBackgroundCanvas(table), 0, 0);
  }

  function drawBall(ball, table) {
    if (!ball || ball.pocketed) return;
    const key = `${ball.number}:${table.ballRadius}`;
    let sprite = ballSpriteCache.get(key);
    if (!sprite) {
      const radius = table.ballRadius;
      const kind = groupForNumber(ball.number);
      const style = ballStyles[ball.number] || ballStyles[0];
      const size = Math.ceil(radius * 4.5);
      const half = size / 2;
      const surface = createSurface(size, size);
      const spriteCtx = surface.getContext("2d", { alpha: true, desynchronized: true });
      spriteCtx.imageSmoothingEnabled = true;
      spriteCtx.translate(half, half);

      const shadow = spriteCtx.createRadialGradient(-radius * 0.25, -radius * 0.35, radius * 0.2, 0, 0, radius * 1.65);
      shadow.addColorStop(0, "rgba(255, 255, 255, 0.34)");
      shadow.addColorStop(0.55, ball.number === 8 ? "rgba(17, 22, 18, 0.96)" : style.color);
      shadow.addColorStop(1, "rgba(0, 0, 0, 0.92)");
      spriteCtx.fillStyle = shadow;
      spriteCtx.beginPath();
      spriteCtx.arc(0, 0, radius, 0, Math.PI * 2);
      spriteCtx.fill();

      if (kind === "stripes") {
        spriteCtx.save();
        spriteCtx.beginPath();
        spriteCtx.arc(0, 0, radius, 0, Math.PI * 2);
        spriteCtx.clip();
        spriteCtx.fillStyle = "#fbf8f3";
        spriteCtx.fillRect(-radius, -radius, radius * 2, radius * 2);
        spriteCtx.fillStyle = style.color;
        spriteCtx.fillRect(-radius, -radius * 0.55, radius * 2, radius * 1.1);
        spriteCtx.restore();
        spriteCtx.strokeStyle = "rgba(0, 0, 0, 0.12)";
        spriteCtx.lineWidth = 1;
        spriteCtx.beginPath();
        spriteCtx.arc(0, 0, radius, 0, Math.PI * 2);
        spriteCtx.stroke();
      }

      if (kind === "cue") {
        const cueGradient = spriteCtx.createRadialGradient(-6, -8, 2, 0, 0, radius * 1.2);
        cueGradient.addColorStop(0, "#ffffff");
        cueGradient.addColorStop(0.62, "#f2f5f0");
        cueGradient.addColorStop(1, "#cfd8d0");
        spriteCtx.fillStyle = cueGradient;
        spriteCtx.beginPath();
        spriteCtx.arc(0, 0, radius, 0, Math.PI * 2);
        spriteCtx.fill();
      }

      if (kind === "solids" || kind === "eight") {
        spriteCtx.fillStyle = style.color;
        spriteCtx.beginPath();
        spriteCtx.arc(0, 0, radius, 0, Math.PI * 2);
        spriteCtx.fill();
      }

      if (kind === "eight") {
        spriteCtx.strokeStyle = "rgba(116, 239, 112, 0.4)";
        spriteCtx.lineWidth = 1.5;
        spriteCtx.beginPath();
        spriteCtx.arc(0, 0, radius + 1.6, 0, Math.PI * 2);
        spriteCtx.stroke();
      }

      if (kind !== "cue") {
        spriteCtx.fillStyle = "#fbf8f3";
        spriteCtx.beginPath();
        spriteCtx.arc(0, 0, radius * 0.42, 0, Math.PI * 2);
        spriteCtx.fill();
        spriteCtx.fillStyle = ball.number === 8 ? "#0b0f0d" : "#15201a";
        spriteCtx.font = `${ball.number >= 10 ? 9 : 11}px Inter, system-ui, sans-serif`;
        spriteCtx.textAlign = "center";
        spriteCtx.textBaseline = "middle";
        spriteCtx.fillText(String(ball.number), 0, 0.6);
      }

      sprite = { canvas: surface, half };
      ballSpriteCache.set(key, sprite);
    }

    ctx.drawImage(sprite.canvas, ball.x - sprite.half, ball.y - sprite.half);
  }

  function drawCueGuides(table) {
    if (!state || !myTurn() || animating || pendingRequest || state.status !== "active" || !aiming) return;

    const cue = cueBallForDraw();
    if (!cue) return;

    const dx = pointer.x - cue.x;
    const dy = pointer.y - cue.y;
    const length = Math.hypot(dx, dy);
    if (length < table.ballRadius * 1.2) return;

    const nx = dx / length;
    const ny = dy / length;
    const cueStickDistance = 26 + powerRatio() * 64;

    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(224, 255, 229, 0.82)";
    ctx.lineWidth = 2.2;
    ctx.setLineDash([8, 9]);
    ctx.beginPath();
    ctx.moveTo(cue.x, cue.y);
    ctx.lineTo(cue.x + nx * 280, cue.y + ny * 280);
    ctx.stroke();
    ctx.setLineDash([]);

    const cueStick = ctx.createLinearGradient(cue.x - nx * 190, cue.y - ny * 190, cue.x - nx * 20, cue.y - ny * 20);
    cueStick.addColorStop(0, "#d8be88");
    cueStick.addColorStop(1, "#6e4c25");
    ctx.strokeStyle = cueStick;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cue.x - nx * (cueStickDistance + 150), cue.y - ny * (cueStickDistance + 150));
    ctx.lineTo(cue.x - nx * (cueStickDistance + 20), cue.y - ny * (cueStickDistance + 20));
    ctx.stroke();

    ctx.fillStyle = "rgba(116, 239, 112, 0.16)";
    ctx.beginPath();
    ctx.arc(cue.x + nx * 46, cue.y + ny * 46, table.ballRadius * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCuePlacementHighlight(table) {
    if (!state || !hasBallInHand() || animating) return;
    const cue = cueBallForDraw();
    if (!cue) return;
    ctx.save();
    ctx.strokeStyle = cuePlacementValid ? "rgba(128, 255, 152, 0.72)" : "rgba(255, 112, 112, 0.82)";
    ctx.lineWidth = 2.4;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.arc(cue.x, cue.y, table.ballRadius + 8, 0, Math.PI * 2);
    ctx.stroke();
    if (!cuePlacementValid) {
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(255, 80, 80, 0.45)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cue.x - table.ballRadius - 3, cue.y - table.ballRadius - 3);
      ctx.lineTo(cue.x + table.ballRadius + 3, cue.y + table.ballRadius + 3);
      ctx.moveTo(cue.x + table.ballRadius + 3, cue.y - table.ballRadius - 3);
      ctx.lineTo(cue.x - table.ballRadius - 3, cue.y + table.ballRadius + 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    ensureCanvasResolution();
    const table = currentTable();
    drawBackground(table);

    const cueOverride = cueBallForDraw();
    for (const ball of renderedBalls) {
      if (ball.number === 0 && cueOverride) continue;
      drawBall(ball, table);
    }
    if (cueOverride) {
      drawBall(cueOverride, table);
    }

    drawCuePlacementHighlight(table);
    drawCueGuides(table);
  }

  function validCuePlacementLocal(placement) {
    const table = currentTable();
    const x = clamp(placement?.x, table.rail + table.ballRadius, table.width - table.rail - table.ballRadius);
    const y = clamp(placement?.y, table.rail + table.ballRadius, table.height - table.rail - table.ballRadius);
    const collisions = (state?.balls || renderedBalls).some((ball) => {
      if (!ball || ball.number === 0 || ball.pocketed) return false;
      return Math.hypot(ball.x - x, ball.y - y) < table.ballRadius * 2 + 0.25;
    });
    const insidePocketShelf = pocketsForTable(table).some((pocket) => Math.hypot(pocket.x - x, pocket.y - y) <= pocket.radius + table.ballRadius * 0.8);
    if (collisions || insidePocketShelf) return null;
    return { x, y };
  }

  function tablePointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const table = currentTable();
    return {
      x: clamp((event.clientX - rect.left) * (table.width / rect.width), 0, table.width),
      y: clamp((event.clientY - rect.top) * (table.height / rect.height), 0, table.height)
    };
  }

  function animateTrace(trace, finalBalls) {
    cancelAnimationFrame(animationHandle);
    animating = true;
    updateButtonState();
    const frames = Array.isArray(trace) && trace.length ? trace : [finalBalls];
    const totalFrames = frames.length;
    const duration = clamp(totalFrames * 16, 360, 1400);
    const start = performance.now();

    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const scaled = progress * Math.max(totalFrames - 1, 0);
      const frameIndex = Math.min(totalFrames - 1, Math.floor(scaled));
      const nextIndex = Math.min(totalFrames - 1, frameIndex + 1);
      const frameProgress = scaled - frameIndex;
      if (frameIndex === nextIndex) {
        syncRenderBuffer(frames[frameIndex]);
      } else {
        interpolateIntoRenderBuffer(frames[frameIndex], frames[nextIndex], frameProgress);
      }
      draw();
      if (progress < 1) {
        animationHandle = requestAnimationFrame(step);
        return;
      }
      animating = false;
      syncRenderBuffer(finalBalls);
      draw();
      updateButtonState();
    }

    animationHandle = requestAnimationFrame(step);
  }

  function applyState(nextState, options = {}) {
    state = nextState || null;
    if (!state) {
      syncRenderBuffer(createFallbackBalls());
      renderedShotId = -1;
      previewCuePlacement = null;
      cuePlacementValid = true;
      updatePanel();
      requestDraw();
      return;
    }

    rememberRoom(state.roomCode, options.token || "");
    if (hasBallInHand()) {
      const cue = ballByNumber(state.balls, 0);
      if (!previewCuePlacement && cue) {
        previewCuePlacement = { x: cue.x, y: cue.y };
      }
      cuePlacementValid = true;
    } else {
      previewCuePlacement = null;
      cuePlacementValid = true;
    }

    const shouldAnimate = options.animate !== false
      && state.shotId > renderedShotId
      && Array.isArray(state.trace)
      && state.trace.length > 1;

    renderedShotId = Math.max(renderedShotId, Number(state.shotId) || 0);

    if (shouldAnimate) {
      animateTrace(state.trace, state.balls);
    } else {
      cancelAnimationFrame(animationHandle);
      animating = false;
      syncRenderBuffer(state.balls);
      requestDraw();
    }

    updatePanel();
    schedulePoll(1200);
  }

  async function refreshState(options = {}) {
    const roomCode = currentRoomCode();
    const token = tokenFor(roomCode);
    if (!roomCode || !token) return;
    if (pendingRequest && options.silent) return;

    try {
      const sinceShotId = renderedShotId >= 0 ? `&sinceShotId=${encodeURIComponent(renderedShotId)}` : "";
      const nextState = await request(`/${roomCode}?token=${encodeURIComponent(token)}${sinceShotId}`);
      applyState(nextState, { animate: options.animate !== false });
    } catch (error) {
      if (/does not exist/i.test(error.message || "")) {
        flashNote(error.message || "That room is gone now.");
        clearRoomState();
      } else if (!options.silent) {
        flashNote(error.message || "Could not refresh the table.");
      }
    }
  }

  function schedulePoll(delay = 1600) {
    clearTimeout(pollTimer);
    const roomCode = currentRoomCode();
    const token = tokenFor(roomCode);
    if (!roomCode || !token) return;
    pollTimer = setTimeout(async () => {
      await refreshState({ silent: true, animate: true });
      schedulePoll(1600);
    }, delay);
  }

  async function createRoom() {
    pendingRequest = true;
    updateButtonState();
    try {
      const playerName = safeName(playerNameInput.value);
      playerNameInput.value = playerName;
      updateStoredName();
      const payload = await request("/create", {
        method: "POST",
        body: { playerName }
      });
      rememberRoom(payload.state.roomCode, payload.token);
      applyState(payload.state, { animate: false, token: payload.token });
    } catch (error) {
      flashNote(error.message || "Could not create a room.");
    } finally {
      pendingRequest = false;
      updateButtonState();
    }
  }

  async function joinRoom() {
    pendingRequest = true;
    updateButtonState();
    try {
      const playerName = safeName(playerNameInput.value);
      const roomCode = String(roomCodeInput.value || "").toUpperCase().trim();
      if (!roomCode) {
        throw new Error("Enter a room code first.");
      }
      playerNameInput.value = playerName;
      roomCodeInput.value = roomCode;
      updateStoredName();
      const payload = await request(`/${roomCode}/join`, {
        method: "POST",
        body: { playerName }
      });
      rememberRoom(payload.state.roomCode, payload.token);
      applyState(payload.state, { animate: false, token: payload.token });
    } catch (error) {
      flashNote(error.message || "Could not join that room.");
    } finally {
      pendingRequest = false;
      updateButtonState();
    }
  }

  async function resetTable() {
    const roomCode = currentRoomCode();
    const token = tokenFor(roomCode);
    if (!roomCode || !token) return;
    pendingRequest = true;
    updateButtonState();
    try {
      const nextState = await request(`/${roomCode}/reset`, {
        method: "POST",
        body: { token }
      });
      applyState(nextState, { animate: false });
      flashNote("Fresh rack ready.");
    } catch (error) {
      flashNote(error.message || "Could not reset the table.");
    } finally {
      pendingRequest = false;
      updateButtonState();
    }
  }

  async function submitShot(dx, dy) {
    const roomCode = currentRoomCode();
    const token = tokenFor(roomCode);
    if (!roomCode || !token) return;

    pendingRequest = true;
    updateButtonState();
    try {
      const cuePlacement = hasBallInHand() && previewCuePlacement
        ? { x: previewCuePlacement.x, y: previewCuePlacement.y }
        : null;
      const nextState = await request(`/${roomCode}/shoot`, {
        method: "POST",
        body: {
          token,
          dx,
          dy,
          power: powerRatio(),
          cuePlacement
        }
      });
      previewCuePlacement = null;
      applyState(nextState, { animate: true });
    } catch (error) {
      flashNote(error.message || "The shot failed.");
    } finally {
      pendingRequest = false;
      updateButtonState();
    }
  }

  async function copyToClipboard(text, successMessage) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const helper = document.createElement("textarea");
        helper.value = text;
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        document.body.removeChild(helper);
      }
      flashNote(successMessage);
    } catch {
      flashNote("Clipboard access was blocked.");
    }
  }

  function roomInviteUrl() {
    const roomCode = currentRoomCode() || String(roomCodeInput.value || "").toUpperCase().trim();
    const url = new URL("/8ball", window.location.origin);
    if (roomCode) {
      url.searchParams.set("room", roomCode);
    }
    return url.toString();
  }

  function onPointerDown(event) {
    if (!state || !myTurn() || pendingRequest || animating || state.status !== "active") return;
    const point = tablePointFromEvent(event);
    const cue = cueBallForDraw();
    if (!cue) return;

    pointerId = event.pointerId;
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.moved = false;
    canvas.setPointerCapture(pointerId);

    if (hasBallInHand() && Math.hypot(point.x - cue.x, point.y - cue.y) <= currentTable().ballRadius * 1.65) {
      placingCue = true;
      cuePlacementValid = true;
      aiming = false;
      requestDraw();
      return;
    }

    aiming = true;
    placingCue = false;
    requestDraw();
  }

  function onPointerMove(event) {
    if (pointerId == null || event.pointerId !== pointerId) return;
    const point = tablePointFromEvent(event);
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.moved = true;

    if (placingCue) {
      const valid = validCuePlacementLocal(point);
      cuePlacementValid = Boolean(valid);
      if (valid) {
        previewCuePlacement = valid;
      }
      requestDraw();
      return;
    }

    if (aiming) {
      requestDraw();
    }
  }

  function resetPointerState() {
    aiming = false;
    placingCue = false;
    cuePlacementValid = true;
    pointerId = null;
  }

  function onPointerUp(event) {
    if (pointerId == null || event.pointerId !== pointerId) return;
    const point = tablePointFromEvent(event);
    canvas.releasePointerCapture(pointerId);

    if (placingCue) {
      const valid = validCuePlacementLocal(point);
      if (valid) {
        previewCuePlacement = valid;
      } else {
        flashNote("That spot is blocked. Keep the cue ball clear of other balls and the pocket mouths.");
      }
      resetPointerState();
      requestDraw();
      return;
    }

    if (!aiming) {
      resetPointerState();
      requestDraw();
      return;
    }

    const cue = cueBallForDraw();
    resetPointerState();
    if (!cue) {
      requestDraw();
      return;
    }

    const dx = point.x - cue.x;
    const dy = point.y - cue.y;
    if (Math.hypot(dx, dy) < currentTable().ballRadius * 1.15) {
      requestDraw();
      return;
    }

    requestDraw();
    submitShot(dx, dy);
  }

  function leaveRoom() {
    clearRoomState();
    flashNote("Left the room.");
  }

  function bootstrapRoomFromUrl() {
    const queryRoom = String(new URLSearchParams(window.location.search).get("room") || "").toUpperCase();
    const storedRoom = currentRoomCode();
    const initialRoom = queryRoom || storedRoom;
    if (initialRoom) {
      rememberRoom(initialRoom);
    }
  }

  createRoomButton.addEventListener("click", createRoom);
  joinRoomButton.addEventListener("click", joinRoom);
  copyLinkButton.addEventListener("click", () => copyToClipboard(roomInviteUrl(), "Invite link copied."));
  leaveRoomButton.addEventListener("click", leaveRoom);
  copyCodeButton.addEventListener("click", () => {
    const code = currentRoomCode() || String(roomCodeInput.value || "").toUpperCase().trim();
    if (code) {
      copyToClipboard(code, `Room ${code} copied.`);
    }
  });
  resetTableButton.addEventListener("click", resetTable);

  roomCodeInput.addEventListener("input", () => {
    roomCodeInput.value = String(roomCodeInput.value || "")
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, "")
      .slice(0, 5);
  });

  roomCodeInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    joinRoom();
  });

  playerNameInput.addEventListener("change", () => {
    playerNameInput.value = safeName(playerNameInput.value);
    updateStoredName();
  });

  playerNameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (String(roomCodeInput.value || "").trim()) {
      joinRoom();
    } else {
      createRoom();
    }
  });

  powerSlider.addEventListener("input", () => {
    powerValue.textContent = `${powerSlider.value}%`;
    requestDraw();
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", () => {
    resetPointerState();
    requestDraw();
  });

  window.addEventListener("resize", requestDraw);
  window.addEventListener("focus", () => {
    refreshState({ silent: true, animate: false });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshState({ silent: true, animate: false });
    }
  });

  bootstrapRoomFromUrl();
  updatePanel();
  draw();

  if (currentRoomCode() && tokenFor(currentRoomCode())) {
    refreshState({ silent: true, animate: false });
  }
})();
