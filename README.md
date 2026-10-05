# Classroom Pulse

Classroom Pulse is a small Express and Socket.IO app for live classroom votes,
questions, and teacher re-explanation check-ins.

## Run locally

Requires Node.js 22.3 or later in the Node 22 series. This matches the
`pdf-parse` runtime requirement used for uploaded PDF lessons.

```sh
npm install
npm start
```

Open `http://localhost:3000/`. To run the integration smoke test, use:

```sh
npm run test:smoke
```

The test starts an isolated server on an available local port, simulates a
teacher and 50 randomly voting student clients, and checks the room, vote,
question, topic, moderation, check-in, report, and health-check flows.
It also checks that one-vote samples are not presented as reliable confusion
peaks and that the automatic re-explain prompt triggers at the three-vote
threshold. AI generation and grading use a local mock OpenAI-compatible
endpoint in the test, so the test does not spend API credits.

## Share a classroom

Anyone can open the public app URL. A teacher creates a room and shares the
student link or four-character room code; students join from their own phones
or computers. Votes and questions appear on the teacher dashboard over
Socket.IO in real time. The teacher dashboard URL contains a private token:
share the student link, not the teacher link.

The teacher dashboard also displays a QR code for the student join link.
Students can scan it from the home page on mobile browsers with camera access,
or enter the four-character code if scanning is unavailable. Camera access
requires HTTPS (except on localhost).

## Teacher phone alerts

On the teacher dashboard, choose **Enable phone alerts** and allow browser
notifications. New student questions and a classroom confusion spike trigger
a push notification; supported devices may also vibrate. The dashboard can
also vibrate and show an alert while it is open. Push alerts require HTTPS and
VAPID keys; without them, the button explains that server setup is needed.

Generate a VAPID key pair locally with:

```sh
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (for
example, `mailto:admin@yourdomain.com`) as environment variables on the server.
Keep the private key secret and stable between deployments, then restart the
service. For a Render Blueprint deployment, provide all three values when
prompted; for an existing service, add them under **Environment** in the Render
dashboard and redeploy. Without these keys the server returns a configuration
error before asking the browser for notification permission. Push subscriptions
are held in the same in-memory room as the class,
so a server restart or room expiry requires enabling alerts again. Notification
and vibration behavior depends on browser and device settings; on iOS, web push
requires adding the site to the Home Screen.

## AI quizzes and video rooms

The teacher AI Quiz tab accepts PDF, Word, Markdown, and text lesson material up
to 100 MB.
It generates a validated mix of multiple-choice, true/false, and rubric-based
short-answer questions. Teachers can choose question count, difficulty, and
types, then review reference answers and rubrics before launching. Objective
questions are scored locally; short answers are graded by the configured AI
provider and students receive a score with feedback. Treat AI grades as
assistance: review results before using them for formal assessment.

Render defaults to NVIDIA NIM using `nvidia/nemotron-3-super-120b-a12b`. Set
`NVIDIA_API_KEY` on the server; the default endpoint is
`https://integrate.api.nvidia.com/v1`. You can override the model with
`AI_MODEL` or `NVIDIA_MODEL` and the endpoint with `NVIDIA_BASE_URL`. For
backward compatibility, local deployments select NVIDIA automatically when
`NVIDIA_API_KEY` is present and otherwise default to OpenAI. To use OpenAI
explicitly, set `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally
`OPENAI_MODEL` and `OPENAI_BASE_URL`. The keys stay on the server and must
never be put in browser code. When a provider rejects JSON-schema formatting,
the app retries without the strict schema wrapper.

Class video uses LiveKit Cloud's SFU instead of a peer-to-peer mesh, so each
client publishes to the media server rather than uploading media separately to
every participant. Create a LiveKit project and configure `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` on the server. The API secret is
used only to issue short-lived, room-scoped participant tokens and is never
sent to browsers. Without all three values, the video room reports that
service configuration is unavailable. Teachers join with camera and microphone
enabled by default; students join muted with cameras off and can opt in.
Camera, microphone, and screen sharing require a secure HTTPS context and user
permission. Screen capture also requires a browser that exposes the display
capture API; use a current desktop browser if the screen-share control reports
that capture is unsupported. Mobile browser support varies.
If video fails to connect, check the browser console and server logs, confirm
the LiveKit URL and credentials belong to the same project, and verify that
the deployment's firewall/network allows LiveKit WebRTC media traffic.

For a Render Blueprint, set the NVIDIA and LiveKit values when prompted or add
them under the service's **Environment** settings, then redeploy. Keep provider
keys and the LiveKit API secret private; do not commit them.

## Lobby, approval, and the Participants Manager

Students join the **normal room** immediately and can vote, ask questions, and
use class chat straight away — **no approval needed to be in the room**. Only
the **video room** is gated: a student taps *Request to join video*, and the
teacher still has to admit them. Teachers open the **Participants** button on
their dashboard to reach `/participants.html`, a channelised control panel whose
two room channels are backed by **two independent lists**: **Normal room**
(Admit / Kick) and **Video room** (video grid plus per-tile mute and kick), plus
a **Chat** channel for class broadcasts or a private message. A student appears
in exactly one list at a time. The header shows total, normal-room, and
video-room counts, and every change arrives over Socket.IO, so the page never
needs a refresh.

Server state lives in a single `Map` keyed by socket id, holding each entry's
name, role, status, and room. Statuses are `MAIN` (in the normal room, the
default on join), `ADMITTED`, `MUTED`, `KICKED`, and `LEFT`. `roomParticipants()`
splits the roster into `{ mainRoom, videoRoom }` on the way out, so a student can
never be double-counted. Room-code scoping keeps separate classes isolated, and
every privileged handler re-checks the caller is an authenticated host for that
same room, so a client cannot claim a role it does not have. Requesting video
only sets a `wantsVideo` flag for the teacher; it never grants access. Kicking
emits `participant-kicked` with a reason and timestamp, removes the student from
the LiveKit room, and then disconnects the socket; kicking an already-removed
participant returns success instead of failing. Video admission uses short-lived,
single-use tickets: `/api/video/token` refuses to issue a student LiveKit token
unless a valid admission ticket is presented, so a student cannot skip the
teacher's approval by calling the endpoint directly.

### Integration checklist

The feature is already wired in. These are the exact integration points if you
need to re-apply or review them.

New files:

- `participants-control.js` — host-only event handlers and the participants map.
- `public/participants.html` — the three-channel Participants Manager page.
- `public/participants.js` — live roster rendering, controls, chat, toasts.
- `public/style.css` — dark dashboard styling for the manager, lobby, and chat.
- `public/premium.css` — shared visual refresh for every page.
- `public/icons.css` — the `icon-*` SVG mask icons used across the pages. The
  markup ships empty `<i class="icon-name">` elements, so without this file
  those icons render as invisible gaps. Keep it linked from every page that
  uses an `icon-*` class.
- `test/audit-dom.js` — static check that every `getElementById()` and every
  `icon-*` class a page uses actually resolves, so a renamed element or a
  forgotten icon fails fast instead of breaking silently in the browser.
- `test/demo-run.js` — live demonstration of the whole lobby flow against a
  real server.

Edits to existing files:

- `server.js`: `require('./participants-control')` next to the other requires;
  create the `liveKitRoomService` client from `RoomServiceClient`; call
  `createParticipantsControl({ io, rooms, liveKit })` after `rooms` is declared;
  validate the admission ticket before issuing a student token in
  `POST /api/video/token`, and consume it after the token is built.
- `public/teacher.html`: the `participantsManagerLink` button, whose `href` is
  set to `/participants.html?room=<code>#token=<token>` after the teacher
  authenticates.
- `public/student.html`: the `style.css` link, the waiting-lobby and kicked
  overlays, the class chat card, the `join-lobby` call in `joinRoom`, and the
  `participant-admitted`, `participant-kicked`, and chat listeners.
- `public/video-room.js`: send `admissionTicket` with the token request, emit
  `register-video-identity` once connected, and apply `force-mute` to the local
  microphone. Every control lookup here is null-guarded, so a page may
  deliberately omit a control: students have no `shareScreenBtn`.
- `test/smoke.js`: covers host authentication, the student-cannot-admit check,
  single-use admission tickets, mute/unmute, kick with reason, and the new
  static pages.

### Where the controls live

The Participants manager is a **tab on the teacher dashboard**, between
Classroom and AI Quiz, so it needs no separate page load. The standalone
`/participants.html` URL still works for sharing a direct link.

`participants.js` is written to run in both places. When
`window.ParticipantsManagerConfig` is present it reuses the host page's socket,
room code, and teacher token instead of opening a second connection, and it
leaves `window.classroomVideoConfig` and the video start buttons to the host
page. Every element it touches is looked up defensively, because the embedded
tab intentionally omits the video stage: the teacher dashboard already owns
`#videoRoom` and `#videoGrid`, and duplicating those ids would break the video.

Class chat is available in three places at once — the Participants tab, the
student page, and a **chat panel inside the video room** on both teacher and
student pages. All of them reuse the same `classroom-message` and
`private-chat-message` events, so there is one conversation rather than three.

### Checks

```sh
npm test          # static DOM/icon audit, then the full integration smoke test
npm run test:audit
npm run test:demo  # live normal room -> admit -> mute -> kick run
```

## Deploy the Node app

The existing app needs a Node host that supports long-lived Socket.IO
connections. Vercel Functions are not suitable for this Socket.IO server, and
Cloudflare Workers would require rewriting the backend around Durable Objects.
The included `render.yaml` configures the current app as a Render Web Service.

1. Push the project to a GitHub repository. Do not commit `node_modules` or
   secrets.
2. In Render, choose **New > Blueprint** and connect the repository containing
   `render.yaml`. Review the service and deploy it. Alternatively, create a
   **Web Service** with build command `npm ci --omit=dev`, start command
   `npm start`, and health-check path `/healthz`.
3. The service listens on the `PORT` supplied by the host. Confirm the
   deployment's `/healthz` endpoint returns `{"status":"ok"}`, then open its
   HTTPS URL and test creating a room and joining as a student.
4. Keep one instance for this in-memory version. Choose an always-on service
   plan for a classroom session. The included Blueprint uses Render's free
   plan so the public pilot can start without intentionally selecting a paid
   instance; Render free services may sleep after inactivity or restart, and
   active in-memory rooms are lost on restart. The host's health check and
   restart policy can recover a failed process, but cannot prevent every
   outage.

## Optional Cloudflare domain

Cloudflare can manage the domain/DNS while Render runs the Node app:

1. Add your domain to Cloudflare and configure it as a custom domain in Render.
2. Add the DNS record Render specifies. Start with the record set to **DNS
   only** while Render verifies the domain and issues TLS.
3. After HTTPS works directly on the custom domain, you may enable Cloudflare's
   proxy. WebSockets must be enabled in Cloudflare, and test Socket.IO through
   the proxied domain before using it in a live session.

Cloudflare DNS/proxy does not move the Node server onto Cloudflare Workers.
Similarly, Vercel could host a separate static frontend, but the Socket.IO
backend still needs a persistent Node host.

## Availability and data limits

- The server listens on `PORT` when provided, otherwise on port `3000`.
- It serves `/healthz` for the host's health probe and handles normal `SIGTERM`
  and `SIGINT` shutdown signals.
- The teacher token is placed in the URL fragment, which browsers do not send
  in HTTP requests. Treat the teacher link as a secret and do not publish it.
- Process memory is bounded with limits of 100 active rooms, 500 students per
  room, 200 questions per room, and capped history/event lists. When a limit is
  reached the server rejects new work rather than growing memory without bound.
- Rooms and activity are held in process memory. A restart loses active rooms;
  multiple app instances do not share state. Use a persistent database and a
  shared Socket.IO adapter such as Redis before relying on durable rooms or
  horizontal scaling. Backups and restore procedures are also needed for
  durable production use.
- The process handles normal `SIGTERM`/`SIGINT` shutdowns and logs fatal
  exceptions. Run it under a platform process supervisor with automatic
  restarts; do not try to continue after an uncaught exception. Health checks
  help the host detect a failed process, but cannot prevent every outage.
- The smoke test is a functional concurrency check at 50 clients, not a
  capacity benchmark or guarantee for a particular hosting plan.

## Keep it available

No application can guarantee that it will never crash or that the hosting
provider will never have an outage. Improve availability by using a managed
host that restarts failed processes, monitoring `/healthz`, reviewing logs and
alerts, deploying changes through a staging check, and keeping dependencies
updated. Test recovery and backups before storing real classroom data.
