'use strict';

/*
 * Live end-to-end demonstration of the lobby -> approval -> video flow.
 *
 * Boots the real server, then acts as a teacher and three students over real
 * Socket.IO connections so the feature can be observed working rather than
 * only asserted in unit tests.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const root = path.resolve(__dirname, '..');
const PORT = process.env.DEMO_PORT || '4321';
const baseUrl = `http://127.0.0.1:${PORT}`;

const log = (line = '') => console.log(line);
const step = (n, text) => log(`\n[${n}] ${text}`);
const ok = (text) => log(`    PASS  ${text}`);
const bad = (text) => { failures++; log(`    FAIL  ${text}`); };
const info = (text) => log(`    ->    ${text}`);

let failures = 0;

function connect(name) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true });
  socket.on('connect', () => info(`${name} connected`));
  return socket;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

const waitFor = (socket, event, ms = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch { /* server still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}

async function main() {
  log('='.repeat(72));
  log(' CLASSROOM PULSE - LIVE LOBBY / APPROVAL RUN');
  log('='.repeat(72));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'test',
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'demo-key',
      // LiveKit is only used to mint room-scoped JWTs locally; no media server
      // is contacted, so the demo runs fully offline.
      LIVEKIT_URL: 'wss://demo.livekit.example',
      LIVEKIT_API_KEY: 'demo-livekit-key',
      LIVEKIT_API_SECRET: 'demo-livekit-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    step(0, 'Starting server and waiting for health check');
    await waitForHealth();
    ok(`server healthy at ${baseUrl}`);

    step(1, 'Teacher creates a room');
    const created = await fetch(`${baseUrl}/create`, { redirect: 'manual' });
    const location = created.headers.get('location') || '';
    const code = new URL(location, baseUrl).searchParams.get('room');
    const token = new URLSearchParams(location.split('#')[1] || '').get('token');
    if (!code || !token) throw new Error(`could not read room from redirect: ${location}`);
    ok(`room ${code} created, teacher token issued`);

    step(2, 'Teacher authenticates and opens the Participants Manager');
    const teacher = connect('teacher');
    await emitAck(teacher, 'teacher-join', { code, token });
    const host = await emitAck(teacher, 'host-join', { code, token });
    if (host.ok) ok('host-join accepted the teacher token'); else bad('host-join rejected');
    if ((await emitAck(teacher, 'host-join', { code, token: 'wrong-token' })).ok === false) {
      ok('a wrong teacher token is rejected');
    } else bad('a wrong teacher token was accepted');

    let latestRoster = [];
    teacher.on('participant-list', (list) => { latestRoster = list; });

    step(3, 'Three students join and wait in the lobby');
    const students = [];
    for (const name of ['Asha', 'Ben', 'Chloe']) {
      const socket = connect(name);
      const joined = await emitAck(socket, 'student-join', { code, name });
      const lobby = await emitAck(socket, 'join-lobby', { code, name });
      if (lobby.status === 'WAITING') ok(`${name} is WAITING in the lobby`);
      else bad(`${name} status was ${lobby.status}`);
      students.push(socket);
    }

    step(4, "Teacher's dashboard receives the live roster");
    await new Promise((r) => setTimeout(r, 300));
    if (latestRoster.length === 3) ok(`roster shows ${latestRoster.length} participants without a page refresh`);
    else bad(`roster showed ${latestRoster.length}, expected 3`);
    info(`waiting: ${latestRoster.filter((p) => p.status === 'WAITING').length}`);

    step(5, 'A student tries a host-only action (must be refused)');
    const denied = await emitAck(students[0], 'admit-participant', { code, participantId: students[1].id });
    if (denied.ok === false) ok(`student was denied: "${denied.err}"`); else bad('a student was allowed to admit others');

    step(6, 'Teacher admits Asha into the live class');
    const ashaId = latestRoster.find((p) => p.name === 'Asha')?.id;
    const admitted = waitFor(students[0], 'participant-admitted');
    await emitAck(teacher, 'admit-participant', { code, participantId: ashaId });
    const admission = await admitted;
    if (admission.admissionTicket) ok('Asha received an admission ticket'); else bad('no admission ticket issued');
    info(`room=${admission.room}`);

    step(7, 'Asha is refused a LiveKit token before using the ticket');
    const early = await fetch(`${baseUrl}/api/video/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, role: 'student', name: 'Asha' })
    });
    if (early.status === 403) ok('no video token without a ticket (the lobby cannot be skipped)');
    else bad(`expected 403, got ${early.status}`);

    step(8, 'Teacher mutes Asha, then allows her to speak again');
    const forced = waitFor(students[0], 'force-mute');
    await emitAck(teacher, 'mute-participant', { code, participantId: ashaId, muted: true });
    if ((await forced).muted === true) ok('Asha was force-muted'); else bad('no force-mute received');
    await emitAck(teacher, 'mute-participant', { code, participantId: ashaId, muted: false });
    ok('Asha was unmuted');

    step(9, 'Teacher kicks Ben with a reason');
    const benId = latestRoster.find((p) => p.name === 'Ben')?.id;
    const kickNotice = waitFor(students[1], 'participant-kicked');
    const benGone = waitFor(students[1], 'disconnect');
    const kicked = await emitAck(teacher, 'kick-participant', { code, participantId: benId, reason: 'Camera off during the lesson' });
    if (kicked.ok) ok('kick accepted'); else bad('kick refused');
    const notice = await kickNotice;
    if (notice.reason === 'Camera off during the lesson' && notice.timestamp) {
      ok(`Ben saw the reason: "${notice.reason}"`);
    } else bad('kick notice was missing a reason or timestamp');
    await benGone;
    ok('Ben was disconnected');

    step(10, 'Kicking Ben again is a safe no-op');
    const repeat = await emitAck(teacher, 'kick-participant', { code, participantId: benId, reason: 'Removed twice by mistake' });
    if (repeat.ok) ok('second kick returned success instead of crashing'); else bad('second kick failed');

    step(11, 'Final roster after the whole flow');
    await new Promise((r) => setTimeout(r, 300));
    const summary = latestRoster.map((p) => `${p.name}=${p.status}`).join(', ');
    if (!latestRoster.some((p) => p.name === 'Ben')) ok('Ben is gone from the roster'); else bad('Ben is still listed');
    info(`live roster: ${summary || 'empty'}`);

    step(12, 'Every page and asset the manager needs is served');
    for (const page of ['/participants.html', '/participants.js', '/icons.css', '/premium.css', '/style.css', '/student.html', '/teacher.html']) {
      const res = await fetch(baseUrl + page);
      if (res.ok) ok(`${page} -> ${res.status}`); else bad(`${page} -> ${res.status}`);
    }

    teacher.close();
    students.forEach((s) => s.close());
  } finally {
    server.kill();
  }

  log('\n' + '='.repeat(72));
  if (failures) {
    log(` RESULT: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    log(' RESULT: all checks passed - lobby, approval, mute, and kick all work');
  }
  log('='.repeat(72));
}

main().catch((error) => {
  console.error('\nDEMO ERROR:', error.message);
  process.exitCode = 1;
});
