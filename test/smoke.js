const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

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

function waitForRoomUpdate(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room-update', onUpdate);
      reject(new Error('Room update timed out'));
    }, 5000);
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
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
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

    for (const page of ['/home.html', '/student.html', '/teacher.html', '/report.html', '/styles.css']) {
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
    assert.deepEqual(Object.keys(studentSnapshot).sort(), ['code', 'currentTopic', 'reexplain'].sort(), 'student updates should not expose teacher-only room data');

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

    await Promise.all(students.slice(1, 3).map((student) => emitAck(student, 'vote', { vote: 'lost' })));
    const thresholdUpdate = waitForRoomUpdate(teacher, (snapshot) => Boolean(snapshot.reexplain));
    await emitAck(teacher, 'next-topic', {});
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

    const malformedTopics = await emitAck(teacher, 'set-topics', { topics: 'not-an-array' });
    assert.equal(malformedTopics.ok, false, 'malformed topic payload should be rejected without crashing');

    console.log(`PASS: health/static routes; teacher room; 50 students; 50 random votes (${JSON.stringify(expected)}); question/upvotes; topics; moderation; re-explain; report and invalid-input checks.`);
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
