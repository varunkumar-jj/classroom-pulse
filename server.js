const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100 * 1024 });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/qr-scanner/qr-scanner.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'qr-scanner', 'qr-scanner.min.js'));
});
app.get('/vendor/qr-scanner/qr-scanner-worker.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'qr-scanner', 'qr-scanner-worker.min.js'));
});

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
if (Boolean(vapidPublicKey) !== Boolean(vapidPrivateKey)) {
  throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must both be configured.');
}
if (vapidPublicKey) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    vapidPublicKey,
    vapidPrivateKey
  );
}

/* ===================== config ===================== */
const CODE_LEN = 4;
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VOTE_OPTIONS = ['lost', 'ok', 'faster'];
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;       // 12 hours
const REEVAL_WINDOW_MS = 45 * 1000;            // 45s
const QUESTION_COOLDOWN_MS = 20 * 1000;        // 20s
const MAX_QUESTION_LEN = 140;
const MAX_TOPICS = 30;
const MAX_ROOMS = 100;
const MAX_STUDENTS_PER_ROOM = 500;
const MAX_QUESTIONS_PER_ROOM = 200;
const MAX_HISTORY_PER_ROOM = 2000;
const MAX_EVENTS_PER_ROOM = 200;

/* ===================== helpers ===================== */
function genCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CHARSET[crypto.randomInt(CHARSET.length)];
  return s;
}
function newRoomCode(rooms) { let c = genCode(); while (rooms.has(c)) c = genCode(); return c; }
function sanitize(str, mL) { if (typeof str !== 'string') return ''; return str.slice(0, mL).trim(); }
function now() { return Date.now(); }
function safeName(room, id) { const s = room.students.get(id); return s && s.name ? s.name : ''; }

/* ===================== in-memory state ===================== */
const rooms = new Map();
const studentQuestionTime = new Map();

function createRoom() {
  const code = newRoomCode(rooms);
  return {
    code,
    teacherToken: crypto.randomUUID(),
    students: new Map(),        // id -> {name, joinedAt, lastSeen}
    votes: new Map(),           // studentId -> 'lost'|'ok'|'faster'
    questions: [],              // {id, text, authorId, upvotes:Set, createdAt, answered, hidden}
    history: [],                // {time, topic, counts:{lost,ok,faster}, total, lostPct, marker?, reexplain?}
    events: [],                 // {type:'spike'|'reexplain', topic, time, ...}
    pushSubscriptions: new Map(),
    reexplain: null,            // {before, startedAt, deadline, answers:Map<sid, answer>}
    topics: ['General'],
    currentTopic: 'General',
    createdAt: now()
  };
}

/* ===================== vote bars / history / recovery ===================== */
function voteBars(room) {
  const c = { lost: 0, ok: 0, faster: 0 };
  for (const v of room.votes.values()) c[v]++;
  return c;
}

function addEvent(room, event) {
  room.events.push(event);
  if (room.events.length > MAX_EVENTS_PER_ROOM) room.events.shift();
}

function recordSample(room) {
  const bars = voteBars(room);
  const totalVotes = room.votes.size;
  if (!totalVotes) return;

  const lostPct = Math.round((bars.lost / totalVotes) * 100);
  const previous = [...room.history].reverse().find(h => !h.marker);
  const unchanged = previous
    && previous.topic === room.currentTopic
    && previous.total === totalVotes
    && previous.counts.lost === bars.lost
    && previous.counts.ok === bars.ok
    && previous.counts.faster === bars.faster;
  if (unchanged) return;

  room.history.push({ time: now(), topic: room.currentTopic, counts: bars, total: totalVotes, lostPct });
  if (room.history.length > MAX_HISTORY_PER_ROOM) room.history.shift();

  const previousReachedThreshold = previous
    && previous.topic === room.currentTopic
    && previous.total >= 3
    && previous.lostPct > 30;
  if (totalVotes >= 3 && lostPct > 30 && !previousReachedThreshold) {
      addEvent(room, { type: 'spike', time: now(), topic: room.currentTopic, lostPct, before: lostPct });
      notifyTeacher(room, 'Class needs support', `${lostPct}% of responses feel lost in ${room.currentTopic}.`, `spike-${room.code}`);
      if (!room.reexplain) {
        room.reexplain = { before: lostPct, startedAt: now(), deadline: now() + REEVAL_WINDOW_MS, answers: new Map() };
      }
      broadcastRoomUpdate(room);
  }
}

function teacherRoomName(roomCode) { return `teacher:${roomCode}`; }

function notifyTeacher(room, title, body, tag) {
  if (!vapidPublicKey || !room.pushSubscriptions.size) return;
  const payload = JSON.stringify({
    title,
    body,
    tag,
    url: `/teacher.html?room=${room.code}#token=${room.teacherToken}`
  });
  for (const [endpoint, subscription] of room.pushSubscriptions) {
    webpush.sendNotification(subscription, payload).catch((error) => {
      if (error.statusCode === 404 || error.statusCode === 410) {
        room.pushSubscriptions.delete(endpoint);
        return;
      }
      console.error(`Could not send teacher push notification for room ${room.code}.`, error);
    });
  }
}

function broadcastRoomUpdate(room) {
  io.to(teacherRoomName(room.code)).emit('room-update', snapshotForTeacher(room));
  io.to(room.code).emit('room-update', snapshotForStudent(room));
}

function finalizeReexplain(room) {
  if (!room.reexplain) return;
  const re = room.reexplain;
  const answered = re.answers.size;
  const stillLost = [...re.answers.values()].filter(a => a === 'still_lost').length;
  const after = answered ? Math.round((stillLost / answered) * 100) : re.before;
  const delta = re.before - after;
  let verdict = delta >= 15 ? 'Worked' : (delta > 0 ? 'Partly' : "Didn't work");

  const ev = {
    type: 'reexplain', time: now(), topic: room.currentTopic,
    before: re.before, after, verdict, responded: answered, total: room.students.size
  };
  addEvent(room, ev);
  room.history.push({
    time: now(), topic: room.currentTopic, counts: { lost: 0, ok: 0, faster: 0 },
    total: 0, lostPct: after, marker: 'Re-explained', reexplain: ev
  });
  room.reexplain = null;
  broadcastRoomUpdate(room);
}

function cleanupStudents(room) {
  const cutoff = now() - 2 * 60 * 60 * 1000;
  for (const [id, st] of room.students) {
    if (st.lastSeen < cutoff) {
      room.students.delete(id);
      room.votes.delete(id);
      studentQuestionTime.delete(`${room.code}:${id}`);
    }
  }
}

/* ===================== snapshots ===================== */
function snapshotForStudent(room) {
  return { code: room.code, currentTopic: room.currentTopic, reexplain: Boolean(room.reexplain) };
}

function snapshotForTeacher(room) {
  const bars = voteBars(room);
  const totalVotes = room.votes.size;
  const lostPct = totalVotes ? Math.round((bars.lost / totalVotes) * 100) : 0;
  return {
    code: room.code,
    topics: room.topics,
    currentTopic: room.currentTopic,
    studentCount: room.students.size,
    bars,
    totalVotes,
    lostPct,
    thresholdReached: totalVotes >= 3 && lostPct > 30,
    reexplain: room.reexplain
      ? { startedAt: room.reexplain.startedAt, deadline: room.reexplain.deadline, before: room.reexplain.before }
      : null,
    questions: room.questions.map(q => ({
      id: q.id, text: q.text, upvotes: q.upvotes.size,
      authorName: safeName(room, q.authorId), answered: q.answered, hidden: q.hidden
    })),
    history: room.history.map(h => ({
      time: h.time, topic: h.topic, counts: h.counts, total: h.total,
      lostPct: h.lostPct, marker: h.marker, reexplain: h.reexplain
    })),
    events: room.events
  };
}

function reportSnapshot(room) {
  const hist = room.history || [];
  const eligibleSamples = hist.filter(h => h.total >= 3);
  const peak = eligibleSamples.reduce((p, h) => (!p || h.lostPct > p.lostPct ? h : p), null);
  const answeredQs = room.questions.filter(q => q.answered && !q.hidden);
  const unansweredQs = room.questions.filter(q => !q.answered && !q.hidden);
  const voters = new Set(room.votes.keys());
  const participation = room.students.size ? Math.round((voters.size / room.students.size) * 100) : 0;
  return {
    code: room.code,
    studentCount: room.students.size,
    totalVotes: room.votes.size,
    participation,
    peak: peak ? { pct: peak.lostPct, topic: peak.topic, time: peak.time } : null,
    events: room.events,
    answeredQsCount: answeredQs.length,
    unansweredQuestions: unansweredQs.map(q => ({ id: q.id, text: q.text, upvotes: q.upvotes.size })),
    history: hist.map(h => ({
      time: h.time,
      topic: h.topic,
      lostPct: h.marker || h.total >= 3 ? h.lostPct : null,
      total: h.total,
      marker: h.marker
    }))
  };
}

function studentQuestionList(room) {
  return room.questions.filter(q => !q.hidden).map(x => ({ id: x.id, text: x.text, upvotes: x.upvotes.size }));
}

/* ===================== socket ===================== */
io.on('connection', (socket) => {
  let room = null;
  let role = null;
  let studentId = null;

  socket.on('student-join', (payload, cb) => {
    const code = sanitize(payload?.code, 10).toUpperCase();
    const nextRoom = rooms.get(code);
    if (!nextRoom) return cb?.({ ok: false, err: 'Room not found' });
    if (room) socket.leave(role === 'teacher' ? teacherRoomName(room.code) : room.code);
    room = nextRoom;
    studentId = sanitize(payload?.id, 64) || ('s_' + Math.random().toString(36).slice(2, 10));
    if (!room.students.has(studentId) && room.students.size >= MAX_STUDENTS_PER_ROOM) {
      room = null;
      role = null;
      studentId = null;
      return cb?.({ ok: false, err: 'Room is full' });
    }
    if (!room.students.has(studentId)) room.students.set(studentId, { name: payload?.name ? sanitize(payload.name, 30) : '', joinedAt: now(), lastSeen: now() });
    else if (payload?.name) room.students.get(studentId).name = sanitize(payload.name, 30);
    room.students.get(studentId).lastSeen = now();
    role = 'student';
    socket.join(code);
    socket.emit('your-vote', room.votes.get(studentId) || null);
    socket.emit('student-questions', studentQuestionList(room));
    broadcastRoomUpdate(room);
    cb?.({ ok: true, id: studentId });
  });

  socket.on('teacher-join', (payload, cb) => {
    const code = sanitize(payload?.code, 10).toUpperCase();
    const token = sanitize(payload?.token, 80);
    const nextRoom = rooms.get(code);
    if (!nextRoom) return cb?.({ ok: false, err: 'Room not found' });
    if (nextRoom.teacherToken !== token) return cb?.({ ok: false, err: 'Not the teacher' });
    if (room) socket.leave(role === 'teacher' ? teacherRoomName(room.code) : room.code);
    room = nextRoom;
    role = 'teacher';
    socket.join(teacherRoomName(code));
    cb?.({ ok: true, room: snapshotForTeacher(room) });
  });

  socket.on('vote', (payload, cb) => {
    if (!room || role !== 'student') return cb?.({ ok: false, err: 'Not in room as student' });
    const val = sanitize(payload?.vote, 10);
    if (!VOTE_OPTIONS.includes(val)) return cb?.({ ok: false, err: 'Bad vote' });
    room.votes.set(studentId, val);
    broadcastRoomUpdate(room);
    cb?.({ ok: true });
  });

  socket.on('question', (payload, cb) => {
    if (!room || role !== 'student') return cb?.({ ok: false, err: 'Not in room as student' });
    const text = sanitize(payload?.text, MAX_QUESTION_LEN);
    if (!text) return cb?.({ ok: false, err: 'Empty question' });
    const questionKey = `${room.code}:${studentId}`;
    const last = studentQuestionTime.get(questionKey) || 0;
    if (now() - last < QUESTION_COOLDOWN_MS) return cb?.({ ok: false, err: 'Rate limited' });
    if (room.questions.length >= MAX_QUESTIONS_PER_ROOM) return cb?.({ ok: false, err: 'Question limit reached for this room' });
    studentQuestionTime.set(questionKey, now());
    const q = { id: crypto.randomUUID(), text, authorId: studentId, upvotes: new Set(), createdAt: now(), answered: false, hidden: false };
    room.questions.push(q);
    notifyTeacher(room, 'New student question', text, `question-${q.id}`);
    broadcastRoomUpdate(room);
    io.to(room.code).emit('student-questions', studentQuestionList(room));
    cb?.({ ok: true, question: q });
  });

  socket.on('upvote', (payload, cb) => {
    if (!room || role !== 'student') return cb?.({ ok: false, err: 'Not in room as student' });
    const qid = sanitize(payload?.id, 64);
    const q = room.questions.find(x => x.id === qid);
    if (!q) return cb?.({ ok: false, err: 'Question not found' });
    if (q.upvotes.has(studentId)) return cb?.({ ok: false, err: 'Already upvoted' });
    q.upvotes.add(studentId);
    broadcastRoomUpdate(room);
    io.to(room.code).emit('student-questions', studentQuestionList(room));
    cb?.({ ok: true, upvotes: q.upvotes.size });
  });

  socket.on('moderate', (payload, cb) => {
    if (!room || role !== 'teacher') return cb?.({ ok: false, err: 'Not teacher' });
    const qid = sanitize(payload?.id, 64);
    const action = sanitize(payload?.action, 12);
    const q = room.questions.find(x => x.id === qid);
    if (!q) return cb?.({ ok: false, err: 'Question not found' });
    if (action === 'answered') q.answered = true; else if (action === 'hide') q.hidden = true;
    else return cb?.({ ok: false, err: 'Bad action' });
    broadcastRoomUpdate(room);
    io.to(room.code).emit('student-questions', studentQuestionList(room));
    cb?.({ ok: true });
  });

  socket.on('set-topics', (payload, cb) => {
    if (!room || role !== 'teacher') return cb?.({ ok: false, err: 'Not teacher' });
    if (payload?.topics !== undefined && !Array.isArray(payload.topics)) return cb?.({ ok: false, err: 'Bad topics' });
    const topics = (payload?.topics || []).slice(0, MAX_TOPICS).map(t => sanitize(t, 40)).filter(Boolean);
    room.topics = topics.length ? topics : ['General'];
    room.currentTopic = room.topics[0];
    broadcastRoomUpdate(room);
    cb?.({ ok: true, topics: room.topics, currentTopic: room.currentTopic });
  });

  socket.on('next-topic', (_, cb) => {
    if (!room || role !== 'teacher') return cb?.({ ok: false, err: 'Not teacher' });
    let idx = room.topics.indexOf(room.currentTopic);
    if (idx < 0 || idx >= room.topics.length - 1) idx = 0; else idx++;
    room.currentTopic = room.topics[idx];
    recordSample(room);
    broadcastRoomUpdate(room);
    cb?.({ ok: true, topic: room.currentTopic });
  });

  socket.on('reexplain-start', (_, cb) => {
    if (!room || role !== 'teacher') return cb?.({ ok: false, err: 'Not teacher' });
    if (room.reexplain) return cb?.({ ok: false, err: 'Already running' });
    const bars = voteBars(room);
    const totalVotes = room.votes.size;
    const before = totalVotes ? Math.round((bars.lost / totalVotes) * 100) : 0;
    room.reexplain = { before, startedAt: now(), deadline: now() + REEVAL_WINDOW_MS, answers: new Map() };
    addEvent(room, { type: 'reexplain-start', time: now(), topic: room.currentTopic, lostPct: before, before });
    broadcastRoomUpdate(room);
    cb?.({ ok: true, before });
  });

  socket.on('reexplain-answer', (payload, cb) => {
    if (!room || role !== 'student' || !room.reexplain) return cb?.({ ok: false, err: 'No active prompt' });
    const ans = sanitize(payload?.answer, 20);
    if (!['got_it', 'still_lost'].includes(ans)) return cb?.({ ok: false, err: 'Bad answer' });
    if (room.reexplain.answers.has(studentId)) return cb?.({ ok: false, err: 'Already answered' });
    if (now() >= room.reexplain.deadline) return cb?.({ ok: false, err: 'Window closed' });
    room.reexplain.answers.set(studentId, ans);
    broadcastRoomUpdate(room);
    cb?.({ ok: true });
  });

  socket.on('report-request', (payload, cb) => {
    const code = sanitize(payload?.code, 10).toUpperCase();
    const token = sanitize(payload?.token, 80);
    const r = rooms.get(code);
    if (!r) return cb?.({ ok: false, err: 'Room not found' });
    if (r.teacherToken !== token) return cb?.({ ok: false, err: 'Not the teacher' });
    cb?.({ ok: true, report: reportSnapshot(r) });
  });

  socket.on('ping', () => { if (room && role === 'student') { const st = room.students.get(studentId); if (st) st.lastSeen = now(); } });
  socket.on('disconnect', () => {});
});

/* ===================== periodic tasks ===================== */
let sampleTimer = null;
function startSampling() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = setInterval(() => {
    for (const room of rooms.values()) {
      recordSample(room);
      if (room.reexplain && now() >= room.reexplain.deadline) finalizeReexplain(room);
      cleanupStudents(room);
      if (now() - room.createdAt > ROOM_TTL_MS) {
        for (const id of room.students.keys()) studentQuestionTime.delete(`${room.code}:${id}`);
        rooms.delete(room.code);
      }
    }
  }, 5000);
}

/* ===================== routes ===================== */
app.get('/', (req, res) => res.redirect('/home.html'));
app.get('/create', (req, res) => {
  if (rooms.size >= MAX_ROOMS) return res.status(503).send('Room capacity reached. Try again later.');
  const room = createRoom();
  rooms.set(room.code, room);
  res.redirect(`/teacher.html?room=${room.code}#token=${room.teacherToken}`);
});
app.get('/api/push/key', (req, res) => {
  if (!vapidPublicKey) {
    return res.status(503).json({ error: 'Phone alerts are not configured on this server yet.' });
  }
  res.json({ publicKey: vapidPublicKey });
});
app.post('/api/push/subscribe', (req, res) => {
  const code = sanitize(req.body?.code, 10).toUpperCase();
  const token = sanitize(req.body?.token, 80);
  const subscription = req.body?.subscription;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (room.teacherToken !== token) return res.status(403).json({ error: 'Not the teacher.' });
  if (!vapidPublicKey) return res.status(503).json({ error: 'Phone alerts are not configured on this server yet.' });
  if (
    !subscription || typeof subscription.endpoint !== 'string' ||
    subscription.endpoint.length > 2048 ||
    typeof subscription.keys?.p256dh !== 'string' ||
    typeof subscription.keys?.auth !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid push subscription.' });
  }
  let endpoint;
  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    return res.status(400).json({ error: 'Invalid push subscription endpoint.' });
  }
  const trustedPushHosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
  if (
    endpoint.protocol !== 'https:' ||
    !trustedPushHosts.some((host) => endpoint.hostname === host || endpoint.hostname.endsWith('.' + host))
  ) {
    return res.status(400).json({ error: 'Push subscriptions must use a supported browser push service.' });
  }
  if (!room.pushSubscriptions.has(subscription.endpoint) && room.pushSubscriptions.size >= 5) {
    return res.status(429).json({ error: 'This room already has the maximum number of alert devices.' });
  }
  room.pushSubscriptions.set(subscription.endpoint, subscription);
  res.status(201).json({ ok: true });
});
app.get('/api/rooms/:code/qr.svg', async (req, res) => {
  const code = sanitize(req.params.code, 10).toUpperCase();
  if (!rooms.has(code)) return res.status(404).send('Room not found.');
  try {
    const studentUrl = new URL(`/student.html?room=${encodeURIComponent(code)}`, `${req.protocol}://${req.get('host')}`);
    const svg = await QRCode.toString(studentUrl.href, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
      color: { dark: '#111827', light: '#ffffff' }
    });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (error) {
    console.error(`Could not create a join QR code for room ${code}.`, error);
    res.status(500).send('Could not create the room QR code.');
  }
});
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/home.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/student.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/teacher.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
app.get('/report.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));

/* ===================== start ===================== */
const PORT = process.env.PORT || 3000;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully.`);
  if (sampleTimer) clearInterval(sampleTimer);
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing process exit.');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.error(`Fatal ${origin}; the process will exit and should be restarted by its process manager.`, error);
});
server.on('error', (error) => {
  console.error('HTTP server failed to start or encountered a fatal error.', error);
  process.exitCode = 1;
  if (sampleTimer) clearInterval(sampleTimer);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`Pulse listening on ${server.address().port}`);
  startSampling();
});
