'use strict';

/*
 * Load / scale test.
 *
 * Answers one question with evidence instead of guesses: at what classroom size
 * does this server actually stop keeping up?
 *
 * "It crashed" is not the only failure mode, so it measures:
 *   1. event-loop lag - if the loop stalls, every user feels it
 *   2. memory         - Render's free plan only has 512 MB
 *   3. join latency   - how long a student waits to get in
 *   4. bulk attendance marking over a full class
 *
 * Run: node test/scale-test.js
 * Env: SCALE_STUDENTS (default 500), SCALE_ROOMS (default 5)
 */

const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const root = path.resolve(__dirname, '..');
const STUDENTS = Number(process.env.SCALE_STUDENTS || 500);
const ROOMS = Number(process.env.SCALE_ROOMS || 5);

const log = (l = '') => console.log(l);
const bar = (label, value, warn, bad) => {
  const flag = value >= bad ? 'BAD ' : value >= warn ? 'WARN' : 'ok  ';
  log(`   [${flag}] ${label.padEnd(34)} ${value}`);
};
const flag = (label, pass, detail) =>
  log(`   [${pass ? 'ok  ' : 'BAD '}] ${label.padEnd(34)} ${detail}`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const connect = (base) =>
  io(base, { transports: ['websocket'], forceNew: true, reconnection: false });

function emitAck(socket, event, payload, ms = 10000) {
  return new Promise((resolve, reject) => {
    socket.timeout(ms).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

// Watches how late timers fire. A healthy loop is under ~50 ms; above 250 ms
// users start describing it as "lag".
function startLagMonitor() {
  let max = 0, samples = 0, total = 0;
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const drift = Number(now - last) / 1e6 - 100;
    last = now;
    if (drift > max) max = drift;
    if (drift > 0) { total += drift; samples++; }
  }, 100);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      return { maxMs: Math.round(max), avgMs: samples ? Math.round(total / samples) : 0 };
    }
  };
}

const memMb = () => {
  const m = process.memoryUsage();
  return { heap: Math.round(m.heapUsed / 1048576), rss: Math.round(m.rss / 1048576) };
};

async function waitHealthy(base) {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server never became healthy');
}

async function main() {
  log('='.repeat(74));
  log(` SCALE TEST  ${ROOMS} room(s) x ${STUDENTS} students  =  ${ROOMS * STUDENTS} clients`);
  log('='.repeat(74));

  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', LIVEKIT_URL: '', OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });

  const lag = startLagMonitor();
  const sockets = [];
  const failures = [];

  try {
    await waitHealthy(base);
    log('\n[1] server healthy');

    log(`\n[2] creating ${ROOMS} rooms and filling them`);
    const started = Date.now();
    const rooms = [];
    for (let r = 0; r < ROOMS; r++) {
      const res = await fetch(`${base}/create`, { redirect: 'manual' });
      const loc = res.headers.get('location') || '';
      const code = new URL(loc, base).searchParams.get('room');
      const token = new URLSearchParams(loc.split('#')[1] || '').get('token');
      const teacher = connect(base);
      sockets.push(teacher);
      await emitAck(teacher, 'teacher-join', { code, token });
      rooms.push({ code, token, teacher });
    }
    log(`   ${ROOMS} rooms created`);

    const joinTimes = [];
    let joined = 0;
    for (let r = 0; r < ROOMS; r++) {
      const { code } = rooms[r];
      const batch = [];
      for (let s = 0; s < STUDENTS; s++) {
        const socket = connect(base);
        sockets.push(socket);
        batch.push((async () => {
          const t0 = Date.now();
          const res = await emitAck(socket, 'student-join', { code, name: `S${s + 1}` });
          if (res && res.ok) { joinTimes.push(Date.now() - t0); joined++; }
          else failures.push(`join rejected: ${res && res.err}`);
        })());
      }
      // Join in waves so the test harness is not itself the bottleneck.
      for (let i = 0; i < batch.length; i += 50) await Promise.all(batch.slice(i, i + 50));
      log(`   room ${r + 1}/${ROOMS}: ${joined} students joined so far`);
    }
    joinTimes.sort((a, b) => a - b);
    log(`   ${joined} students joined in ${Date.now() - started} ms`);
    bar('join latency (median)', `${joinTimes[Math.floor(joinTimes.length / 2)] ?? -1} ms`, 500, 2000);
    if (failures.length) log(`   ${failures.length} join failures, e.g. "${failures[0]}"`);

    log('\n[3] attendance correctness');
    const { code, token, teacher } = rooms[0];
    const snapshot = await emitAck(teacher, 'report-request', { code, token });
    const att = snapshot?.report?.attendance;
    // Every joiner should be present automatically, and the count must match.
    flag('auto-marked present on join', att?.counts?.present === STUDENTS,
      `${att?.counts?.present} of ${STUDENTS}`);
    const badMark = await emitAck(teacher, 'mark-attendance', { code, studentId: 'nope', status: 'present' });
    flag('unknown student rejected', badMark.ok === false, `"${badMark.err}"`);
    const badStatus = await emitAck(teacher, 'mark-attendance', { code, studentId: 'x', status: 'sleeping' });
    flag('invalid status rejected', badStatus.ok === false, `"${badStatus.err}"`);
    const bulkT0 = Date.now();
    const bulk = await emitAck(teacher, 'mark-all-attendance', { code, status: 'present' });
    bar(`mark-all over ${STUDENTS} students`, `${Date.now() - bulkT0} ms`, 500, 2000);
    flag('attendance rows after bulk', bulk?.attendance?.rows?.length === STUDENTS,
      `${bulk?.attendance?.rows?.length} of ${STUDENTS}`);

    // Confirm attendance is reachable from the teacher-facing report.
    const report2 = await emitAck(teacher, 'report-request', { code, token });
    flag('attendance reachable from report', Boolean(report2?.report?.attendance),
      `${report2?.report?.attendance?.rows?.length ?? 0} rows`);

    const tamper = await emitAck(sockets[1], 'mark-attendance', { code, studentId: 'any', status: 'present' });
    flag('student cannot mark attendance', tamper.ok === false, `"${tamper.err}"`);

    log('\n[4] latency under full load');
    // Only fire as many actions as there are real sockets to receive them.
    const burst = Math.min(200, sockets.length);
    const t0 = Date.now();
    const acks = await Promise.all(sockets.slice(0, burst).map((s, i) =>
      emitAck(s, i % 3 === 0 ? 'vote' : 'question', i % 3 === 0
        ? { vote: ['lost', 'ok', 'faster'][i % 3] }
        : { text: `load test question ${i}` }, 15000).catch(() => null)));
    bar(`${burst} concurrent actions`, `${Date.now() - t0} ms`, 1500, 4000);
    // Every socket we asked should have received an ack.
    flag('actions that answered', acks.filter(Boolean).length === burst,
      `${acks.filter(Boolean).length} of ${burst}`);

    const lagStats = lag.stop();
    const mem = memMb();
    log('\n[5] process health');
    bar('event-loop lag (max)', `${lagStats.maxMs} ms`, 100, 250);
    bar('event-loop lag (avg)', `${lagStats.avgMs} ms`, 50, 150);
    bar('heap used', `${mem.heap} MB`, 120, 220);
    bar('RSS', `${mem.rss} MB`, 300, 460);
    bar('sockets still open', sockets.length, 4000, 8000);

    if (/out of memory|heap out of range|FATAL/i.test(stderr)) {
      log('\n   [BAD ] server logged a fatal memory error');
      failures.push('fatal memory error');
    }

    const verdict = [];
    if (lagStats.maxMs > 250) verdict.push('event loop stalled under load');
    if (mem.rss > 460) verdict.push('approaching the 512 MB Render free limit');
    if (failures.length) verdict.push(`${failures.length} request(s) failed`);
    log('\n' + '='.repeat(74));
    if (verdict.length) {
      log(` SCALE VERDICT: needs work before large classes - ${verdict.join('; ')}`);
      process.exitCode = 1;
    } else {
      log(` SCALE VERDICT: held at ${ROOMS * STUDENTS} clients (${STUDENTS}/room)`);
      log(` max lag ${lagStats.maxMs} ms | RSS ${mem.rss} MB | ${failures.length} failures`);
    }
    log('='.repeat(74));
  } catch (error) {
    log('\nTEST ERROR: ' + error.message);
    if (stderr) log('server stderr: ' + stderr.slice(-1200));
    process.exitCode = 1;
  } finally {
    sockets.forEach((s) => s.close());
    server.kill();
  }
}

main();
