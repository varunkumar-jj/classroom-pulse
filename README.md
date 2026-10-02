# Classroom Pulse

Classroom Pulse is a small Express and Socket.IO app for live classroom votes,
questions, and teacher re-explanation check-ins.

## Run locally

Requires Node.js 18 or later.

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
   plan for a classroom session; free plans may sleep or restart. The host's
   health check and restart policy can recover a failed process, but cannot
   prevent every outage.

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
