import crypto from "node:crypto";

const ROOM_TTL_MS = 1000 * 60 * 60 * 4;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TRACE_FRAMES = 64;
const TRACE_SAMPLE_STEPS = 4;
const MAX_SIMULATION_STEPS = 500;
const FRICTION = 0.992;
const WALL_BOUNCE = 0.94;
const TABLE = {
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
const POCKETS = [
  { id: "tl", x: TABLE.rail + 12, y: TABLE.rail + 12, radius: TABLE.cornerPocketRadius, pullRadius: TABLE.pocketPullRadius, kind: "corner" },
  { id: "tm", x: TABLE.width / 2, y: TABLE.rail + 2, radius: TABLE.sidePocketRadius, pullRadius: TABLE.pocketPullRadius, kind: "side" },
  { id: "tr", x: TABLE.width - TABLE.rail - 12, y: TABLE.rail + 12, radius: TABLE.cornerPocketRadius, pullRadius: TABLE.pocketPullRadius, kind: "corner" },
  { id: "bl", x: TABLE.rail + 12, y: TABLE.height - TABLE.rail - 12, radius: TABLE.cornerPocketRadius, pullRadius: TABLE.pocketPullRadius, kind: "corner" },
  { id: "bm", x: TABLE.width / 2, y: TABLE.height - TABLE.rail - 2, radius: TABLE.sidePocketRadius, pullRadius: TABLE.pocketPullRadius, kind: "side" },
  { id: "br", x: TABLE.width - TABLE.rail - 12, y: TABLE.height - TABLE.rail - 12, radius: TABLE.cornerPocketRadius, pullRadius: TABLE.pocketPullRadius, kind: "corner" }
];
const CUSHION_SEGMENTS = createCushionSegments();
const BALL_STYLE = {
  cue: { color: "#f8fbf7", accent: "#d9e2d6", label: "" },
  eight: { color: "#0b0f0d", accent: "#74ef70", label: "8" },
  1: { color: "#f4d241", accent: "#f5f5f2", label: "1" },
  2: { color: "#4769d8", accent: "#f5f5f2", label: "2" },
  3: { color: "#d24e3f", accent: "#f5f5f2", label: "3" },
  4: { color: "#8150d3", accent: "#f5f5f2", label: "4" },
  5: { color: "#ef8f39", accent: "#f5f5f2", label: "5" },
  6: { color: "#2f9f65", accent: "#f5f5f2", label: "6" },
  7: { color: "#7a231d", accent: "#f5f5f2", label: "7" },
  9: { color: "#f4d241", accent: "#f5f5f2", label: "9" },
  10: { color: "#4769d8", accent: "#f5f5f2", label: "10" },
  11: { color: "#d24e3f", accent: "#f5f5f2", label: "11" },
  12: { color: "#8150d3", accent: "#f5f5f2", label: "12" },
  13: { color: "#ef8f39", accent: "#f5f5f2", label: "13" },
  14: { color: "#2f9f65", accent: "#f5f5f2", label: "14" },
  15: { color: "#7a231d", accent: "#f5f5f2", label: "15" }
};

const rooms = new Map();

function randomToken() {
  return crypto.randomBytes(18).toString("hex");
}

function randomRoomCode() {
  let code = "";
  for (let index = 0; index < 5; index += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function cleanPlayerName(value = "") {
  return String(value || "")
    .replace(/[^\w .#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24) || "Anonymous Chipkittle";
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function compactCoord(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function groupForNumber(number) {
  if (number >= 1 && number <= 7) return "solids";
  if (number >= 9 && number <= 15) return "stripes";
  if (number === 8) return "eight";
  return "cue";
}

function ballStyleFor(number) {
  return BALL_STYLE[number] || BALL_STYLE.cue;
}

function createBall(number, x, y) {
  const kind = groupForNumber(number);
  const style = ballStyleFor(number);
  return {
    id: kind === "cue" ? "cue" : `ball-${number}`,
    number,
    kind,
    style,
    x,
    y,
    vx: 0,
    vy: 0,
    pocketed: false
  };
}

function cloneBall(ball) {
  return {
    ...ball,
    style: ball.style
  };
}

function publicBall(ball) {
  return {
    number: ball.number,
    x: compactCoord(ball.x),
    y: compactCoord(ball.y),
    pocketed: Boolean(ball.pocketed)
  };
}

function rackNumbers() {
  const solidCornerOnTop = Math.random() < 0.5;
  const corners = {
    top: solidCornerOnTop ? 1 : 9,
    bottom: solidCornerOnTop ? 9 : 1
  };
  const remaining = [2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15].sort(() => Math.random() - 0.5);
  const triangle = [
    null,
    null, null,
    null, 8, null,
    null, null, null, null,
    corners.top, null, null, null, corners.bottom
  ];

  let remainingIndex = 0;
  for (let index = 0; index < triangle.length; index += 1) {
    if (triangle[index] == null) {
      triangle[index] = remaining[remainingIndex];
      remainingIndex += 1;
    }
  }

  return triangle;
}

function rackPositions() {
  const positions = [];
  const rowSpacing = TABLE.ballRadius * 2 + 1.2;
  const colSpacing = Math.sqrt(3) * TABLE.ballRadius + 0.8;
  let index = 0;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col <= row; col += 1) {
      const x = TABLE.footX + row * colSpacing;
      const y = TABLE.centerY + (col - row / 2) * rowSpacing;
      positions[index] = { x, y };
      index += 1;
    }
  }
  return positions;
}

function defaultCuePlacement() {
  return {
    x: TABLE.headX,
    y: TABLE.centerY
  };
}

function createRackState() {
  const cuePlacement = defaultCuePlacement();
  const cueBall = createBall(0, cuePlacement.x, cuePlacement.y);
  const numbers = rackNumbers();
  const positions = rackPositions();
  const objectBalls = numbers.map((number, index) => {
    const position = positions[index];
    return createBall(number, position.x, position.y);
  });

  return [cueBall, ...objectBalls];
}

function cueBall(balls) {
  return balls.find((ball) => ball.number === 0);
}

function ballByNumber(balls, number) {
  return balls.find((ball) => ball.number === number);
}

function activeBalls(balls) {
  return balls.filter((ball) => !ball.pocketed);
}

function remainingGroupCount(balls, group) {
  return balls.filter((ball) => !ball.pocketed && ball.kind === group).length;
}

function totalSpeed(balls) {
  return balls.reduce((sum, ball) => sum + (ball.pocketed ? 0 : Math.hypot(ball.vx, ball.vy)), 0);
}

function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if ((room.updatedAt || 0) + ROOM_TTL_MS < now) {
      rooms.delete(code);
    }
  }
}

function touchRoom(room) {
  room.updatedAt = Date.now();
  return room;
}

function roomByCode(code) {
  cleanupExpiredRooms();
  return rooms.get(String(code || "").toUpperCase()) || null;
}

function playerIndexFor(room, token) {
  return room.players.findIndex((player) => player.token === token);
}

function playerGroup(room, playerIndex) {
  return room.playerGroups[playerIndex] || null;
}

function playerCanShootEight(room, playerIndex) {
  const group = playerGroup(room, playerIndex);
  return Boolean(group) && remainingGroupCount(room.balls, group) === 0;
}

function objectiveForPlayer(room, playerIndex) {
  const group = playerGroup(room, playerIndex);
  if (!group) return "Open table";
  return playerCanShootEight(room, playerIndex) ? "Shoot the 8 ball" : `Clear the ${group}`;
}

function stateForClient(room, token = "", options = {}) {
  const selfPlayerIndex = playerIndexFor(room, token);
  const sinceShotId = Number(options.sinceShotId);
  const includeTrace = !Number.isFinite(sinceShotId) || room.shotId > sinceShotId;
  const remaining = {
    solids: remainingGroupCount(room.balls, "solids"),
    stripes: remainingGroupCount(room.balls, "stripes")
  };

  return {
    roomCode: room.code,
    status: room.status,
    players: room.players.map((player, index) => ({
      name: player.name,
      index,
      group: playerGroup(room, index),
      canShootEight: playerCanShootEight(room, index),
      objective: objectiveForPlayer(room, index)
    })),
    selfPlayerIndex,
    currentTurn: room.currentTurn,
    winnerIndex: room.winnerIndex,
    message: room.message,
    table: TABLE,
    remaining,
    breakShot: room.breakShot,
    ballInHandPlayerIndex: room.ballInHandPlayerIndex,
    inning: room.inning,
    lastShot: {
      byPlayerIndex: room.lastShot.byPlayerIndex,
      foul: room.lastShot.foul,
      foulReasons: [...room.lastShot.foulReasons],
      pocketedNumbers: [...room.lastShot.pocketedNumbers],
      assignedGroup: room.lastShot.assignedGroup,
      retainedTurn: room.lastShot.retainedTurn,
      legalEight: room.lastShot.legalEight,
      firstHitNumber: room.lastShot.firstHitNumber
    },
    balls: room.balls.map(publicBall),
    shotId: room.shotId,
    trace: includeTrace ? room.trace : [],
    updatedAt: new Date(room.updatedAt).toISOString()
  };
}

function createInitialRoom(playerName) {
  cleanupExpiredRooms();
  let code = randomRoomCode();
  while (rooms.has(code)) {
    code = randomRoomCode();
  }

  const token = randomToken();
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    players: [
      {
        name: cleanPlayerName(playerName),
        token
      }
    ],
    status: "waiting",
    currentTurn: 0,
    winnerIndex: -1,
    message: "Waiting for another Chipkittle to join the table.",
    balls: createRackState(),
    playerGroups: [null, null],
    breakShot: true,
    ballInHandPlayerIndex: null,
    inning: 1,
    shotId: 0,
    trace: [],
    lastShot: {
      byPlayerIndex: -1,
      foul: false,
      foulReasons: [],
      pocketedNumbers: [],
      assignedGroup: null,
      retainedTurn: false,
      legalEight: false,
      firstHitNumber: null
    }
  };

  rooms.set(code, room);
  return {
    token,
    state: stateForClient(room, token)
  };
}

function joinRoom(code, playerName) {
  const room = roomByCode(code);
  if (!room) {
    throw new Error("That room code does not exist anymore.");
  }
  if (room.players.length >= 2) {
    throw new Error("That room is already full.");
  }

  const token = randomToken();
  room.players.push({
    name: cleanPlayerName(playerName),
    token
  });
  room.status = "active";
  room.currentTurn = Math.floor(Math.random() * 2);
  room.winnerIndex = -1;
  room.message = `${room.players[room.currentTurn].name} breaks first.`;
  room.playerGroups = [null, null];
  room.breakShot = true;
  room.ballInHandPlayerIndex = null;
  room.inning = 1;
  room.balls = createRackState();
  room.trace = [];
  room.shotId += 1;
  room.lastShot = {
    byPlayerIndex: -1,
    foul: false,
    foulReasons: [],
    pocketedNumbers: [],
    assignedGroup: null,
    retainedTurn: false,
    legalEight: false,
    firstHitNumber: null
  };
  touchRoom(room);

  return {
    token,
    state: stateForClient(room, token)
  };
}

function getRoomState(code, token, options = {}) {
  const room = roomByCode(code);
  if (!room) {
    throw new Error("That room code does not exist anymore.");
  }
  touchRoom(room);
  return stateForClient(room, token, options);
}

function captureTraceFrame(trace, balls, force = false) {
  if (!force && trace.length >= MAX_TRACE_FRAMES) return;
  trace.push(balls.map(publicBall));
}

function normalizeVector(dx, dy) {
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  return {
    x: dx / length,
    y: dy / length
  };
}

function createCushionSegments() {
  const left = TABLE.rail + TABLE.ballRadius;
  const right = TABLE.width - TABLE.rail - TABLE.ballRadius;
  const top = TABLE.rail + TABLE.ballRadius;
  const bottom = TABLE.height - TABLE.rail - TABLE.ballRadius;
  const centerX = TABLE.width / 2;
  const corner = TABLE.cornerPocketMouth;
  const sideHalf = TABLE.sidePocketHalf;
  const sideJawInset = TABLE.sideJawInset;
  const sideJawDepth = TABLE.sideJawDepth;
  const diagonal = Math.SQRT1_2;

  return [
    { ax: corner, ay: top, bx: centerX - sideHalf, by: top, nx: 0, ny: 1 },
    { ax: centerX + sideHalf, ay: top, bx: TABLE.width - corner, by: top, nx: 0, ny: 1 },
    { ax: corner, ay: bottom, bx: centerX - sideHalf, by: bottom, nx: 0, ny: -1 },
    { ax: centerX + sideHalf, ay: bottom, bx: TABLE.width - corner, by: bottom, nx: 0, ny: -1 },
    { ax: left, ay: corner, bx: left, by: TABLE.height - corner, nx: 1, ny: 0 },
    { ax: right, ay: corner, bx: right, by: TABLE.height - corner, nx: -1, ny: 0 },
    { ax: corner, ay: top, bx: left, by: corner, nx: diagonal, ny: diagonal },
    { ax: TABLE.width - corner, ay: top, bx: right, by: corner, nx: -diagonal, ny: diagonal },
    { ax: corner, ay: bottom, bx: left, by: TABLE.height - corner, nx: diagonal, ny: -diagonal },
    { ax: TABLE.width - corner, ay: bottom, bx: right, by: TABLE.height - corner, nx: -diagonal, ny: -diagonal },
    { ax: centerX - sideHalf, ay: top, bx: centerX - sideJawInset, by: sideJawDepth, nx: -diagonal, ny: diagonal },
    { ax: centerX + sideHalf, ay: top, bx: centerX + sideJawInset, by: sideJawDepth, nx: diagonal, ny: diagonal },
    { ax: centerX - sideHalf, ay: bottom, bx: centerX - sideJawInset, by: TABLE.height - sideJawDepth, nx: -diagonal, ny: -diagonal },
    { ax: centerX + sideHalf, ay: bottom, bx: centerX + sideJawInset, by: TABLE.height - sideJawDepth, nx: diagonal, ny: -diagonal }
  ];
}

function resolveCushionSegment(ball, segment) {
  const segmentDx = segment.bx - segment.ax;
  const segmentDy = segment.by - segment.ay;
  const segmentLengthSquared = segmentDx * segmentDx + segmentDy * segmentDy;
  const projection = ((ball.x - segment.ax) * segmentDx + (ball.y - segment.ay) * segmentDy) / segmentLengthSquared;
  const t = clamp(projection, 0, 1);
  const closestX = segment.ax + segmentDx * t;
  const closestY = segment.ay + segmentDy * t;
  const offsetX = ball.x - closestX;
  const offsetY = ball.y - closestY;
  const distance = Math.hypot(offsetX, offsetY);

  if (distance > TABLE.ballRadius + 0.75) {
    return false;
  }

  const separation = offsetX * segment.nx + offsetY * segment.ny;
  if (separation >= TABLE.ballRadius) {
    return false;
  }

  const penetration = TABLE.ballRadius - separation;
  ball.x += segment.nx * penetration;
  ball.y += segment.ny * penetration;

  const approach = ball.vx * segment.nx + ball.vy * segment.ny;
  if (approach < 0) {
    ball.vx -= (1 + WALL_BOUNCE) * approach * segment.nx;
    ball.vy -= (1 + WALL_BOUNCE) * approach * segment.ny;
  }

  return true;
}

function applyPocketGravity(ball, scale = 1) {
  if (ball.pocketed) return;

  let nearestPocket = null;
  let nearestDistance = Infinity;
  for (const pocket of POCKETS) {
    const distance = Math.hypot(ball.x - pocket.x, ball.y - pocket.y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPocket = pocket;
    }
  }

  if (!nearestPocket || nearestDistance >= nearestPocket.pullRadius || nearestDistance === 0) {
    return;
  }

  const pull = ((nearestPocket.pullRadius - nearestDistance) / nearestPocket.pullRadius) ** 2 * 0.38 * scale;
  ball.vx += ((nearestPocket.x - ball.x) / nearestDistance) * pull;
  ball.vy += ((nearestPocket.y - ball.y) / nearestDistance) * pull;
}

function applyWallBounce(ball) {
  if (ball.pocketed) return false;
  let touchedRail = false;

  for (let pass = 0; pass < 2; pass += 1) {
    for (const segment of CUSHION_SEGMENTS) {
      touchedRail = resolveCushionSegment(ball, segment) || touchedRail;
    }
  }

  return touchedRail;
}

function inPocketMouth(ball, pocket) {
  const cornerThreshold = TABLE.cornerPocketMouth + TABLE.rail + TABLE.ballRadius;
  const sideThreshold = TABLE.sideJawDepth + TABLE.ballRadius * 0.9;

  if (pocket.kind === "corner") {
    if (pocket.id === "tl") {
      return ball.x <= TABLE.cornerPocketMouth && ball.y <= TABLE.cornerPocketMouth && ball.x + ball.y <= cornerThreshold;
    }
    if (pocket.id === "tr") {
      return ball.x >= TABLE.width - TABLE.cornerPocketMouth
        && ball.y <= TABLE.cornerPocketMouth
        && (TABLE.width - ball.x) + ball.y <= cornerThreshold;
    }
    if (pocket.id === "bl") {
      return ball.x <= TABLE.cornerPocketMouth
        && ball.y >= TABLE.height - TABLE.cornerPocketMouth
        && ball.x + (TABLE.height - ball.y) <= cornerThreshold;
    }
    return ball.x >= TABLE.width - TABLE.cornerPocketMouth
      && ball.y >= TABLE.height - TABLE.cornerPocketMouth
      && (TABLE.width - ball.x) + (TABLE.height - ball.y) <= cornerThreshold;
  }

  if (pocket.id === "tm") {
    return Math.abs(ball.x - TABLE.width / 2) <= TABLE.sidePocketHalf - 4 && ball.y <= sideThreshold;
  }
  return Math.abs(ball.x - TABLE.width / 2) <= TABLE.sidePocketHalf - 4 && ball.y >= TABLE.height - sideThreshold;
}

function maybePocket(ball) {
  if (ball.pocketed) return false;

  const hitPocket = POCKETS.find(
    (pocket) => Math.hypot(ball.x - pocket.x, ball.y - pocket.y) <= pocket.radius || inPocketMouth(ball, pocket)
  );
  if (!hitPocket) return false;

  ball.x = hitPocket.x;
  ball.y = hitPocket.y;
  ball.pocketed = true;
  ball.vx = 0;
  ball.vy = 0;
  return true;
}

function resolveBallCollision(first, second) {
  if (first.pocketed || second.pocketed) return false;

  let dx = second.x - first.x;
  let dy = second.y - first.y;
  let distance = Math.hypot(dx, dy);
  const minimumDistance = TABLE.ballRadius * 2;

  if (distance >= minimumDistance) return false;
  if (!distance) {
    dx = second.number > first.number ? 0.01 : -0.01;
    dy = 0;
    distance = Math.hypot(dx, dy);
  }

  const nx = dx / distance;
  const ny = dy / distance;
  const tx = -ny;
  const ty = nx;
  const overlap = minimumDistance - distance;
  first.x -= nx * overlap * 0.5;
  first.y -= ny * overlap * 0.5;
  second.x += nx * overlap * 0.5;
  second.y += ny * overlap * 0.5;

  const closingSpeed = (first.vx - second.vx) * nx + (first.vy - second.vy) * ny;
  if (closingSpeed <= 0) return false;

  const firstNormal = first.vx * nx + first.vy * ny;
  const firstTangent = first.vx * tx + first.vy * ty;
  const secondNormal = second.vx * nx + second.vy * ny;
  const secondTangent = second.vx * tx + second.vy * ty;

  first.vx = secondNormal * nx + firstTangent * tx;
  first.vy = secondNormal * ny + firstTangent * ty;
  second.vx = firstNormal * nx + secondTangent * tx;
  second.vy = firstNormal * ny + secondTangent * ty;

  first.vx *= 0.995;
  first.vy *= 0.995;
  second.vx *= 0.995;
  second.vy *= 0.995;
  return true;
}

function validBallPlacement(balls, placement, ignoreNumbers = []) {
  const minX = TABLE.rail + TABLE.ballRadius;
  const maxX = TABLE.width - TABLE.rail - TABLE.ballRadius;
  const minY = TABLE.rail + TABLE.ballRadius;
  const maxY = TABLE.height - TABLE.rail - TABLE.ballRadius;
  const x = clamp(placement?.x, minX, maxX);
  const y = clamp(placement?.y, minY, maxY);
  const ignoreSet = new Set(ignoreNumbers);
  const overlaps = balls.some(
    (ball) => !ball.pocketed && !ignoreSet.has(ball.number) && Math.hypot(ball.x - x, ball.y - y) < TABLE.ballRadius * 2 + 0.2
  );
  const insidePocketShelf = POCKETS.some((pocket) => Math.hypot(pocket.x - x, pocket.y - y) <= pocket.radius + TABLE.ballRadius * 0.8);
  if (overlaps || insidePocketShelf) return null;
  return { x, y };
}

function spotCueBall(balls) {
  const cue = cueBall(balls);
  const defaults = [
    defaultCuePlacement(),
    { x: TABLE.headX - 44, y: TABLE.centerY },
    { x: TABLE.headX, y: TABLE.centerY - 44 },
    { x: TABLE.headX, y: TABLE.centerY + 44 },
    { x: TABLE.headX - 84, y: TABLE.centerY }
  ];
  for (const placement of defaults) {
    const valid = validBallPlacement(balls, placement, [0]);
    if (valid) {
      cue.x = valid.x;
      cue.y = valid.y;
      cue.pocketed = false;
      cue.vx = 0;
      cue.vy = 0;
      return;
    }
  }
  cue.x = defaultCuePlacement().x;
  cue.y = defaultCuePlacement().y;
  cue.pocketed = false;
  cue.vx = 0;
  cue.vy = 0;
}

function spotEightBall(balls) {
  const eight = ballByNumber(balls, 8);
  const target = { x: TABLE.footX, y: TABLE.centerY };
  const valid = validBallPlacement(balls, target, [8]) || target;
  eight.x = valid.x;
  eight.y = valid.y;
  eight.pocketed = false;
  eight.vx = 0;
  eight.vy = 0;
}

function simulateShot(room, shot) {
  const balls = room.balls.map(cloneBall);
  const cue = cueBall(balls);

  if (room.ballInHandPlayerIndex === room.currentTurn) {
    const placement = validBallPlacement(balls, shot.cuePlacement, [0]);
    if (!placement) {
      throw new Error("Place the cue ball somewhere clear on the table before shooting.");
    }
    cue.x = placement.x;
    cue.y = placement.y;
    cue.pocketed = false;
    cue.vx = 0;
    cue.vy = 0;
  }

  const vector = normalizeVector(shot.dx, shot.dy);
  if (!vector) {
    throw new Error("That shot had no direction.");
  }

  const power = clamp(shot.power, 0.18, 1);
  cue.vx = vector.x * (power * 32);
  cue.vy = vector.y * (power * 32);

  const trace = [];
  const pocketedNumbers = new Set();
  const railTouchNumbers = new Set();
  let firstHitNumber = null;
  let cuePocketed = false;
  let eightPocketed = false;
  let railAfterContact = false;

  captureTraceFrame(trace, balls, true);

  for (let step = 0; step < MAX_SIMULATION_STEPS; step += 1) {
    const movingBalls = activeBalls(balls);
    const maxSpeed = movingBalls.reduce((largest, ball) => Math.max(largest, Math.hypot(ball.vx, ball.vy)), 0);
    const substeps = Math.min(Math.max(Math.ceil(maxSpeed / (TABLE.ballRadius * 0.45)), 1), 6);
    const subFriction = FRICTION ** (1 / substeps);

    for (let substep = 0; substep < substeps; substep += 1) {
      for (const ball of activeBalls(balls)) {
        ball.x += ball.vx / substeps;
        ball.y += ball.vy / substeps;
        applyPocketGravity(ball, 1 / substeps);
        if (maybePocket(ball)) {
          pocketedNumbers.add(ball.number);
          if (ball.number === 0) cuePocketed = true;
          if (ball.number === 8) eightPocketed = true;
          if (firstHitNumber != null && ball.number !== 0) {
            railAfterContact = true;
          }
          continue;
        }

        ball.vx *= subFriction;
        ball.vy *= subFriction;

        if (Math.abs(ball.vx) < 0.012) ball.vx = 0;
        if (Math.abs(ball.vy) < 0.012) ball.vy = 0;

        const hitRail = applyWallBounce(ball);
        if (hitRail) {
          if (ball.number !== 0) {
            railTouchNumbers.add(ball.number);
          }
          if (firstHitNumber != null) {
            railAfterContact = true;
          }
        }

        if (maybePocket(ball)) {
          pocketedNumbers.add(ball.number);
          if (ball.number === 0) cuePocketed = true;
          if (ball.number === 8) eightPocketed = true;
          if (firstHitNumber != null && ball.number !== 0) {
            railAfterContact = true;
          }
        }
      }

      for (let firstIndex = 0; firstIndex < balls.length; firstIndex += 1) {
        const first = balls[firstIndex];
        if (first.pocketed) continue;

        for (let secondIndex = firstIndex + 1; secondIndex < balls.length; secondIndex += 1) {
          const second = balls[secondIndex];
          if (second.pocketed) continue;

          const collided = resolveBallCollision(first, second);
          if (!collided || firstHitNumber != null) continue;

          if (first.number === 0 && second.number !== 0) {
            firstHitNumber = second.number;
          } else if (second.number === 0 && first.number !== 0) {
            firstHitNumber = first.number;
          }
        }
      }
    }

    if (step % TRACE_SAMPLE_STEPS === 0) {
      captureTraceFrame(trace, balls);
    }

    if (totalSpeed(balls) < 0.03) {
      break;
    }
  }

  for (const ball of balls) {
    ball.vx = 0;
    ball.vy = 0;
  }
  captureTraceFrame(trace, balls, true);

  return {
    balls,
    trace,
    firstHitNumber,
    pocketedNumbers: [...pocketedNumbers],
    cuePocketed,
    eightPocketed,
    objectRailCount: railTouchNumbers.size,
    railAfterContact
  };
}

function foulReasonForFirstHit(room, shooterIndex, firstHitNumber) {
  const targetGroup = playerGroup(room, shooterIndex);
  const canShootEight = playerCanShootEight(room, shooterIndex);

  if (room.breakShot) {
    if (!firstHitNumber) return "No object ball was struck.";
    return null;
  }

  if (!firstHitNumber) {
    return "No object ball was struck.";
  }

  if (!targetGroup) {
    return firstHitNumber === 8 ? "On an open table you must not strike the 8 ball first." : null;
  }

  if (canShootEight) {
    return firstHitNumber === 8 ? null : "You were on the 8 ball and had to strike it first.";
  }

  return groupForNumber(firstHitNumber) === targetGroup ? null : `You had to strike your ${targetGroup} first.`;
}

function assignGroupsIfNeeded(room, shooterIndex, pocketedNumbers, foul, wasBreakShot) {
  if (foul || wasBreakShot || room.playerGroups.some(Boolean)) return null;

  const solidsPocketed = pocketedNumbers.filter((number) => groupForNumber(number) === "solids");
  const stripesPocketed = pocketedNumbers.filter((number) => groupForNumber(number) === "stripes");

  if (solidsPocketed.length && !stripesPocketed.length) {
    room.playerGroups[shooterIndex] = "solids";
    room.playerGroups[1 - shooterIndex] = "stripes";
    return "solids";
  }

  if (stripesPocketed.length && !solidsPocketed.length) {
    room.playerGroups[shooterIndex] = "stripes";
    room.playerGroups[1 - shooterIndex] = "solids";
    return "stripes";
  }

  return null;
}

function breakMessage(room, shooterIndex, result, foulReasons) {
  if (result.eightPocketed && result.cuePocketed) {
    return `${room.players[shooterIndex].name} scratched while sinking the 8 on the break. The 8 is spotted and ball-in-hand goes over.`;
  }
  if (result.eightPocketed) {
    return `${room.players[shooterIndex].name} dropped the 8 on the break. The 8 is spotted and the break continues.`;
  }
  if (foulReasons.length) {
    return `${room.players[shooterIndex].name} fouled on the break.`;
  }
  if (!result.pocketedNumbers.some((number) => number !== 0)) {
    return `${room.players[shooterIndex].name} came up dry on the break.`;
  }
  return `${room.players[shooterIndex].name} opened the table on the break.`;
}

function finalizeShot(room, shooterIndex, result) {
  const opponentIndex = shooterIndex === 0 ? 1 : 0;
  const pocketedNumbers = result.pocketedNumbers.filter((number) => number !== 0);
  const wasBreakShot = room.breakShot;
  const foulReasons = [];
  const firstHitFoul = foulReasonForFirstHit(room, shooterIndex, result.firstHitNumber);
  if (firstHitFoul) foulReasons.push(firstHitFoul);
  if (result.cuePocketed) foulReasons.push("Cue ball scratch.");
  if (wasBreakShot) {
    if (!pocketedNumbers.length && result.objectRailCount < 4) {
      foulReasons.push("Break did not drive four object balls to a rail.");
    }
  } else if (!pocketedNumbers.length && !result.railAfterContact) {
    foulReasons.push("A ball had to reach a rail after contact.");
  }

  const assignedGroup = assignGroupsIfNeeded(room, shooterIndex, pocketedNumbers, foulReasons.length > 0, wasBreakShot);
  const shooterGroup = playerGroup(room, shooterIndex);
  const canShootEightBeforeResolution = playerCanShootEight(room, shooterIndex);
  const pocketedEight = pocketedNumbers.includes(8);
  let legalEight = false;

  if (pocketedEight) {
    if (wasBreakShot) {
      spotEightBall(result.balls);
    } else {
      const eightLegal = Boolean(shooterGroup) && canShootEightBeforeResolution && result.firstHitNumber === 8 && !result.cuePocketed;
      legalEight = eightLegal;
      if (!eightLegal) {
        foulReasons.push("The 8 ball was pocketed illegally.");
      }
    }
  }

  room.breakShot = false;

  room.lastShot = {
    byPlayerIndex: shooterIndex,
    foul: foulReasons.length > 0,
    foulReasons,
    pocketedNumbers: [...pocketedNumbers],
    assignedGroup,
    retainedTurn: false,
    legalEight,
    firstHitNumber: result.firstHitNumber
  };

  if (legalEight) {
    room.status = "finished";
    room.winnerIndex = shooterIndex;
    room.message = `${room.players[shooterIndex].name} cleared the table and sank the 8 for the win.`;
    room.balls = result.balls;
    room.trace = result.trace;
    room.shotId += 1;
    room.ballInHandPlayerIndex = null;
    touchRoom(room);
    return;
  }

  if (pocketedEight && !legalEight && !wasBreakShot) {
    room.status = "finished";
    room.winnerIndex = opponentIndex;
    room.message = `${room.players[shooterIndex].name} lost by pocketing the 8 illegally.`;
    room.balls = result.balls;
    room.trace = result.trace;
    room.shotId += 1;
    room.ballInHandPlayerIndex = null;
    touchRoom(room);
    return;
  }

  if (result.cuePocketed) {
    spotCueBall(result.balls);
  }

  const ownGroupPocketed = shooterGroup
    ? pocketedNumbers.some((number) => groupForNumber(number) === shooterGroup)
    : pocketedNumbers.some((number) => ["solids", "stripes"].includes(groupForNumber(number)));
  const openTableContinues = !shooterGroup && pocketedNumbers.some((number) => ["solids", "stripes"].includes(groupForNumber(number)));

  let retainTurn = false;
  if (!foulReasons.length) {
    if (shooterGroup) {
      retainTurn = ownGroupPocketed;
    } else {
      retainTurn = openTableContinues;
    }
  }

  room.currentTurn = retainTurn ? shooterIndex : opponentIndex;
  room.ballInHandPlayerIndex = foulReasons.length ? opponentIndex : null;
  room.lastShot.retainedTurn = retainTurn;
  room.inning += retainTurn ? 0 : 1;
  room.balls = result.balls;
  room.trace = result.trace;
  room.shotId += 1;

  if (wasBreakShot) {
    room.message = breakMessage(room, shooterIndex, result, foulReasons);
  } else if (foulReasons.length) {
    room.message = `${room.players[shooterIndex].name} fouled. ${room.players[opponentIndex].name} has ball in hand.`;
  } else if (assignedGroup) {
    room.message = `${room.players[shooterIndex].name} claimed ${assignedGroup} and ${retainTurn ? "keeps shooting." : "passes the turn."}`;
  } else if (retainTurn) {
    room.message = `${room.players[shooterIndex].name} pockets a ball and keeps the table.`;
  } else if (pocketedNumbers.length) {
    room.message = `${room.players[shooterIndex].name} pockets a ball but the turn passes.`;
  } else {
    room.message = `${room.players[opponentIndex].name}'s turn.`;
  }

  touchRoom(room);
}

function shootRoom(code, token, shot) {
  const room = roomByCode(code);
  if (!room) {
    throw new Error("That room code does not exist anymore.");
  }

  const shooterIndex = playerIndexFor(room, token);
  if (shooterIndex < 0) {
    throw new Error("You are not part of this room.");
  }
  if (room.players.length < 2 || room.status !== "active") {
    throw new Error("The table is not ready yet.");
  }
  if (room.currentTurn !== shooterIndex) {
    throw new Error("It is not your turn yet.");
  }

  const result = simulateShot(room, shot);
  finalizeShot(room, shooterIndex, result);
  return stateForClient(room, token);
}

function resetRoom(code, token) {
  const room = roomByCode(code);
  if (!room) {
    throw new Error("That room code does not exist anymore.");
  }

  const playerIndex = playerIndexFor(room, token);
  if (playerIndex < 0) {
    throw new Error("You are not part of this room.");
  }

  room.status = room.players.length >= 2 ? "active" : "waiting";
  room.currentTurn = room.players.length >= 2 ? Math.floor(Math.random() * room.players.length) : 0;
  room.winnerIndex = -1;
  room.message = room.players.length >= 2
    ? `${room.players[room.currentTurn].name} breaks first.`
    : "Waiting for another Chipkittle to join the table.";
  room.balls = createRackState();
  room.playerGroups = [null, null];
  room.breakShot = true;
  room.ballInHandPlayerIndex = null;
  room.inning = 1;
  room.trace = [];
  room.shotId += 1;
  room.lastShot = {
    byPlayerIndex: -1,
    foul: false,
    foulReasons: [],
    pocketedNumbers: [],
    assignedGroup: null,
    retainedTurn: false,
    legalEight: false,
    firstHitNumber: null
  };
  touchRoom(room);
  return stateForClient(room, token);
}

export {
  createInitialRoom as createEightBallRoom,
  getRoomState as getEightBallRoomState,
  joinRoom as joinEightBallRoom,
  resetRoom as resetEightBallRoom,
  shootRoom as shootEightBall,
  TABLE as EIGHT_BALL_TABLE
};
