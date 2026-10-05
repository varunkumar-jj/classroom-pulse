const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const webpush = require('web-push');
const createParticipantsControl = require('../participants-control');

const root = path.resolve(__dirname, '..');

async function testKickedPendingVideoIdentity() {
  const sockets = new Map();
  let onConnection;
  const removedIdentities = [];
  const ioStub = {
    sockets: { sockets },
    on(event, handler) {
      if (event === 'connection') onConnection = handler;
    },
    to() { return { emit() {} }; }
  };
  const roomCode = 'TEST';
  const control = createParticipantsControl({
    io: ioStub,
    rooms: new Map([[roomCode, { teacherToken: 'host-secret' }]]),
    liveKit: {
      TrackType: { AUDIO: 'audio' },
      async getParticipant() { return { tracks: [] }; },
      async mutePublishedTrack() {},
      async removeParticipant(_code, identity) { removedIdentities.push(identity); }
    }
  });
  function makeSocket(id) {
    const handlers = new Map();
    const socket = {
      id,
      data: {},
      connected: true,
      on(event, handler) { handlers.set(event, handler); },
      join() {},
      leave() {},
      emit() {},
      disconnect() { this.connected = false; },
      handlers
    };
    sockets.set(id, socket);
    onConnection(socket);
    return socket;
  }
  function emitAck(socket, event, payload) {
    return new Promise((resolve) => socket.handlers.get(event)(payload, resolve));
  }

  const host = makeSocket('host-socket');
  const student = makeSocket('student-socket');
  assert.equal((await emitAck(student, 'join-lobby', { code: roomCode, name: 'Student' })).status, 'WAITING');
  assert.equal((await emitAck(host, 'host-join', { code: roomCode, token: 'host-secret' })).ok, true);
  assert.equal((await emitAck(host, 'admit-participant', { code: roomCode, participantId: student.id })).ok, true);
  const admissionTicket = control.participants.get(student.id).admissionTicket;
  const identity = 'student-livekit-pending';
  assert.equal(control.consumeAdmissionTicket(roomCode, admissionTicket, identity), true);
  assert.equal((await emitAck(host, 'kick-participant', {
    code: roomCode,
    participantId: student.id,
    reason: 'Test pending video removal'
  })).ok, true);
  assert.ok(removedIdentities.includes(identity), 'kick should remove the pending LiveKit identity');
  assert.deepEqual(await emitAck(student, 'register-video-identity', { identity }), { ok: true, removed: true });
  assert.equal(removedIdentities.filter((item) => item === identity).length, 2, 'late video registration should be removed again');
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = http.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { reconnection: false, timeout: 5000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 5000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForRoomUpdate(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room-update', onUpdate);
      reject(new Error('Room update timed out'));
    }, timeoutMs);
    function onUpdate(room) {
      if (!predicate(room)) return;
      clearTimeout(timer);
      socket.off('room-update', onUpdate);
      resolve(room);
    }
    socket.on('room-update', onUpdate);
  });
}

function createTextPdf(text) {
  const escapedText = text.replace(/[\\()]/g, '\\$&');
  const content = `BT\n/F1 18 Tf\n50 50 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream\nendobj`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function waitForHealth(url, server) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (server.exitCode !== null) throw new Error(`Server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server health check did not become ready');
}

async function main() {
  await testKickedPendingVideoIdentity();
  const port = await reservePort();
  const aiPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const aiCalls = [];
  const aiAuthHeaders = [];
  const mockAiServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    aiCalls.push(call);
    aiAuthHeaders.push(request.headers.authorization);
    const isGrading = call.messages[0].content.includes('Grade each student response');
    const content = isGrading
      ? JSON.stringify({ grades: [{ questionIndex: 2, score: 90, feedback: 'Correct idea with one missing detail.' }] })
      : JSON.stringify({
          questions: [
            { type: 'mcq', question: 'Which option is correct?', options: ['A. Correct', 'B. Incorrect', 'C. Incorrect', 'D. Incorrect'], answer: 'A', rubric: 'Choose the correct option.', explanation: 'The first option is supported.', difficulty: 'easy' },
            { type: 'true_false', question: 'The source supports this statement.', options: [], answer: 'true', rubric: 'Answer true when supported.', explanation: 'This statement is supported.', difficulty: 'medium' },
            { type: 'short_answer', question: 'Explain the core idea.', options: [], answer: 'A supported explanation.', rubric: 'Award credit for identifying the main idea and evidence.', explanation: 'The answer should include the central idea.', difficulty: 'hard' }
          ]
        });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-smoke',
      object: 'chat.completion',
      created: Date.now(),
      model: 'nvidia/nemotron-3-super-120b-a12b',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    }));
  });
  await new Promise((resolve) => mockAiServer.listen(aiPort, '127.0.0.1', resolve));
  const vapidKeys = webpush.generateVAPIDKeys();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      VAPID_SUBJECT: 'mailto:smoke-test@example.com',
      AI_PROVIDER: 'nvidia',
      NVIDIA_API_KEY: 'smoke-test-nvidia-key',
      NVIDIA_BASE_URL: `http://127.0.0.1:${aiPort}/v1`,
      LIVEKIT_URL: 'wss://livekit.example.test',
      LIVEKIT_API_KEY: 'smoke-test-livekit-key',
      LIVEKIT_API_SECRET: 'smoke-test-livekit-secret-that-is-long-enough'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  const sockets = [];

  try {
    await waitForHealth(baseUrl, server);
    const health = await fetch(`${baseUrl}/healthz`);
    assert.deepEqual(await health.json(), { status: 'ok' });

    for (const page of [
      '/home.html', '/student.html', '/teacher.html', '/participants.html', '/participants.js',
      '/report.html', '/styles.css', '/style.css', '/video-room.js',
      '/vendor/livekit-client/livekit-client.esm.mjs',
      '/service-worker.js', '/vendor/qr-scanner/qr-scanner.min.js',
      '/vendor/qr-scanner/qr-scanner-worker.min.js'
    ]) {
      const response = await fetch(`${baseUrl}${page}`);
      assert.equal(response.status, 200, `${page} should be served`);
      if (page === '/vendor/livekit-client/livekit-client.esm.mjs') {
        assert.match(response.headers.get('content-type'), /javascript/i, 'LiveKit SDK should be served with a JavaScript MIME type');
        const sdk = await response.text();
        assert.ok(sdk.includes('RoomEvent') && sdk.includes('Track'), 'LiveKit SDK response should contain the expected client exports');
      }
    }

    const created = await fetch(`${baseUrl}/create`, { redirect: 'manual' });
    assert.equal(created.status, 302, 'room creation should redirect to the teacher dashboard');
    const teacherUrl = new URL(created.headers.get('location'), baseUrl);
    const roomCode = teacherUrl.searchParams.get('room');
    const token = new URLSearchParams(teacherUrl.hash.slice(1)).get('token');
    assert.ok(roomCode && token, 'teacher URL should contain room credentials');
    assert.equal(teacherUrl.searchParams.has('token'), false, 'teacher token should not be sent in the page request URL');

    const unauthorizedVideoToken = await fetch(`${baseUrl}/api/video/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: roomCode, role: 'teacher', name: 'Teacher', teacherToken: 'invalid' })
    });
    assert.equal(unauthorizedVideoToken.status, 403, 'LiveKit teacher tokens should require teacher authorization');
    const teacherVideoTokenResponse = await fetch(`${baseUrl}/api/video/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: roomCode, role: 'teacher', name: 'Teacher', teacherToken: token })
    });
    assert.equal(teacherVideoTokenResponse.status, 200, 'authorized teacher should receive a LiveKit access token');
    const teacherVideoToken = await teacherVideoTokenResponse.json();
    assert.equal(teacherVideoToken.url, 'wss://livekit.example.test');
    const videoClaims = JSON.parse(Buffer.from(teacherVideoToken.token.split('.')[1], 'base64url').toString());
    assert.equal(videoClaims.video.room, roomCode, 'LiveKit token must be scoped to the classroom room');
    assert.equal(videoClaims.video.roomJoin, true, 'LiveKit token must allow room joining');
    const studentVideoTokenResponse = await fetch(`${baseUrl}/api/video/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: roomCode, role: 'student', name: 'Student' })
    });
    assert.equal(studentVideoTokenResponse.status, 403, 'students must be admitted before receiving a LiveKit token');

    const pdfSourceText = 'A classroom source describes the core idea, supporting evidence, and why those details matter.';
    const sourcePdf = createTextPdf(pdfSourceText);
    const sourceFile = new Blob([sourcePdf], { type: 'application/pdf' });
    const quizForm = new FormData();
    quizForm.append('file', sourceFile, 'lesson.pdf');
    quizForm.append('code', roomCode);
    quizForm.append('token', token);
    quizForm.append('count', '3');
    quizForm.append('difficulty', 'mixed');
    quizForm.append('types', JSON.stringify(['mcq', 'true_false', 'short_answer']));
    const generatedQuizResponse = await fetch(`${baseUrl}/api/quiz/generate`, { method: 'POST', body: quizForm });
    assert.equal(generatedQuizResponse.status, 200, 'AI quiz generation should return a validated mixed-format quiz');
    assert.ok(
      aiCalls[0]?.messages?.[1]?.content.replace(/\s+/g, ' ').includes(pdfSourceText),
      'PDF parsing should send the complete extracted source text to the AI'
    );
    const generatedQuiz = await generatedQuizResponse.json();
    assert.deepEqual(generatedQuiz.questions.map((question) => question.type), ['mcq', 'true_false', 'short_answer']);
    assert.ok(generatedQuiz.questions[2].rubric, 'generated short-answer questions should include an AI grading rubric');
    assert.equal(generatedQuiz.model, 'nvidia/nemotron-3-super-120b-a12b', 'generation response should identify the configured NVIDIA model');
    assert.equal(generatedQuiz.provider, 'nvidia', 'generation response should identify the configured AI provider');

    const pushKey = await fetch(`${baseUrl}/api/push/key`);
    assert.equal(pushKey.status, 200, 'configured push service should return its public VAPID key');
    assert.equal((await pushKey.json()).publicKey, vapidKeys.publicKey);

    const qr = await fetch(`${baseUrl}/api/rooms/${roomCode}/qr.svg`);
    assert.equal(qr.status, 200, 'active rooms should have a scannable join QR');
    assert.match(await qr.text(), /<svg/, 'join QR should be returned as SVG');
    const unknownQr = await fetch(`${baseUrl}/api/rooms/NOPE/qr.svg`);
    assert.equal(unknownQr.status, 404, 'unknown rooms should not produce join QR codes');
    const unauthorizedPush = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: roomCode, token: 'invalid', subscription: {} })
    });
    assert.equal(unauthorizedPush.status, 403, 'push subscriptions should require the teacher token');
    const authorizedPush = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: roomCode,
        token,
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/smoke-test',
          keys: { p256dh: 'smoke-test-key', auth: 'smoke-test-auth' }
        }
      })
    });
    assert.equal(authorizedPush.status, 201, 'authorized teacher should be able to register a push subscription');

    const teacher = await connect(baseUrl);
    sockets.push(teacher);
    const teacherJoin = await emitAck(teacher, 'teacher-join', { code: roomCode, token });
    assert.equal(teacherJoin.ok, true, 'teacher should be able to join the created room');
    const wrongTeacher = await emitAck(teacher, 'teacher-join', { code: roomCode, token: 'invalid' });
    assert.equal(wrongTeacher.ok, false, 'invalid teacher token should be rejected');
    const hostJoin = await emitAck(teacher, 'host-join', { code: roomCode, token });
    assert.equal(hostJoin.ok, true, 'host-only participant controls should accept the room teacher token');

    const participants = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const student = await connect(baseUrl);
      sockets.push(student);
      const update = index === 0
        ? new Promise((resolve) => student.once('room-update', resolve))
        : null;
      const joined = await emitAck(student, 'student-join', {
        code: roomCode,
        id: `smoke-${index}-${crypto.randomUUID()}`,
        name: `Student ${index + 1}`
      });
      assert.equal(joined.ok, true, `student ${index + 1} should join`);
      const lobbyJoin = await emitAck(student, 'join-lobby', {
        code: roomCode,
        name: `Student ${index + 1}`
      });
      assert.equal(lobbyJoin.ok, true, `student ${index + 1} should enter the approval lobby`);
      assert.equal(lobbyJoin.status, 'WAITING', `student ${index + 1} should wait for teacher approval`);
      return { socket: student, update };
    }));
    const students = participants.map((participant) => participant.socket);
    const firstAdmitted = new Promise((resolve) => students[0].once('participant-admitted', resolve));
    const deniedHostAction = await emitAck(students[0], 'admit-participant', {
      code: roomCode,
      participantId: students[1].id
    });
    assert.equal(deniedHostAction.ok, false, 'participants must not be able to admit other students');
    const admitted = await emitAck(teacher, 'admit-participant', {
      code: roomCode,
      participantId: students[0].id
    });
    assert.equal(admitted.ok, true, 'host should be able to admit a waiting participant');
    const admission = await firstAdmitted;
    assert.equal(typeof admission.admissionTicket, 'string', 'admission should issue a scoped video ticket');
    const broadcastChat = new Promise((resolve) => students[0].once('classroom-message', resolve));
    assert.equal((await emitAck(teacher, 'classroom-message', {
      code: roomCode,
      message: 'Welcome to the live class.'
    })).ok, true, 'host should be able to broadcast to admitted participants');
    assert.equal((await broadcastChat).message, 'Welcome to the live class.', 'admitted students should receive class broadcasts');
    const privateChat = new Promise((resolve) => students[0].once('private-chat-message', resolve));
    assert.equal((await emitAck(teacher, 'private-chat-message', {
      code: roomCode,
      participantId: students[0].id,
      message: 'Please check in with me after class.'
    })).ok, true, 'host should be able to privately message a participant');
    assert.equal((await privateChat).message, 'Please check in with me after class.', 'private messages should reach only their recipient');
    const admittedTokenResponse = await fetch(`${baseUrl}/api/video/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: roomCode,
        role: 'student',
        name: 'Student 1',
        admissionTicket: admission.admissionTicket
      })
    });
    assert.equal(admittedTokenResponse.status, 200, 'an admitted student should receive a LiveKit token');
    const admittedVideoToken = await admittedTokenResponse.json();
    const admittedVideoClaims = JSON.parse(Buffer.from(admittedVideoToken.token.split('.')[1], 'base64url').toString());
    assert.equal(admittedVideoClaims.video.room, roomCode, 'student token must be scoped to the classroom room');
    assert.equal(admittedVideoClaims.video.canPublish, true, 'student token must allow opting into camera and microphone');
    const replayedAdmission = await fetch(`${baseUrl}/api/video/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: roomCode,
        role: 'student',
        name: 'Student 1',
        admissionTicket: admission.admissionTicket
      })
    });
    assert.equal(replayedAdmission.status, 403, 'admission tickets should be single-use');
    assert.equal((await emitAck(teacher, 'mute-participant', {
      code: roomCode,
      participantId: students[0].id,
      muted: true
    })).ok, true, 'host should be able to mute an admitted participant');
    assert.equal((await emitAck(teacher, 'mute-participant', {
      code: roomCode,
      participantId: students[0].id,
      muted: false
    })).ok, true, 'host should be able to unmute an admitted participant');
    const studentSnapshot = await participants[0].update;
    assert.deepEqual(Object.keys(studentSnapshot).sort(), ['code', 'currentTopic', 'quiz', 'reexplain'].sort(), 'student updates should only expose student-safe room data');
    assert.equal(studentSnapshot.quiz, null, 'inactive quizzes should not be exposed to students');

    const singleVote = await emitAck(students[0], 'vote', { vote: 'lost' });
    assert.equal(singleVote.ok, true, 'a single vote should be accepted');
    await emitAck(teacher, 'next-topic', {});
    const earlyReport = await emitAck(teacher, 'report-request', { code: roomCode, token });
    assert.equal(earlyReport.ok, true, 'report should load with a small sample');
    assert.equal(earlyReport.report.peak, null, 'a single vote must not be reported as a reliable peak');
    const smallSample = earlyReport.report.history.find((sample) => sample.total === 1);
    assert.ok(smallSample, 'report should include the recorded small sample');
    assert.equal(smallSample.lostPct, null, 'small samples should be marked as insufficient');
    assert.ok(earlyReport.report.history.every((sample) => sample.marker || sample.total > 0), 'empty polling intervals should not pollute report history');

    const thresholdUpdate = waitForRoomUpdate(teacher, (snapshot) => Boolean(snapshot.reexplain), 10000);
    await Promise.all(students.slice(1, 3).map((student) => emitAck(student, 'vote', { vote: 'lost' })));
    const triggered = await thresholdUpdate;
    assert.equal(triggered.totalVotes, 3, 'confusion threshold should only be considered with three votes');
    assert.ok(triggered.reexplain, 'reaching the threshold at three confused votes should start a re-explain prompt');

    const choices = ['lost', 'ok', 'faster'];
    const expected = { lost: 0, ok: 0, faster: 0 };
    const votes = students.map(() => choices[crypto.randomInt(choices.length)]);
    votes.forEach((vote) => { expected[vote]++; });
    const completeVoteSnapshot = waitForRoomUpdate(teacher, (snapshot) => snapshot.totalVotes === 50);
    const voteResponses = await Promise.all(students.map((student, index) =>
      emitAck(student, 'vote', { vote: votes[index] })));
    assert.ok(voteResponses.every((response) => response.ok), 'all 50 votes should be accepted');
    const voteSnapshot = await completeVoteSnapshot;
    assert.deepEqual(voteSnapshot.bars, expected, 'teacher dashboard should show the submitted vote distribution');

    const question = await emitAck(students[0], 'question', { text: 'How does this sample question work?' });
    assert.equal(question.ok, true, 'student question should be accepted');
    const upvotes = await Promise.all(students.slice(1).map((student) =>
      emitAck(student, 'upvote', { id: question.question.id })));
    assert.ok(upvotes.every((response) => response.ok), 'remaining students should upvote the question');

    const topicResult = await emitAck(teacher, 'set-topics', { topics: ['Sample topic', 'Review'] });
    assert.equal(topicResult.ok, true, 'teacher should be able to set topics');
    const nextTopic = await emitAck(teacher, 'next-topic', {});
    assert.equal(nextTopic.topic, 'Review', 'teacher should be able to advance topics');

    const moderation = await emitAck(teacher, 'moderate', { id: question.question.id, action: 'answered' });
    assert.equal(moderation.ok, true, 'teacher should be able to mark a question answered');
    const reexplain = await emitAck(teacher, 'reexplain-start', {});
    assert.ok(reexplain.ok || reexplain.err === 'Already running', 'teacher should have an active re-explain check-in');
    const answers = await Promise.all(students.map((student, index) =>
      emitAck(student, 'reexplain-answer', { answer: index % 2 ? 'got_it' : 'still_lost' })));
    assert.ok(answers.every((response) => response.ok), 'all 50 check-in responses should be accepted');
    const duplicateAnswer = await emitAck(students[0], 'reexplain-answer', { answer: 'got_it' });
    assert.equal(duplicateAnswer.ok, false, 'duplicate check-in responses should be rejected');

    const reportResponse = await emitAck(teacher, 'report-request', { code: roomCode, token });
    assert.equal(reportResponse.ok, true, 'teacher report should load');
    const report = reportResponse.report;
    assert.equal(report.studentCount, 50, 'report should count all 50 participants');
    assert.equal(report.totalVotes, 50, 'report should include all votes');
    assert.equal(report.answeredQsCount, 1, 'report should include the answered sample question');
    assert.equal(report.unansweredQuestions.length, 0, 'answered question should not remain unanswered');

    const quizSet = await emitAck(teacher, 'quiz-set', { questions: generatedQuiz.questions });
    assert.equal(quizSet.ok, true, 'teacher should be able to set a quiz');
    const quizStart = new Promise((resolve) => students[0].once('quiz-start', resolve));
    const quizLaunch = await emitAck(teacher, 'quiz-launch', {});
    assert.equal(quizLaunch.ok, true, 'teacher should be able to launch the quiz');
    const activeQuizReplacement = await emitAck(teacher, 'quiz-set', { questions: generatedQuiz.questions });
    assert.equal(activeQuizReplacement.ok, false, 'active quizzes should not be replaced');
    const studentQuiz = await quizStart;
    assert.equal(studentQuiz.active, true, 'students should receive the active quiz');
    assert.equal(studentQuiz.questions[0].answer, undefined, 'student quiz payload must not reveal the answer key');
    assert.equal(studentQuiz.questions[2].rubric, undefined, 'student quiz payload must not reveal the grading rubric');
    assert.deepEqual(studentQuiz.questions[0].options, generatedQuiz.questions[0].options, 'students should receive multiple-choice options');
    assert.deepEqual(await emitAck(students[1], 'quiz-submit', { answers: ['A'] }), {
      ok: false,
      err: 'Submit one answer for each quiz question.'
    }, 'incomplete quiz submissions should be rejected');
    const quizSubmission = await emitAck(students[0], 'quiz-submit', { answers: ['A', 'true', 'The core idea is supported by evidence.'] });
    assert.equal(quizSubmission.ok, true, 'student should be able to submit all question types');
    assert.equal(quizSubmission.scored[0].correct, true, 'multiple-choice answer should be scored correctly');
    assert.equal(quizSubmission.scored[1].correct, true, 'true/false answer should be scored correctly');
    assert.equal(quizSubmission.scored[2].score, 90, 'short answer should receive the AI rubric score');
    assert.equal(quizSubmission.scored[2].feedback, 'Correct idea with one missing detail.');
    const duplicateQuizSubmission = await emitAck(students[0], 'quiz-submit', { answers: ['A', 'true', 'another answer'] });
    assert.equal(duplicateQuizSubmission.ok, false, 'students should not submit a quiz more than once');
    const blankQuizSubmission = await emitAck(students[1], 'quiz-submit', { answers: [null, null, null] });
    assert.equal(blankQuizSubmission.ok, true, 'students may submit unanswered items without breaking grading');
    assert.equal(blankQuizSubmission.scored[2].score, 0, 'blank short answers should receive zero without an AI score');
    const quizEnd = await emitAck(teacher, 'quiz-end', {});
    assert.equal(quizEnd.ok, true, 'teacher should be able to end the quiz');
    assert.equal(quizEnd.results[0].correct, 1, 'teacher results should include correct submissions');
    assert.equal(quizEnd.results[0].total, 2, 'teacher results should count submitted answers');
    assert.equal(quizEnd.results[2].pct, 45, 'teacher results should aggregate AI-graded and blank short answers');
    assert.equal(aiCalls.length, 2, 'quiz generation and short-answer grading should both use the configured AI provider');
    assert.ok(aiCalls.every((call) => call.model === 'nvidia/nemotron-3-super-120b-a12b'), 'generation and grading should both use the configured NVIDIA model');
    assert.ok(aiCalls.every((call) => call.chat_template_kwargs?.enable_thinking === false), 'NVIDIA requests should disable reasoning text to preserve the app JSON response contract');
    assert.ok(aiAuthHeaders.every((authorization) => /^Bearer .+$/.test(authorization || '')), 'all AI requests should send a bearer API key');
    const clearedQuiz = await emitAck(teacher, 'quiz-clear', {});
    assert.equal(clearedQuiz.ok, true, 'teacher should be able to clear an ended quiz');

    const malformedTopics = await emitAck(teacher, 'set-topics', { topics: 'not-an-array' });
    assert.equal(malformedTopics.ok, false, 'malformed topic payload should be rejected without crashing');

    const kickNotice = new Promise((resolve) => students[1].once('participant-kicked', resolve));
    const kickedDisconnect = new Promise((resolve) => students[1].once('disconnect', resolve));
    const kicked = await emitAck(teacher, 'kick-participant', {
      code: roomCode,
      participantId: students[1].id,
      reason: 'Smoke-test removal'
    });
    assert.equal(kicked.ok, true, 'host should be able to kick a participant');
    assert.equal(kicked.reason, 'Smoke-test removal');
    assert.equal(typeof kicked.timestamp, 'number', 'kick response should include its timestamp');
    assert.equal((await kickNotice).reason, 'Smoke-test removal', 'kicked participant should receive the reason');
    await kickedDisconnect;

    console.log(`PASS: health/static routes; room QR and push authorization; authenticated host and student approval lifecycle; one-time LiveKit admission; mute/unmute/kick controls; validated AI quiz generation; teacher room; 50 students; 50 random votes (${JSON.stringify(expected)}); question/upvotes; topics; moderation; re-explain; report; student-safe mixed quiz; objective and mock-AI short-answer grading; invalid-input checks.`);
  } catch (error) {
    console.error(error);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    server.kill();
    mockAiServer.close();
  }
}

main();
