/**
 * One-shot acceptance suite for the cue-deviation service.
 *
 * Runs against the compose network (API_URL / WEB_URL) and verifies:
 *   1. small reference cases with known exact distances,
 *   2. 50_000-item sparse-edit samples (exact value / exceeded signal),
 *   3. stable error codes for invalid JSON, non-integers and out-of-range input,
 *   4. the web page and its /api proxy integration,
 *   5. the performance session console lifecycle through the web proxy,
 *      including refresh reload and the sealed read-only timeline,
 *   6. global cross-session requestId deduplication: barrier-interleaved
 *      "two sessions", "create vs modify" and "retarget after commit"
 *      groups, checking success counts, the first-owner attribution,
 *      per-session snapshots and the duplicate error verdict,
 *   7. the host-published WEB_PORT override reaches the same stack.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WEB_URL = (process.env.WEB_URL ?? 'http://localhost:4173').replace(/\/$/, '');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitFor(name, url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`Service not ready: ${name} (${url})`);
  return false;
}

async function postDistance(base, payload) {
  const res = await fetch(`${base}/api/distance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function postRaw(base, raw) {
  const res = await fetch(`${base}/api/distance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, body };
}

// ----------------------------------------------------- performance commands

let commandSeq = 0;
function commandRequestId(label) {
  commandSeq += 1;
  return `verify-${label}-${Date.now()}-${commandSeq}`;
}

async function sendCommand(base, payload, { raw = false } = {}) {
  const res = await fetch(`${base}/api/performances/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? payload : JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, body };
}

async function getPerformance(base, id) {
  const res = await fetch(`${base}/api/performances/${id}`);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, body };
}

function expectExact(name, response, distance, k) {
  check(
    name,
    response.status === 200 &&
      response.body?.status === 'ok' &&
      response.body?.distance === distance &&
      response.body?.k === k,
    `got ${response.status} ${JSON.stringify(response.body)}`,
  );
}

function expectExceeded(name, response, k) {
  check(
    name,
    response.status === 200 &&
      response.body?.status === 'exceeded' &&
      response.body?.k === k &&
      !('distance' in (response.body ?? {})),
    `got ${response.status} ${JSON.stringify(response.body)}`,
  );
}

function expectError(name, response, status, code) {
  check(
    name,
    response.status === status && response.body?.error?.code === code,
    `got ${response.status} ${JSON.stringify(response.body)}`,
  );
}

// ---------------------------------------------------------------- 50k samples

function buildSparseSample() {
  // 100 deletions + 100 insertions + 50 substitutions (x2) => distance 300.
  const N = 50_000;
  const a = Array.from({ length: N }, (_, i) => i + 1);
  const del = new Set();
  for (let d = 0; d < 100; d++) del.add(499 + d * 500);
  const sub = new Map();
  for (let s = 0; s < 50; s++) sub.set(250 + s * 500, 2_000_000 + s);
  const insAfter = new Map();
  for (let t = 0; t < 100; t++) insAfter.set(374 + t * 500, 1_000_000 + t);
  const b = [];
  for (let i = 0; i < N; i++) {
    if (del.has(i)) continue;
    b.push(sub.has(i) ? sub.get(i) : a[i]);
    if (insAfter.has(i)) b.push(insAfter.get(i));
  }
  return { a, b };
}

function buildSubstitutionSample(count, seedOffset, valueBase) {
  const N = 50_000;
  const a = Array.from({ length: N }, (_, i) => i + 1);
  const b = a.slice();
  for (let s = 0; s < count; s++) b[seedOffset + s * 199] = valueBase + s;
  return { a, b };
}

// ---------------------------------------------------------------------- main

console.log(`verify: API_URL=${API_URL} WEB_URL=${WEB_URL}`);

const ready =
  (await waitFor('api', `${API_URL}/api/health`)) && (await waitFor('web', `${WEB_URL}/`));
if (!ready) process.exit(1);

console.log('\n[1] small reference cases');
const smallCases = [
  // [a, b, k, expected ('exceeded' or exact distance)]
  [[], [], 0, 0],
  [[], [1, 2, 3], 3, 3],
  [[], [1, 2, 3], 2, 'exceeded'],
  [[7, 8, 9], [], 3, 3],
  [[1, 2, 3], [1, 2, 3], 0, 0],
  [[1], [2], 2, 2],
  [[1], [2], 1, 'exceeded'],
  [[1, 2, 3], [1, 3], 1, 1],
  [[1, 3], [1, 2, 3], 1, 1],
  [[7, 7, 7], [7, 7], 1, 1],
  [[1, 2, 1, 2], [2, 1, 2, 1], 2, 2],
  [[1, 2, 3, 4, 5], [4, 5], 3, 3],
  [[1, 2, 3, 4, 5], [1, 2], 3, 3],
  [[1, 2, 3, 4, 5], [1, 2], 2, 'exceeded'],
  [[1, 2, 3], [4, 5, 6], 6, 6],
  [[1, 2, 3], [4, 5, 6], 5, 'exceeded'],
  [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 8, 8],
  [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 7, 'exceeded'],
  [[-2147483648, 2147483647], [-2147483648, 2147483647], 0, 0],
  [[-2147483648], [2147483647], 2, 2],
  [[10, 20, 30], [10, 20, 30, 40, 50], 2, 2],
  [[10, 20, 30], [10, 20, 30, 40, 50], 1, 'exceeded'],
];
for (const [i, [a, b, k, expected]] of smallCases.entries()) {
  const res = await postDistance(API_URL, { a, b, k });
  const name = `case #${i + 1} (|a|=${a.length}, |b|=${b.length}, k=${k})`;
  if (expected === 'exceeded') expectExceeded(name, res, k);
  else expectExact(name, res, expected, k);
}

console.log('\n[2] 50k sparse-edit samples');
{
  const { a, b } = buildSparseSample();
  expectExact('50k sparse edits, k=500 -> 300', await postDistance(API_URL, { a, b, k: 500 }), 300, 500);
  expectExact('50k sparse edits, k=300 -> 300', await postDistance(API_URL, { a, b, k: 300 }), 300, 300);
  expectExceeded('50k sparse edits, k=299 -> exceeded', await postDistance(API_URL, { a, b, k: 299 }), 299);
}
{
  const { a, b } = buildSubstitutionSample(250, 100, 3_000_000);
  expectExact('50k with 250 substitutions, k=500 -> 500', await postDistance(API_URL, { a, b, k: 500 }), 500, 500);
}
{
  const { a, b } = buildSubstitutionSample(251, 50, 4_000_000);
  expectExceeded('50k with 251 substitutions, k=500 -> exceeded', await postDistance(API_URL, { a, b, k: 500 }), 500);
}
{
  const a = Array.from({ length: 50_000 }, (_, i) => i + 1);
  const b = a.slice(0, 49_499); // length gap 501 > k
  expectExceeded('length gap 501 > k=500 -> exceeded', await postDistance(API_URL, { a, b, k: 500 }), 500);
}

console.log('\n[3] stable validation errors');
expectError('malformed JSON', await postRaw(API_URL, '{"a": [1, 2],'), 400, 'INVALID_JSON');
expectError('empty body', await postRaw(API_URL, ''), 400, 'INVALID_JSON');
expectError('non-object body', await postDistance(API_URL, [1, 2, 3]), 400, 'INVALID_BODY');
expectError('missing k', await postDistance(API_URL, { a: [1], b: [1] }), 400, 'INVALID_K');
expectError('non-integer element', await postDistance(API_URL, { a: [1.5], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('string element', await postDistance(API_URL, { a: ['1'], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('element above int32', await postDistance(API_URL, { a: [2147483648], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('element below int32', await postDistance(API_URL, { a: [-2147483649], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('k = 501', await postDistance(API_URL, { a: [], b: [], k: 501 }), 400, 'INVALID_K');
expectError('k = -1', await postDistance(API_URL, { a: [], b: [], k: -1 }), 400, 'INVALID_K');
expectError('k = 1.5', await postDistance(API_URL, { a: [], b: [], k: 1.5 }), 400, 'INVALID_K');
expectError('k as string', await postDistance(API_URL, { a: [], b: [], k: '3' }), 400, 'INVALID_K');
expectError(
  'array too long',
  await postDistance(API_URL, { a: new Array(50_001).fill(0), b: [], k: 0 }),
  400,
  'ARRAY_TOO_LONG',
);

console.log('\n[4] web page integration');
{
  const res = await fetch(`${WEB_URL}/`);
  const html = await res.text();
  check(
    'web page serves the app shell',
    res.ok && html.includes('id="root"') && html.includes('工作台'),
    `got ${res.status}`,
  );
}
{
  const res = await fetch(`${WEB_URL}/api/health`);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  check('web proxy reaches the API', res.ok && body?.status === 'ok', `got ${res.status}`);
}
{
  const res = await postDistance(WEB_URL, { a: [1, 2, 3], b: [1, 3, 4], k: 5 });
  expectExact('distance request through the web proxy', res, 2, 5);
}

console.log('\n[5] performance session lifecycle through the web proxy');
let perfId;
{
  // Create: pending, version 1, empty cues.
  const create = await sendCommand(WEB_URL, {
    command: 'create',
    name: '9 月 17 日晚场（验收）',
    requestId: commandRequestId('create'),
  });
  check(
    'create performance via web proxy -> 200 pending v1',
    create.status === 200 &&
      typeof create.body?.performance?.id === 'string' &&
      create.body.performance.status === 'pending' &&
      create.body.performance.version === 1 &&
      Array.isArray(create.body.performance.cues) &&
      create.body.performance.cues.length === 0,
    `got ${create.status} ${JSON.stringify(create.body)}`,
  );
  perfId = create.body.performance.id;

  // pending -> running is the only legal first advance.
  const illegal = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'ended',
    expectedVersion: 1,
    requestId: commandRequestId('illegal'),
  });
  check(
    'pending -> ended rejected as ILLEGAL_TRANSITION',
    illegal.status === 409 &&
      illegal.body?.error?.code === 'COMMAND_REJECTED' &&
      illegal.body?.error?.reason === 'ILLEGAL_TRANSITION',
    `got ${illegal.status} ${JSON.stringify(illegal.body)}`,
  );

  const start = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('start'),
  });
  check(
    'advance to running -> v2',
    start.status === 200 && start.body?.performance?.status === 'running' &&
      start.body?.performance?.version === 2,
    `got ${start.status} ${JSON.stringify(start.body)}`,
  );

  // Register cues one by one while running, including int32 extremes.
  const cues = [101, 205, -2147483648, 2147483647, 330];
  for (let i = 0; i < cues.length; i++) {
    const res = await sendCommand(WEB_URL, {
      command: 'registerCue',
      performanceId: perfId,
      cue: cues[i],
      expectedVersion: 2 + i,
      requestId: commandRequestId(`cue-${i}`),
    });
    check(
      `register cue ${cues[i]} -> version ${3 + i}`,
      res.status === 200 &&
        res.body?.performance?.version === 3 + i &&
        res.body?.performance?.cues?.length === i + 1,
      `got ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  // Toggle running -> paused -> running; writes must fail while paused.
  const pause = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'paused',
    expectedVersion: 7,
    requestId: commandRequestId('pause'),
  });
  check('pause -> v8 paused', pause.status === 200 &&
    pause.body?.performance?.status === 'paused' &&
    pause.body?.performance?.version === 8,
    `got ${pause.status}`);

  const writeWhilePaused = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: perfId,
    cue: 999,
    expectedVersion: 8,
    requestId: commandRequestId('paused-write'),
  });
  check(
    'cue write while paused rejected as NOT_RUNNING',
    writeWhilePaused.status === 409 &&
      writeWhilePaused.body?.error?.reason === 'NOT_RUNNING',
    `got ${writeWhilePaused.status} ${JSON.stringify(writeWhilePaused.body)}`,
  );

  const resume = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'running',
    expectedVersion: 8,
    requestId: commandRequestId('resume'),
  });
  check('resume -> v9 running', resume.status === 200 &&
    resume.body?.performance?.version === 9,
    `got ${resume.status}`);

  // Stale expectedVersion is rejected and changes nothing.
  const stale = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: perfId,
    cue: 777,
    expectedVersion: 2,
    requestId: commandRequestId('stale'),
  });
  check(
    'stale expectedVersion rejected as VERSION_CONFLICT',
    stale.status === 409 && stale.body?.error?.reason === 'VERSION_CONFLICT',
    `got ${stale.status} ${JSON.stringify(stale.body)}`,
  );

  // A repeated request id is a no-op duplicate (same id as the resume).
  const duplicate = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'ended',
    expectedVersion: 9,
    requestId: resume.body?.performance?.requestId ?? 'unknown',
  });
  check(
    'reused requestId rejected as DUPLICATE_REQUEST',
    duplicate.status === 409 && duplicate.body?.error?.reason === 'DUPLICATE_REQUEST',
    `got ${duplicate.status} ${JSON.stringify(duplicate.body)}`,
  );

  // End the show.
  const end = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'ended',
    expectedVersion: 9,
    requestId: commandRequestId('end'),
  });
  check('end -> v10 ended', end.status === 200 &&
    end.body?.performance?.status === 'ended' &&
    end.body?.performance?.version === 10,
    `got ${end.status}`);

  const writeAfterEnd = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: perfId,
    cue: 1,
    expectedVersion: 10,
    requestId: commandRequestId('after-end'),
  });
  check(
    'cue write after end rejected as NOT_RUNNING',
    writeAfterEnd.status === 409 && writeAfterEnd.body?.error?.reason === 'NOT_RUNNING',
    `got ${writeAfterEnd.status} ${JSON.stringify(writeAfterEnd.body)}`,
  );

  // Refresh = load the snapshot by id through the web proxy; the timeline
  // is sealed and preserves every cue in registration order.
  const reloaded = await getPerformance(WEB_URL, perfId);
  check(
    'GET by id after refresh loads sealed timeline',
    reloaded.status === 200 &&
      reloaded.body?.performance?.status === 'ended' &&
      reloaded.body?.performance?.version === 10 &&
      JSON.stringify(reloaded.body?.performance?.cues) === JSON.stringify(cues),
    `got ${reloaded.status} ${JSON.stringify(reloaded.body)}`,
  );

  // Missing object -> SESSION_NOT_FOUND.
  const missing = await getPerformance(WEB_URL, 'no-such-session-id');
  check(
    'GET missing performance -> 404 SESSION_NOT_FOUND',
    missing.status === 404 && missing.body?.error?.code === 'SESSION_NOT_FOUND',
    `got ${missing.status} ${JSON.stringify(missing.body)}`,
  );

  const invalidCue = await sendCommand(WEB_URL, {
    command: 'create',
    name: ['not', 'a', 'string'],
    requestId: commandRequestId('bad-envelope'),
  });
  check(
    'invalid command envelope -> 400 INVALID_BODY',
    invalidCue.status === 400 && invalidCue.body?.error?.code === 'INVALID_BODY',
    `got ${invalidCue.status} ${JSON.stringify(invalidCue.body)}`,
  );
}

// ------------------------------------------------- planned-session tracking
//
// A create may fix a planned cue sequence + tolerance k. Each committed
// live cue must update the incremental prefix-distance frontier: the
// boundary is min over planned prefixes of the distance from the whole live
// prefix heard so far; boundary <= k means "still recoverable". Ending
// compares the whole live sequence with the whole plan. Rejected commands
// (version conflict / non-running) and request-id replays must never move
// the frontier. A short-sequence full-DP oracle checks every boundary.

function fullEditDistance(a, b) {
  const n = a.length;
  const m = b.length;
  const d = [];
  for (let i = 0; i <= n; i++) {
    d.push(new Array(m + 1).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 2),
      );
    }
  }
  return d;
}

function oracleBoundary(table, i, m, k) {
  let min = Infinity;
  for (let j = 0; j <= m; j++) min = Math.min(min, table[i][j]);
  return Math.min(min, k + 1);
}

console.log('\n[5b] planned session: per-cue frontier, final verdict and no-advance rejections');
{
  // Two stray cues (9, 8) against plan [1..4] cannot both be deleted within
  // k = 1; the frontier flips to unrecoverable after the second stray and
  // never recovers even after the remaining plan arrives perfectly.
  const plan = [1, 2, 3, 4];
  const live = [1, 2, 9, 8, 3, 4];
  const K = 1;
  const table = fullEditDistance(live, plan);

  const create = await sendCommand(WEB_URL, {
    command: 'create',
    name: '计划场次-边界',
    requestId: commandRequestId('plan-create'),
    planCues: plan,
    k: K,
  });
  check(
    'planned create -> pending v1 with sealed plan + zero-cue boundary',
    create.status === 200 &&
      create.body?.performance?.status === 'pending' &&
      create.body?.performance?.version === 1 &&
      JSON.stringify(create.body?.performance?.plan?.cues) === JSON.stringify(plan) &&
      create.body?.performance?.plan?.k === K &&
      create.body?.performance?.deviation?.liveLength === 0 &&
      create.body?.performance?.deviation?.boundary === 0 &&
      create.body?.performance?.deviation?.recoverable === true &&
      create.body?.performance?.deviation?.final === null,
    `got ${create.status} ${JSON.stringify(create.body)}`,
  );
  const id = create.body.performance.id;

  let start = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('plan-start'),
  });
  check('planned session running v2', start.status === 200 &&
    start.body?.performance?.version === 2, `got ${start.status}`);

  let lastVersion = 2;
  let flipVersion = null;
  for (let i = 0; i < live.length; i++) {
    const expectedVersion = lastVersion;
    const res = await sendCommand(WEB_URL, {
      command: 'registerCue',
      performanceId: id,
      cue: live[i],
      expectedVersion,
      requestId: commandRequestId(`plan-cue-${i}`),
    });
    const dev = res.body?.performance?.deviation;
    const wantBoundary = oracleBoundary(table, i + 1, plan.length, K);
    const wantRecoverable = wantBoundary <= K;
    check(
      `cue #${i + 1} (${live[i]}) frontier matches full-DP oracle (boundary ${wantBoundary}, ${wantRecoverable ? 'recoverable' : 'exceeded'})`,
      res.status === 200 &&
        res.body?.performance?.version === expectedVersion + 1 &&
        dev?.liveLength === i + 1 &&
        dev?.boundary === wantBoundary &&
        dev?.recoverable === wantRecoverable &&
        dev?.final === null &&
        // The plan is echoed unchanged on every version.
        JSON.stringify(res.body?.performance?.plan?.cues) === JSON.stringify(plan),
      `got ${res.status} ${JSON.stringify(res.body)} (want boundary ${wantBoundary})`,
    );
    lastVersion = expectedVersion + 1;
    if (!wantRecoverable && flipVersion === null) flipVersion = lastVersion;
  }
  check('frontier flipped unrecoverable exactly once (after the second stray cue)', flipVersion === 6,
    `flipVersion=${flipVersion}`);

  // Stale-version cue: rejected, frontier and version must not move.
  const beforeStale = (await getPerformance(WEB_URL, id)).body.performance;
  const stale = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: id,
    cue: 123,
    expectedVersion: 2, // far behind current version
    requestId: commandRequestId('plan-stale'),
  });
  check(
    'stale cue rejected VERSION_CONFLICT with frontier untouched',
    stale.status === 409 && stale.body?.error?.reason === 'VERSION_CONFLICT',
    `got ${stale.status} ${JSON.stringify(stale.body)}`,
  );
  const afterStale = (await getPerformance(WEB_URL, id)).body.performance;
  check(
    'rejected cue changed neither version nor deviation',
    afterStale.version === beforeStale.version &&
      JSON.stringify(afterStale.deviation) === JSON.stringify(beforeStale.deviation) &&
      JSON.stringify(afterStale.cues) === JSON.stringify(beforeStale.cues),
    `before ${JSON.stringify({ v: beforeStale.version, d: beforeStale.deviation })} after ${JSON.stringify({ v: afterStale.version, d: afterStale.deviation })}`,
  );

  // Pause -> NOT_RUNNING cue must not advance; resume -> cue advances; end
  // from a second pause must produce the whole-plan final verdict.
  const pause = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'paused',
    expectedVersion: lastVersion,
    requestId: commandRequestId('plan-pause'),
  });
  check('pause ok', pause.status === 200 &&
    pause.body?.performance?.status === 'paused', `got ${pause.status}`);
  lastVersion += 1;

  const whilePaused = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: id,
    cue: 777,
    expectedVersion: lastVersion,
    requestId: commandRequestId('plan-paused-write'),
  });
  check(
    'cue while paused rejected NOT_RUNNING, frontier frozen',
    whilePaused.status === 409 &&
      whilePaused.body?.error?.reason === 'NOT_RUNNING' &&
      (await getPerformance(WEB_URL, id)).body.performance.deviation.liveLength === live.length,
    `got ${whilePaused.status} ${JSON.stringify(whilePaused.body)}`,
  );

  const resume = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: lastVersion,
    requestId: commandRequestId('plan-resume'),
  });
  check('resume ok', resume.status === 200 &&
    resume.body?.performance?.deviation?.liveLength === live.length, `got ${resume.status}`);
  lastVersion += 1;

  // Same request id as the paused rejection: still reusable after the
  // precondition is corrected (one frontier step, then one more).
  const retryId = commandRequestId('plan-paused-retry');
  const afterResume = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: id,
    cue: 5,
    expectedVersion: lastVersion,
    requestId: retryId,
  });
  check(
    'rejected id reused after resume commits once (liveLength + 1)',
    afterResume.status === 200 &&
      afterResume.body?.performance?.deviation?.liveLength === live.length + 1,
    `got ${afterResume.status} ${JSON.stringify(afterResume.body)}`,
  );
  lastVersion += 1;
  const replay = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: id,
    cue: 6,
    expectedVersion: lastVersion,
    requestId: retryId,
  });
  check(
    'replaying the now-committed id is DUPLICATE_REQUEST and does not advance',
    replay.status === 409 && replay.body?.error?.reason === 'DUPLICATE_REQUEST' &&
      (await getPerformance(WEB_URL, id)).body.performance.deviation.liveLength === live.length + 1,
    `got ${replay.status} ${JSON.stringify(replay.body)}`,
  );

  // Seal directly from paused; the final comparison is against the WHOLE
  // plan (the oracle's full-table bottom-right), not the min-prefix bound.
  await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'paused',
    expectedVersion: lastVersion,
    requestId: commandRequestId('plan-pause2'),
  });
  lastVersion += 1;
  const end = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'ended',
    expectedVersion: lastVersion,
    requestId: commandRequestId('plan-end'),
  });
  const exactFinal = table[live.length][plan.length];
  const wantFinal = exactFinal <= K ? { status: 'ok', distance: exactFinal } : { status: 'exceeded' };
  check(
    'end compares whole live run with whole plan (oracle final verdict)',
    end.status === 200 &&
      end.body?.performance?.status === 'ended' &&
      JSON.stringify(end.body?.performance?.deviation?.final) === JSON.stringify(wantFinal),
    `got ${end.status} final=${JSON.stringify(end.body?.performance?.deviation?.final)} want ${JSON.stringify(wantFinal)}`,
  );
  check('whole-plan final here is exceeded (two stray deletions, k=1)', exactFinal > K,
    `exactFinal=${exactFinal}`);
}

// A plan within budget end to end: exact final distance is reported.
{
  const plan = [101, 102, 103];
  const live = [101, 102, 205, 103]; // one extra cue -> distance 1
  const create = await sendCommand(WEB_URL, {
    command: 'create',
    name: '计划场次-可追回',
    requestId: commandRequestId('planok-create'),
    planCues: plan,
    k: 2,
  });
  const id = create.body.performance.id;
  await sendCommand(WEB_URL, {
    command: 'transition', performanceId: id, status: 'running',
    expectedVersion: 1, requestId: commandRequestId('planok-start'),
  });
  let v = 2;
  for (let i = 0; i < live.length; i++) {
    const res = await sendCommand(WEB_URL, {
      command: 'registerCue', performanceId: id, cue: live[i],
      expectedVersion: v, requestId: commandRequestId(`planok-cue-${i}`),
    });
    check(`recoverable session cue #${i + 1} stays recoverable`,
      res.status === 200 && res.body?.performance?.deviation?.recoverable === true,
      JSON.stringify(res.body));
    v += 1;
  }
  const end = await sendCommand(WEB_URL, {
    command: 'transition', performanceId: id, status: 'ended',
    expectedVersion: v, requestId: commandRequestId('planok-end'),
  });
  check(
    'recoverable whole-plan final reports exact distance 1',
    end.status === 200 &&
      JSON.stringify(end.body?.performance?.deviation?.final) === JSON.stringify({ status: 'ok', distance: 1 }),
    `got ${JSON.stringify(end.body?.performance?.deviation?.final)}`,
  );
}

// Legacy session (no plan): plan/deviation stay null across the lifecycle.
{
  const create = await sendCommand(WEB_URL, {
    command: 'create',
    name: '旧场次兼容',
    requestId: commandRequestId('legacy-create'),
  });
  const id = create.body.performance.id;
  check('legacy create has null plan/deviation',
    create.status === 200 && create.body?.performance?.plan === null &&
      create.body?.performance?.deviation === null,
    JSON.stringify(create.body));
  await sendCommand(WEB_URL, {
    command: 'transition', performanceId: id, status: 'running',
    expectedVersion: 1, requestId: commandRequestId('legacy-start'),
  });
  const cue = await sendCommand(WEB_URL, {
    command: 'registerCue', performanceId: id, cue: 1,
    expectedVersion: 2, requestId: commandRequestId('legacy-cue'),
  });
  const end = await sendCommand(WEB_URL, {
    command: 'transition', performanceId: id, status: 'ended',
    expectedVersion: 3, requestId: commandRequestId('legacy-end'),
  });
  check('legacy session keeps null plan/deviation through cues and end',
    cue.body?.performance?.plan === null && cue.body?.performance?.deviation === null &&
      end.body?.performance?.plan === null && end.body?.performance?.deviation === null,
    JSON.stringify({ cue: cue.body?.performance?.deviation, end: end.body?.performance?.deviation }));
}

// Cross-session: two planned sessions keep independent plans/frontiers.
{
  const a = await sendCommand(WEB_URL, {
    command: 'create', name: '计划跨场-A', requestId: commandRequestId('xpa-create'),
    planCues: [1, 2], k: 0,
  });
  const b = await sendCommand(WEB_URL, {
    command: 'create', name: '计划跨场-B', requestId: commandRequestId('xpb-create'),
    planCues: [9, 8, 7], k: 5,
  });
  for (const [p, label] of [[a, 'a'], [b, 'b']]) {
    await sendCommand(WEB_URL, {
      command: 'transition', performanceId: p.body.performance.id, status: 'running',
      expectedVersion: 1, requestId: commandRequestId(`xp-${label}-start`),
    });
  }
  const badA = await sendCommand(WEB_URL, {
    command: 'registerCue', performanceId: a.body.performance.id, cue: 5,
    expectedVersion: 2, requestId: commandRequestId('xp-a-bad'),
  });
  const goodB = await sendCommand(WEB_URL, {
    command: 'registerCue', performanceId: b.body.performance.id, cue: 9,
    expectedVersion: 2, requestId: commandRequestId('xp-b-good'),
  });
  check('cross-session: A k=0 off-plan unrecoverable while B k=5 stays recoverable',
    badA.body?.performance?.deviation?.recoverable === false &&
      goodB.body?.performance?.deviation?.recoverable === true &&
      JSON.stringify(goodB.body?.performance?.plan?.cues) === JSON.stringify([9, 8, 7]),
    `A=${JSON.stringify(badA.body?.performance?.deviation)} B=${JSON.stringify(goodB.body?.performance?.deviation)}`);
}

// Plan envelope validation.
{
  const half1 = await sendCommand(WEB_URL, {
    command: 'create', name: '半截计划', requestId: commandRequestId('planv-half1'), planCues: [1],
  });
  const half2 = await sendCommand(WEB_URL, {
    command: 'create', name: '半截计划', requestId: commandRequestId('planv-half2'), k: 2,
  });
  const badElem = await sendCommand(WEB_URL, {
    command: 'create', name: '坏元素', requestId: commandRequestId('planv-elem'),
    planCues: [1, 'x'], k: 2,
  });
  const badK = await sendCommand(WEB_URL, {
    command: 'create', name: '坏 K', requestId: commandRequestId('planv-k'),
    planCues: [], k: 501,
  });
  check('planCues without k -> INVALID_BODY',
    half1.status === 400 && half1.body?.error?.code === 'INVALID_BODY', JSON.stringify(half1.body));
  check('k without planCues -> INVALID_BODY',
    half2.status === 400 && half2.body?.error?.code === 'INVALID_BODY', JSON.stringify(half2.body));
  check('non-int plan element -> INVALID_ELEMENT',
    badElem.status === 400 && badElem.body?.error?.code === 'INVALID_ELEMENT', JSON.stringify(badElem.body));
  check('k=501 plan -> INVALID_K',
    badK.status === 400 && badK.body?.error?.code === 'INVALID_K', JSON.stringify(badK.body));
}

// Rejections must not consume the request id, and paused sessions can be
// sealed straight to ended without a resume.
{
  const create = await sendCommand(WEB_URL, {
    command: 'create',
    name: '失败更正重试',
    requestId: commandRequestId('fix-create'),
  });
  const id = create.body.performance.id;

  const replayEnvelope = {
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('fix-replay'),
  };

  // Wrong target status first (pending -> ended): rejected, no side effect.
  replayEnvelope.status = 'ended';
  const illegal = await sendCommand(WEB_URL, replayEnvelope);
  check(
    'first attempt rejected as ILLEGAL_TRANSITION',
    illegal.status === 409 && illegal.body?.error?.reason === 'ILLEGAL_TRANSITION',
    `got ${illegal.status} ${JSON.stringify(illegal.body)}`,
  );

  // Correct the condition while reusing the same request id: must commit.
  replayEnvelope.status = 'running';
  const retried = await sendCommand(WEB_URL, replayEnvelope);
  check(
    'same requestId commits after correction -> v2 running',
    retried.status === 200 &&
      retried.body?.performance?.version === 2 &&
      retried.body?.performance?.status === 'running',
    `got ${retried.status} ${JSON.stringify(retried.body)}`,
  );

  // Pause, then seal directly from paused (no resume required).
  const pause = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'paused',
    expectedVersion: 2,
    requestId: commandRequestId('fix-pause'),
  });
  check('fix session paused v3', pause.status === 200 &&
    pause.body?.performance?.status === 'paused',
    `got ${pause.status}`);

  const sealed = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'ended',
    expectedVersion: 3,
    requestId: commandRequestId('fix-end'),
  });
  check(
    'paused -> ended directly -> v4 ended',
    sealed.status === 200 &&
      sealed.body?.performance?.status === 'ended' &&
      sealed.body?.performance?.version === 4,
    `got ${sealed.status} ${JSON.stringify(sealed.body)}`,
  );

  // Stale-version rejection followed by same-id corrected retry on a fresh
  // session: VERSION_CONFLICT must not poison the request id either.
  const c2 = await sendCommand(WEB_URL, {
    command: 'create',
    name: '版本冲突重试',
    requestId: commandRequestId('fix2-create'),
  });
  const id2 = c2.body.performance.id;
  const cueEnvelope = {
    command: 'registerCue',
    performanceId: id2,
    cue: 808,
    expectedVersion: 1,
    requestId: commandRequestId('fix2-replay'),
  };
  const stale = await sendCommand(WEB_URL, cueEnvelope);
  check(
    'cue at pending v1 rejected as NOT_RUNNING',
    stale.status === 409 && stale.body?.error?.reason === 'NOT_RUNNING',
    `got ${stale.status}`,
  );
  await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id2,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('fix2-start'),
  });
  cueEnvelope.expectedVersion = 2;
  const cueOk = await sendCommand(WEB_URL, cueEnvelope);
  check(
    'same cue requestId commits after start -> v3',
    cueOk.status === 200 &&
      cueOk.body?.performance?.version === 3 &&
      JSON.stringify(cueOk.body?.performance?.cues) === '[808]',
    `got ${cueOk.status} ${JSON.stringify(cueOk.body)}`,
  );
}

// Same-version concurrency against the API directly: exactly one commit.
{
  const create = await sendCommand(API_URL, {
    command: 'create',
    name: '并发场次',
    requestId: commandRequestId('cc-create'),
  });
  const id = create.body.performance.id;
  await sendCommand(API_URL, {
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('cc-start'),
  });

  const burst = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      sendCommand(API_URL, {
        command: 'registerCue',
        performanceId: id,
        cue: 1000 + i,
        expectedVersion: 2,
        requestId: commandRequestId(`cc-cue-${i}`),
      }),
    ),
  );
  const committed = burst.filter((r) => r.status === 200);
  const conflicts = burst.filter(
    (r) => r.status === 409 && r.body?.error?.reason === 'VERSION_CONFLICT',
  );
  check(
    'five same-version concurrent cues: exactly one commits',
    committed.length === 1 && conflicts.length === 4,
    `statuses=${burst.map((r) => r.status).join(',')}`,
  );

  const final = await getPerformance(API_URL, id);
  check(
    'winner cue committed once, version 3',
    final.body?.performance?.cues?.length === 1 &&
      final.body?.performance?.cues[0] === committed[0].body.performance.cues[0] &&
      final.body?.performance?.version === 3,
    `got ${JSON.stringify(final.body)}`,
  );
}

// ------------------------------------------------- global request dedup
//
// A requestId is a global idempotency key for the whole service life: the
// same id may commit exactly once, no matter which session (or a create)
// it targets. Each racing group is released from a cyclic barrier so the
// contenders genuinely overlap inside the server's adjudication.

class CyclicBarrier {
  constructor(size) {
    this.size = size;
    this.waiting = 0;
    this.arrived = [];
  }

  hit() {
    const mine = new Promise((resolve) => this.arrived.push(resolve));
    this.waiting += 1;
    if (this.waiting === this.size) {
      const all = this.arrived.splice(0);
      // One macrotask later: every request has entered its adjudication
      // chain before any contender is allowed to settle.
      setTimeout(() => all.forEach((release) => release()), 10);
    }
    return mine;
  }
}

async function raceBarriered(base, payloads, barrier) {
  return Promise.all(
    payloads.map(async (payload) => {
      const promise = sendCommand(base, payload);
      await barrier.hit();
      return promise;
    }),
  );
}

async function createPerformance(base, name, requestId) {
  const res = await sendCommand(base, { command: 'create', name, requestId });
  if (res.status !== 200) {
    throw new Error(`setup create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.performance;
}

function expectDuplicate(name, res, ownerId) {
  const ok =
    res.status === 409 &&
    res.body?.error?.code === 'COMMAND_REJECTED' &&
    res.body?.error?.reason === 'DUPLICATE_REQUEST' &&
    res.body?.error?.message?.includes(ownerId);
  check(
    name,
    ok,
    `got ${res.status} ${JSON.stringify(res.body)} (expected DUPLICATE_REQUEST owned by ${ownerId})`,
  );
}

async function expectSnapshot(name, base, id, expected) {
  const res = await getPerformance(base, id);
  const p = res.body?.performance;
  const ok =
    res.status === 200 &&
    Object.entries(expected).every(([k, v]) =>
      Array.isArray(v) ? JSON.stringify(p?.[k]) === JSON.stringify(v) : p?.[k] === v,
    );
  check(name, ok, `got ${res.status} ${JSON.stringify(res.body)}`);
}

console.log('\n[6] global cross-session requestId deduplication');

// Unique run suffix: the server keeps the global id map in memory, so the
// suite must not reuse fixed ids across repeated runs against one server.
const gdRun = `gd-${Date.now()}-${commandSeq}`;

// Group A: "two sessions" — the same id drives a cue/transition on two
// distinct sessions simultaneously. Exactly one may commit.
{
  const s1 = await createPerformance(API_URL, '跨场次-A', `gd-a-create-${gdRun}`);
  const s2 = await createPerformance(API_URL, '跨场次-B', `gd-b-create-${gdRun}`);
  for (const [s, label] of [[s1, 'a'], [s2, 'b']]) {
    const start = await sendCommand(API_URL, {
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: `gd-${label}-start-${gdRun}`,
    });
    check(`group A: ${label} running v2`, start.status === 200, JSON.stringify(start.body));
  }

  const shared = `gd-two-sessions-cue-${gdRun}`;
  const [r1, r2] = await raceBarriered(
    API_URL,
    [
      {
        command: 'registerCue',
        performanceId: s1.id,
        cue: 101,
        expectedVersion: 2,
        requestId: shared,
      },
      {
        command: 'registerCue',
        performanceId: s2.id,
        cue: 202,
        expectedVersion: 2,
        requestId: shared,
      },
    ],
    new CyclicBarrier(2),
  );

  const committed = [r1, r2].filter((r) => r.status === 200);
  const losers = [r1, r2].filter((r) => r.status !== 200);
  check(
    'group A: exactly one of two same-id cues commits',
    committed.length === 1 && losers.length === 1,
    `statuses=${[r1.status, r2.status].join(',')}`,
  );

  const winner = committed[0]?.body?.performance;
  check(
    'group A: loser is DUPLICATE_REQUEST naming the winner',
    losers[0]?.status === 409 &&
      losers[0]?.body?.error?.reason === 'DUPLICATE_REQUEST' &&
      losers[0]?.body?.error?.message?.includes(winner?.id),
    `got ${JSON.stringify(losers[0]?.body)}`,
  );

  const winnerCue = winner.id === s1.id ? 101 : 202;
  await expectSnapshot('group A: winner advanced once (v3, own cue)', API_URL, winner.id, {
    status: 'running',
    version: 3,
    requestId: shared,
    cues: [winnerCue],
  });
  const loserId = winner.id === s1.id ? s2.id : s1.id;
  await expectSnapshot('group A: loser untouched (v2, no cues)', API_URL, loserId, {
    status: 'running',
    version: 2,
    cues: [],
  });
}

// Group B: "create vs modify" — one id used at the same time to create a
// new session and to modify an existing one. Both arrival orders are
// exercised; exactly one side may ever succeed.
for (const [order, firstLabel] of [
  ['create-first', 'create'],
  ['command-first', 'command'],
]) {
  const existing = await createPerformance(
    API_URL,
    `创建与修改-${order}`,
    `gd-cm-${order}-existing-${gdRun}`,
  );
  const shared = `gd-cm-${order}-id-${gdRun}`;
  const barrier = new CyclicBarrier(2);

  const createPayload = { command: 'create', name: `新建-${order}`, requestId: shared };
  const commandPayload = {
    command: 'transition',
    performanceId: existing.id,
    status: 'running',
    expectedVersion: 1,
    requestId: shared,
  };

  // Encode arrival order by which contender's promise is constructed
  // first; the barrier keeps the adjudication genuinely concurrent.
  const contenders =
    firstLabel === 'create' ? [createPayload, commandPayload] : [commandPayload, createPayload];
  const [first, second] = await Promise.all([
    (async () => {
      const p = sendCommand(API_URL, contenders[0]);
      await barrier.hit();
      return p;
    })(),
    (async () => {
      const p = sendCommand(API_URL, contenders[1]);
      await barrier.hit();
      return p;
    })(),
  ]);

  const results = [first, second];
  const ok = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status !== 200);
  check(
    `group B (${order}): exactly one of create/modify commits`,
    ok.length === 1 && rejected.length === 1,
    `statuses=${results.map((r) => r.status).join(',')}`,
  );

  const ownerId = ok[0]?.body?.performance?.id;
  expectDuplicate(`group B (${order}): loser duplicate names first owner`, rejected[0], ownerId);

  if (firstLabel === 'create') {
    check(
      `group B (${order}): create is the committed side`,
      first.status === 200 &&
        first.body?.performance?.status === 'pending' &&
        first.body?.performance?.version === 1 &&
        first.body?.performance?.requestId === shared,
      `got ${first.status} ${JSON.stringify(first.body)}`,
    );
    await expectSnapshot(`group B (${order}): existing session untouched`, API_URL, existing.id, {
      status: 'pending',
      version: 1,
      cues: [],
    });
  } else {
    check(
      `group B (${order}): modify is the committed side`,
      first.status === 200 &&
        first.body?.performance?.id === existing.id &&
        first.body?.performance?.status === 'running' &&
        first.body?.performance?.version === 2 &&
        first.body?.performance?.requestId === shared,
      `got ${first.status} ${JSON.stringify(first.body)}`,
    );
    // The losing create must not have materialised any session: its id is
    // only known from a successful response, which did not happen. The
    // existing session is instead exactly at the committed snapshot.
    await expectSnapshot(`group B (${order}): existing session advanced once`, API_URL, existing.id, {
      status: 'running',
      version: 2,
      requestId: shared,
      cues: [],
    });
  }
}

// Group C: "replay after commit, retargeted" — once an id has committed
// to session A, replaying it at session B, at a missing session and as a
// create all return the identical duplicate verdict anchored at A.
{
  const a = await createPerformance(API_URL, '首次归属-A', `gd-rp-a-create-${gdRun}`);
  const b = await createPerformance(API_URL, '换目标-B', `gd-rp-b-create-${gdRun}`);
  const shared = `gd-retarget-id-${gdRun}`;

  const committed = await sendCommand(API_URL, {
    command: 'transition',
    performanceId: a.id,
    status: 'running',
    expectedVersion: 1,
    requestId: shared,
  });
  check(
    'group C: first commit succeeds on A v2',
    committed.status === 200 && committed.body?.performance?.id === a.id,
    `got ${committed.status} ${JSON.stringify(committed.body)}`,
  );

  // Concurrent retarget: the barrier overlaps the replay against B with a
  // replay against a non-existent session; both conclusions must agree.
  const barrier = new CyclicBarrier(2);
  const [replayB, replayMissing] = await Promise.all([
    (async () => {
      const p = sendCommand(API_URL, {
        command: 'transition',
        performanceId: b.id,
        status: 'running',
        expectedVersion: 1,
        requestId: shared,
      });
      await barrier.hit();
      return p;
    })(),
    (async () => {
      const p = sendCommand(API_URL, {
        command: 'transition',
        performanceId: 'no-such-session-xyz',
        status: 'running',
        expectedVersion: 1,
        requestId: shared,
      });
      await barrier.hit();
      return p;
    })(),
  ]);

  expectDuplicate('group C: replay at session B duplicates, anchored at A', replayB, a.id);
  check(
    'group C: replay at B does not name B',
    !replayB.body?.error?.message?.includes(b.id),
    JSON.stringify(replayB.body),
  );
  expectDuplicate(
    'group C: replay at missing session duplicates (not SESSION_NOT_FOUND), anchored at A',
    replayMissing,
    a.id,
  );

  const replayCreate = await sendCommand(API_URL, {
    command: 'create',
    name: '重放创建',
    requestId: shared,
  });
  expectDuplicate('group C: replay as create duplicates, anchored at A', replayCreate, a.id);

  // Stable replay once more, then snapshots: A committed exactly once and
  // B was never modified by the foreign id.
  const replayAgain = await sendCommand(API_URL, {
    command: 'registerCue',
    performanceId: b.id,
    cue: 9,
    expectedVersion: 1,
    requestId: shared,
  });
  expectDuplicate('group C: repeated replay stays anchored at A', replayAgain, a.id);

  await expectSnapshot('group C: A stays at its first committed boundary', API_URL, a.id, {
    status: 'running',
    version: 2,
    requestId: shared,
    cues: [],
  });
  await expectSnapshot('group C: B untouched by all foreign replays', API_URL, b.id, {
    status: 'pending',
    version: 1,
    cues: [],
  });

  // Sanity boundary: a *fresh* id at a missing session still reports
  // SESSION_NOT_FOUND — the duplicate-first rule only applies to spent ids.
  const freshMissing = await sendCommand(API_URL, {
    command: 'transition',
    performanceId: 'no-such-session-xyz',
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('fresh-missing'),
  });
  check(
    'group C: fresh id at missing session still SESSION_NOT_FOUND',
    freshMissing.status === 404 && freshMissing.body?.error?.code === 'SESSION_NOT_FOUND',
    `got ${freshMissing.status} ${JSON.stringify(freshMissing.body)}`,
  );
}

console.log('\n[7] published WEB_PORT override');
{
  const webPort = process.env.WEB_PORT ?? '8080';
  // In compose the published host port is reached via host-gateway; a local
  // run (outside compose) may instead point WEB_PORT_URL at the proxy.
  const hostBase = process.env.WEB_PORT_URL ?? `http://host.docker.internal:${webPort}`;
  let reached = false;
  let health = null;
  for (let attempt = 0; attempt < 30 && !reached; attempt++) {
    try {
      const res = await fetch(`${hostBase}/api/health`);
      health = res.status;
      reached = res.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  check(
    `web stack reachable on host-published WEB_PORT=${webPort}`,
    reached,
    health ? `HTTP ${health}` : 'host.docker.internal not reachable',
  );
  if (reached) {
    const throughHost = await sendCommand(hostBase, {
      command: 'create',
      name: '宿主端口核验',
      requestId: commandRequestId('hostport'),
    });
    check(
      'command through published WEB_PORT proxy commits',
      throughHost.status === 200 &&
        throughHost.body?.performance?.status === 'pending' &&
        throughHost.body?.performance?.version === 1,
      `got ${throughHost.status} ${JSON.stringify(throughHost.body)}`,
    );
  }
}

console.log(`\nverify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
