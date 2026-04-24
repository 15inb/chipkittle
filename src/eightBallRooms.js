import crypto from "node:crypto";

const ROOM_TTL_MS = 1000 * 60 * 60 * 4;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TABLE = {
  width: 1000,
  height: 560,
  ballRadius: 16,
  pocketRadius: 32
};
const CUE_START = { x: 250, y: 280 };
const EIGHT_START = { x: 735, y: 280 };
const POCKETS = [
  { x: 24, y: 24 },
  { x: TABLE.width / 2, y: 18 },
  { x: TABLE.width - 24, y: 24 },
  { x: 24, y: TABLE.height - 24 },
  { x: TABLE.width / 2, y: TABLE.height - 18 },
  { x: TABLE.width - 24, y: TABLE.height - 24 }
];

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

function createBall(position) {
  return {
    x: position.x,
    y: position.y,
    vx: 0,
    vy: 0,
    pocketed: false
  };
}

function createRackState() {
  return {
    cue: createBall(CUE_START),
    eight: createBall(EIGHT_START)
  };
}

function cloneBall(ball) {
  return {
    x: Number(ball.x) || 0,
    y: Number(ball.y) || 0,
    vx: Number(ball.vx) || 0,
    vy: Number(ball.vy) || 0,
    pocketed: Boolean(ball.pocketed)
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
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

function stateForClient(room, token = "") {
  const selfPlayerIndex = playerIndexFor(room, token);
  return {
    roomCode: room.code,
    status: room.status,
    players: room.players.map((player, index) => ({
      name: player.name,
      index
    })),
    selfPlayerIndex,
    currentTurn: room.currentTurn,
    winnerIndex: room.winnerIndex,
    message: room.message,
    table: TABLE,
    balls: {
      cue: cloneBall(room.balls.cue),
      eight: cloneBall(room.balls.eight)
    },
    shotId: room.shotId,
    trace: room.trace.map((frame) => ({
      cue: frame.cue ? cloneBall(frame.cue) : null,
      eight: frame.eight ? cloneBall(frame.eight) : null
    })),
    updatedAt: new Date(room.updatedAt).toISOString()
  };
}

function createRoomInternal(playerName) {
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
    shotId: 0,
    trace: []
  };

  rooms.set(code, room);
  return {
    token,
    state: stateForClient(room, token)
  };
}

function joinRoomInternal(code, playerName) {
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
  room.currentTurn = Math.floor(Math.random() * room.players.length);
  room.winnerIndex = -1;
  room.message = `${room.players[room.currentTurn].name} breaks first.`;
  room.balls = createRackState();
  room.trace = [];
  room.shotId += 1;
  touchRoom(room);

  return {
    token,
    state: stateForClient(room, token)
  };
}

function getRoomState(code, token) {
  const room = roomByCode(code);
  if (!room) {
    throw new Error("That room code does not exist anymore.");
  }
  touchRoom(room);
  return stateForClient(room, token);
}

function pushTrace(trace, cue, eight) {
  trace.push({
    cue: cue.pocketed ? null : cloneBall(cue),
    eight: eight.pocketed ? null : cloneBall(eight)
  });
}

function normalizeVector(dx, dy) {
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  return {
    x: dx / length,
    y: dy / length
  };
}

function applyWallBounce(ball) {
  if (ball.pocketed) return;
  const minX = TABLE.ballRadius;
  const maxX = TABLE.width - TABLE.ballRadius;
  const minY = TABLE.ballRadius;
  const maxY = TABLE.height - TABLE.ballRadius;

  if (ball.x <= minX) {
    ball.x = minX;
    ball.vx = Math.abs(ball.vx) * 0.94;
  } else if (ball.x >= maxX) {
    ball.x = maxX;
    ball.vx = -Math.abs(ball.vx) * 0.94;
  }

  if (ball.y <= minY) {
    ball.y = minY;
    ball.vy = Math.abs(ball.vy) * 0.94;
  } else if (ball.y >= maxY) {
    ball.y = maxY;
    ball.vy = -Math.abs(ball.vy) * 0.94;
  }
}

function maybePocket(ball) {
  if (ball.pocketed) return false;
  const hitPocket = POCKETS.some((pocket) => Math.hypot(ball.x - pocket.x, ball.y - pocket.y) <= TABLE.pocketRadius);
  if (!hitPocket) return false;
  ball.pocketed = true;
  ball.vx = 0;
  ball.vy = 0;
  return true;
}

function resolveBallCollision(first, second) {
  if (first.pocketed || second.pocketed) return false;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  const minimumDistance = TABLE.ballRadius * 2;
  if (!distance || distance >= minimumDistance) return false;

  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minimumDistance - distance;
  first.x -= nx * overlap * 0.5;
  first.y -= ny * overlap * 0.5;
  second.x += nx * overlap * 0.5;
  second.y += ny * overlap * 0.5;

  const tx = -ny;
  const ty = nx;
  const firstNormal = first.vx * nx + first.vy * ny;
  const firstTangent = first.vx * tx + first.vy * ty;
  const secondNormal = second.vx * nx + second.vy * ny;
  const secondTangent = second.vx * tx + second.vy * ty;

  first.vx = secondNormal * nx + firstTangent * tx;
  first.vy = secondNormal * ny + firstTangent * ty;
  second.vx = firstNormal * nx + secondTangent * tx;
  second.vy = firstNormal * ny + secondTangent * ty;

  first.vx *= 0.992;
  first.vy *= 0.992;
  second.vx *= 0.992;
  second.vy *= 0.992;
  return true;
}

function ballSpeed(ball) {
  return ball.pocketed ? 0 : Math.hypot(ball.vx, ball.vy);
}

function simulateShot(balls, shot) {
  const cue = cloneBall(balls.cue);
  const eight = cloneBall(balls.eight);
  const vector = normalizeVector(shot.dx, shot.dy);
  if (!vector) {
    throw new Error("That shot had no direction.");
  }

  const power = clamp(shot.power, 0.18, 1);
  cue.vx = vector.x * (power * 23);
  cue.vy = vector.y * (power * 23);
  const trace = [];
  let cuePocketed = false;
  let eightPocketed = false;

  pushTrace(trace, cue, eight);

  for (let step = 0; step < 340; step += 1) {
    if (!cue.pocketed) {
      cue.x += cue.vx;
      cue.y += cue.vy;
      cue.vx *= 0.988;
      cue.vy *= 0.988;
      applyWallBounce(cue);
      if (maybePocket(cue)) cuePocketed = true;
    }

    if (!eight.pocketed) {
      eight.x += eight.vx;
      eight.y += eight.vy;
      eight.vx *= 0.988;
      eight.vy *= 0.988;
      applyWallBounce(eight);
      if (maybePocket(eight)) eightPocketed = true;
    }

    resolveBallCollision(cue, eight);

    if (Math.abs(cue.vx) < 0.025) cue.vx = 0;
    if (Math.abs(cue.vy) < 0.025) cue.vy = 0;
    if (Math.abs(eight.vx) < 0.025) eight.vx = 0;
    if (Math.abs(eight.vy) < 0.025) eight.vy = 0;

    if (step % 2 === 0) {
      pushTrace(trace, cue, eight);
    }

    if (ballSpeed(cue) + ballSpeed(eight) < 0.03) {
      break;
    }
  }

  if (cuePocketed && !eightPocketed) {
    cue.pocketed = false;
    cue.x = CUE_START.x;
    cue.y = CUE_START.y;
  }

  cue.vx = 0;
  cue.vy = 0;
  eight.vx = 0;
  eight.vy = 0;
  pushTrace(trace, cue, eight);

  return {
    cue,
    eight,
    cuePocketed,
    eightPocketed,
    trace
  };
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

  const result = simulateShot(room.balls, shot);
  room.balls = {
    cue: result.cue,
    eight: result.eight
  };
  room.trace = result.trace;
  room.shotId += 1;

  const otherIndex = shooterIndex === 0 ? 1 : 0;
  if (result.eightPocketed && result.cuePocketed) {
    room.status = "finished";
    room.winnerIndex = otherIndex;
    room.message = `${room.players[shooterIndex].name} scratched on the 8 ball. ${room.players[otherIndex].name} wins.`;
  } else if (result.eightPocketed) {
    room.status = "finished";
    room.winnerIndex = shooterIndex;
    room.message = `${room.players[shooterIndex].name} sank the 8 ball and won the table.`;
  } else {
    room.currentTurn = otherIndex;
    room.message = result.cuePocketed
      ? `${room.players[shooterIndex].name} scratched. ${room.players[otherIndex].name} shoots next.`
      : `${room.players[otherIndex].name}'s turn.`;
  }

  touchRoom(room);
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

  room.balls = createRackState();
  room.trace = [];
  room.shotId += 1;
  room.winnerIndex = -1;
  room.status = room.players.length >= 2 ? "active" : "waiting";
  room.currentTurn = room.players.length >= 2 ? Math.floor(Math.random() * room.players.length) : 0;
  room.message = room.players.length >= 2
    ? `${room.players[room.currentTurn].name} breaks first.`
    : "Waiting for another Chipkittle to join the table.";
  touchRoom(room);
  return stateForClient(room, token);
}

export {
  createRoomInternal as createEightBallRoom,
  getRoomState as getEightBallRoomState,
  joinRoomInternal as joinEightBallRoom,
  resetRoom as resetEightBallRoom,
  shootRoom as shootEightBall,
  TABLE as EIGHT_BALL_TABLE
};
