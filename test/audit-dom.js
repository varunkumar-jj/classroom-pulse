'use strict';

// Temporary audit helper: verifies every getElementById() a page needs actually
// exists in that page's HTML, covering both external scripts and inline blocks.

const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');

// Socket.IO serves its browser client at /socket.io/socket.io.js at runtime,
// so it is never a file in public/.
const isRuntimeRoute = (href) => href.startsWith('socket.io/');

// video-room.js is shared by the teacher, student, and manager pages. These
// elements exist on only some of them and every use is already null-guarded,
// so their absence is intentional rather than a missing-id defect.
// shareScreenBtn is deliberately absent from student.html: students do not get
// a screen-share control, while the teacher and manager pages keep one.
const OPTIONAL_SHARED_IDS = new Set([
  'videoRoomCode',
  'videoConnectionStatus',
  'videoPeerCount',
  'shareScreenBtn'
]);

const pages = ['participants.html', 'student.html', 'teacher.html', 'home.html', 'report.html'];

let failures = 0;

for (const page of pages) {
  const htmlPath = path.join(publicDir, page);
  if (!fs.existsSync(htmlPath)) { console.log(`SKIP ${page} (missing)`); continue; }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  const sources = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) sources.push(['inline', m[1]]);
  for (const m of html.matchAll(/<script[^>]+src="\/([^"?]+)"/g)) {
    if (isRuntimeRoute(m[1])) continue;
    const scriptPath = path.join(publicDir, m[1]);
    if (!fs.existsSync(scriptPath)) { failures++; console.log(`FAIL ${page} -> missing script ${m[1]}`); continue; }
    sources.push([m[1], fs.readFileSync(scriptPath, 'utf8')]);
  }

  const needed = new Map();
  for (const [label, src] of sources) {
    for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!needed.has(m[1])) needed.set(m[1], label);
    }
  }

  const missing = [];
  const optional = [];
  for (const [id, label] of needed) {
    if (htmlIds.has(id)) continue;
    if (OPTIONAL_SHARED_IDS.has(id)) optional.push(`${id} (from ${label})`);
    else missing.push(`${id} (from ${label})`);
  }

  if (missing.length) {
    failures += missing.length;
    console.log(`FAIL ${page}: ${missing.length} missing id(s)`);
    missing.forEach((id) => console.log(`   - #${id}`));
  } else {
    console.log(`OK   ${page}: ${needed.size - optional.length} ids resolved` + (optional.length ? `, ${optional.length} optional (${optional.join(', ')})` : ''));
  }

  for (const m of html.matchAll(/<link[^>]+href="\/([^"?]+\.css)"/g)) {
    if (!fs.existsSync(path.join(publicDir, m[1]))) {
      failures++;
      console.log(`FAIL ${page} -> missing stylesheet ${m[1]}`);
    }
  }
}

// Icon placeholders such as <i class="icon-video"> render invisible unless a
// matching rule exists, so verify every referenced icon has a CSS definition
// somewhere in that page's own stylesheets (including ones injected by script).
for (const page of pages) {
  const htmlPath = path.join(publicDir, page);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');

  const iconRefs = new Set([...html.matchAll(/\bicon-([a-z0-9-]+)/g)].map((m) => m[1]));
  for (const m of html.matchAll(/<script[^>]+src="\/([^"?]+\.js)"/g)) {
    const scriptPath = path.join(publicDir, m[1]);
    if (!fs.existsSync(scriptPath)) continue;
    for (const s of fs.readFileSync(scriptPath, 'utf8').matchAll(/\bicon-([a-z0-9-]+)/g)) iconRefs.add(s[1]);
  }
  if (!iconRefs.size) continue;

  const cssSources = [];
  for (const m of html.matchAll(/<link[^>]+href="\/([^"?]+\.css)"/g)) {
    const cssPath = path.join(publicDir, m[1]);
    if (fs.existsSync(cssPath)) cssSources.push(fs.readFileSync(cssPath, 'utf8'));
  }
  const allCss = cssSources.join('\n');

  const undefinedIcons = [...iconRefs].filter((name) => !new RegExp(`\\.icon-${name}\\b`).test(allCss));
  if (undefinedIcons.length) {
    failures += undefinedIcons.length;
    console.log(`FAIL ${page}: icon(s) referenced but never styled: ${undefinedIcons.map((n) => '.icon-' + n).join(', ')}`);
  } else {
    console.log(`OK   ${page}: ${iconRefs.size} icon class(es) styled`);
  }
}

console.log(failures ? `\n${failures} problem(s) found` : '\nAll pages resolve their DOM ids, icons, and assets.');
process.exit(failures ? 1 : 0);
