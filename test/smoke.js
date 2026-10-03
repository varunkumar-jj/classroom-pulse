const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const webpush = require('web-push');

const root = path.resolve(__dirname, '..');

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
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const vapidKeys = webpush.generateVAPIDKeys();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      VAPID_SUBJECT: 'mailto:smoke-test@example.com'
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
      '/home.html', '/student.html', '/teacher.html', '/report.html', '/styles.css',
      '/service-worker.js', '/vendor/qr-scanner/qr-scanner.min.js',
      '/vendor/qr-scanner/qr-scanner-worker.min.js'
    ]) {
      const response = await fetch(`${baseUrl}${page}`);
      assert.equal(response.status, 200, `${page} should be served`);
    }

    const created = await fetch(`${baseUrl}/create`, { redirect: 'manual' });
    assert.equal(created.status, 302, 'room creation should redirect to the teacher dashboard');
    const teacherUrl = new URL(created.headers.get('location'), baseUrl);
    const roomCode = teacherUrl.searchParams.get('room');
    const token = new URLSearchParams(teacherUrl.hash.slice(1)).get('token');
    assert.ok(roomCode && token, 'teacher URL should contain room credentials');
    assert.equal(teacherUrl.searchParams.has('token'), false, 'teacher token should not be sent in the page request URL');

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
      return { socket: student, update };
    }));
    const students = participants.map((participant) => participant.socket);
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

    const quizQuestions = [{
      question: 'Which option is correct?',
      options: ['A. Correct', 'B. Incorrect', 'C. Incorrect', 'D. Incorrect'],
      answer: 'A',
      explanation: 'The first option is correct.'
    }];
    const quizSet = await emitAck(teacher, 'quiz-set', { questions: quizQuestions });
    assert.equal(quizSet.ok, true, 'teacher should be able to set a quiz');
    const quizStart = new Promise((resolve) => students[0].once('quiz-start', resolve));
    const quizLaunch = await emitAck(teacher, 'quiz-launch', {});
    assert.equal(quizLaunch.ok, true, 'teacher should be able to launch the quiz');
    const studentQuiz = await quizStart;
    assert.equal(studentQuiz.active, true, 'students should receive the active quiz');
    assert.equal(studentQuiz.questions[0].answer, undefined, 'student quiz payload must not reveal the answer key');
    assert.deepEqual(studentQuiz.questions[0].options, quizQuestions[0].options, 'students should receive the question options');
    const quizSubmission = await emitAck(students[0], 'quiz-submit', { answers: ['A'] });
    assert.equal(quizSubmission.ok, true, 'student should be able to submit quiz answers');
    assert.equal(quizSubmission.scored[0].correct, true, 'quiz submission should be scored correctly');
    const quizEnd = await emitAck(teacher, 'quiz-end', {});
    assert.equal(quizEnd.ok, true, 'teacher should be able to end the quiz');
    assert.equal(quizEnd.results[0].correct, 1, 'teacher results should include correct submissions');
    assert.equal(quizEnd.results[0].total, 1, 'teacher results should count submitted answers');

    const malformedTopics = await emitAck(teacher, 'set-topics', { topics: 'not-an-array' });
    assert.equal(malformedTopics.ok, false, 'malformed topic payload should be rejected without crashing');

    console.log(`PASS: health/static routes; room QR and push authorization; teacher room; 50 students; 50 random votes (${JSON.stringify(expected)}); question/upvotes; topics; moderation; re-explain; report; student-safe quiz launch/scoring/results; invalid-input checks.`);
  } catch (error) {
    console.error(error);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    server.kill();
  }
}

main();
