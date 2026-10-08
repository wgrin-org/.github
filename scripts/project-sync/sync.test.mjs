// Tests for the project sync: an in-memory fake of the GitHub GraphQL API (no network, no real Issues or projects).
// Run: node --test scripts/project-sync/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run, statusFor, priorityFor, areaFor, createGraphqlClient, PermissionError } from './sync.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const NEW = '2026-10-09T10:00:00Z';   // after the configured cutoff
const OLD = '2026-09-01T10:00:00Z';   // before it

/** A fake organization: repositories with open issues, and Project #1 with Status/Priority/Area options. */
function fakeOrg({ repos, items = [], rateRemaining = 5000, failRepo = null, denyProject = false } = {}) {
  const options = (names) => names.map((n) => ({ id: `opt:${n}`, name: n }));
  const fields = [
    { id: 'F:status', name: 'Status', options: options(['Backlog', 'Needs Analysis', 'Ready for Claude', 'In Progress', 'Blocked', 'In Review', 'Done']) },
    { id: 'F:priority', name: 'Priority', options: options(['P0', 'P1', 'P2', 'P3']) },
    { id: 'F:area', name: 'Area', options: options(['wgrin.org', 'bohoty.cz', 'inodo.cz', 'INO data', 'seoaudit', 'sourcerer', 'dev-environment', 'Coordination']) },
  ];
  const state = {
    items: items.map((i) => ({ id: i.id, contentId: i.contentId, values: new Map(Object.entries(i.values ?? {})) })),
    mutations: [],
    issueWrites: 0,
  };
  let itemSeq = 0;
  const graphql = async (query, v) => {
    if (query.includes('projectV2(number')) {
      if (denyProject) throw new PermissionError('GraphQL FORBIDDEN');
      return { rateLimit: { remaining: rateRemaining }, organization: { projectV2: { id: 'P1', closed: false, fields: { nodes: fields } } } };
    }
    if (query.includes('items(first')) {
      return { node: { items: { pageInfo: { hasNextPage: false }, nodes: state.items.map((i) => ({
        id: i.id, content: { __typename: 'Issue', id: i.contentId },
        fieldValues: { nodes: [...i.values].map(([fieldId, optionId]) => ({ optionId, field: { id: fieldId } })) },
      })) } } };
    }
    if (query.includes('repositories(first')) {
      return { organization: { repositories: { pageInfo: { hasNextPage: false }, nodes: repos.map((r) => ({
        name: r.name, isArchived: !!r.archived, isDisabled: false, hasIssuesEnabled: r.issues !== false })) } } };
    }
    if (query.includes('issues(states')) {
      if (failRepo === v.repo) throw new Error('HTTP 502');
      const repo = repos.find((r) => r.name === v.repo);
      // Two pages to exercise pagination.
      const all = repo.issues.map((i) => ({ id: i.id, createdAt: i.createdAt ?? NEW, labels: { nodes: (i.labels ?? []).map((name) => ({ name })) } }));
      const start = v.after ? Number(v.after) : 0;
      const page = all.slice(start, start + 2);
      return { rateLimit: { remaining: rateRemaining }, repository: { issues: { pageInfo: { hasNextPage: start + 2 < all.length, endCursor: String(start + 2) }, nodes: page } } };
    }
    if (query.includes('addProjectV2ItemById')) {
      state.mutations.push({ kind: 'add', content: v.content });
      let item = state.items.find((i) => i.contentId === v.content);   // idempotent like GitHub
      if (!item) state.items.push(item = { id: `item:${++itemSeq}`, contentId: v.content, values: new Map() });
      return { addProjectV2ItemById: { item: { id: item.id } } };
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      state.mutations.push({ kind: 'set', item: v.item, field: v.field, option: v.option });
      state.items.find((i) => i.id === v.item).values.set(v.field, v.option);
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.item } } };
    }
    state.issueWrites++;   // anything else would be an unexpected write
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  };
  const valuesOf = (contentId) => Object.fromEntries(state.items.find((i) => i.contentId === contentId)?.values ?? []);
  return { graphql, state, valuesOf };
}

const repos = () => [
  { name: 'wgrin.org', issues: [{ id: 'I:w1', labels: ['priority:P1', 'type:bug'] }] },
  { name: 'bohoty.cz', issues: [{ id: 'I:b1', labels: [] }, { id: 'I:b2', labels: ['status:blocked'] }, { id: 'I:b3', labels: ['status:ready', 'claude:ready'] }] },
  { name: 'inodo.cz', issues: [{ id: 'I:i1', labels: ['status:triage', 'priority:P3'] }] },
  { name: 'brand-new-repo', issues: [{ id: 'I:n1', labels: [] }] },
  { name: 'old-archive', archived: true, issues: [{ id: 'I:a1' }] },
];

test('new issues in wgrin.org, bohoty.cz and another repository are added with Area, Status and Priority from labels', async () => {
  const org = fakeOrg({ repos: repos() });
  const s = await run({ graphql: org.graphql, config, dryRun: false });

  assert.equal(s.added, 6);
  assert.deepEqual(org.valuesOf('I:w1'), { 'F:status': 'opt:Backlog', 'F:priority': 'opt:P1', 'F:area': 'opt:wgrin.org' });
  assert.deepEqual(org.valuesOf('I:b1'), { 'F:status': 'opt:Backlog', 'F:area': 'opt:bohoty.cz' });   // no labels: Backlog, no priority
  assert.equal(org.valuesOf('I:b2')['F:status'], 'opt:Blocked');
  assert.equal(org.valuesOf('I:b3')['F:status'], 'opt:Ready for Claude');
  assert.deepEqual(org.valuesOf('I:i1'), { 'F:status': 'opt:Needs Analysis', 'F:priority': 'opt:P3', 'F:area': 'opt:inodo.cz' });
  // A new repository without an Area option is still synchronized (Area left empty and counted).
  assert.deepEqual(org.valuesOf('I:n1'), { 'F:status': 'opt:Backlog' });
  assert.equal(s.areaUnmapped, 1);
  assert.equal(s.repositoriesSkipped, 1);   // archived
  assert.equal(org.valuesOf('I:a1')['F:status'], undefined);
  assert.equal(org.state.issueWrites, 0);
});

test('an issue already in the project is not re-added and its manually changed Status and Priority are kept', async () => {
  const org = fakeOrg({
    repos: [{ name: 'wgrin.org', issues: [{ id: 'I:w1', labels: ['priority:P0', 'status:blocked'] }] }],
    items: [{ id: 'item:existing', contentId: 'I:w1', values: { 'F:status': 'opt:In Review', 'F:priority': 'opt:P3' } }],
  });
  const s = await run({ graphql: org.graphql, config, dryRun: false });

  assert.equal(s.added, 0);
  assert.equal(s.alreadyInProject, 1);
  assert.equal(org.state.mutations.filter((m) => m.kind === 'add').length, 0);
  // Status/Priority untouched despite different labels; only the empty Area is filled.
  assert.deepEqual(org.valuesOf('I:w1'), { 'F:status': 'opt:In Review', 'F:priority': 'opt:P3', 'F:area': 'opt:wgrin.org' });
  assert.equal(s.areaFilled, 1);
});

test('repeated runs are idempotent: no duplicates, no resets, the second run writes nothing', async () => {
  const org = fakeOrg({ repos: repos() });
  await run({ graphql: org.graphql, config, dryRun: false });
  // The owner changes a Status manually between runs.
  org.state.items.find((i) => i.contentId === 'I:b1').values.set('F:status', 'opt:In Progress');
  const before = org.state.mutations.length;

  const second = await run({ graphql: org.graphql, config, dryRun: false });

  assert.equal(second.added, 0);
  assert.equal(org.state.mutations.length, before);   // nothing written
  assert.equal(org.state.items.length, 6);           // no duplicates
  assert.equal(org.valuesOf('I:b1')['F:status'], 'opt:In Progress');
});

test('issues created before the cutoff are not imported (no flooding with history)', async () => {
  const org = fakeOrg({ repos: [{ name: 'bohoty.cz', issues: [{ id: 'I:old', createdAt: OLD }, { id: 'I:new', createdAt: NEW }] }] });
  const s = await run({ graphql: org.graphql, config, dryRun: false });
  assert.equal(s.skippedBeforeCutoff, 1);
  assert.equal(s.added, 1);
  assert.equal(org.valuesOf('I:old')['F:status'], undefined);
});

test('dry run writes nothing but reports what would change', async () => {
  const org = fakeOrg({ repos: repos() });
  const s = await run({ graphql: org.graphql, config, dryRun: true });
  assert.equal(s.added, 6);
  assert.ok(s.mutations > 6);
  assert.equal(org.state.mutations.length, 0);
  assert.equal(org.state.items.length, 0);
});

test('a failing repository is counted and the others still synchronize', async () => {
  const org = fakeOrg({ repos: repos(), failRepo: 'bohoty.cz' });
  const s = await run({ graphql: org.graphql, config, dryRun: false });
  assert.equal(s.repositoryErrors, 1);
  assert.ok(org.valuesOf('I:w1')['F:area']);
  assert.ok(org.valuesOf('I:i1')['F:area']);
});

test('missing permissions stop the run before any write', async () => {
  const org = fakeOrg({ repos: repos(), denyProject: true });
  await assert.rejects(run({ graphql: org.graphql, config, dryRun: false }), PermissionError);
  assert.equal(org.state.mutations.length, 0);
});

test('a nearly exhausted rate limit stops the run before any write', async () => {
  const org = fakeOrg({ repos: repos(), rateRemaining: 10 });
  const s = await run({ graphql: org.graphql, config, dryRun: false });
  assert.match(s.stoppedEarly, /rate limit/);
  assert.equal(org.state.mutations.length, 0);
});

test('the mutation budget bounds a run; the next run continues where it stopped', async () => {
  const org = fakeOrg({ repos: repos() });
  const small = { ...config, limits: { ...config.limits, maxMutationsPerRun: 4 } };
  const first = await run({ graphql: org.graphql, config: small, dryRun: false });
  assert.match(first.stoppedEarly, /budget/);
  let guard = 0;
  while (guard++ < 10 && (await run({ graphql: org.graphql, config: small, dryRun: false })).stoppedEarly) { /* continue */ }
  assert.equal(org.state.items.length, 6);
  assert.equal(new Set(org.state.items.map((i) => i.contentId)).size, 6);
});

test('label mapping follows the organization conventions', () => {
  assert.equal(statusFor([], config), 'Backlog');
  assert.equal(statusFor(['status:ready'], config), 'Backlog');               // ready alone is not a Claude handoff
  assert.equal(statusFor(['claude:ready'], config), 'Backlog');               // claude:ready needs status:ready too
  assert.equal(statusFor(['status:ready', 'claude:ready'], config), 'Ready for Claude');
  assert.equal(statusFor(['claude:working'], config), 'In Progress');
  assert.equal(statusFor(['status:review'], config), 'In Review');
  assert.equal(priorityFor(['priority:P2', 'priority:P0'], config), 'P0');
  assert.equal(priorityFor(['type:bug'], config), null);
  const areas = new Map([['wgrin.org', 'x'], ['INO data', 'y'], ['NewRepo', 'z']]);
  assert.equal(areaFor('inodb', config, areas), 'INO data');
  assert.equal(areaFor('newrepo', config, areas), 'NewRepo');   // automatic by name
  assert.equal(areaFor('unknown', config, areas), null);
});

// ---------------------------------------------------------------- GraphQL client

function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body };
}

test('transient failures are retried with backoff (network error, 502, secondary rate limit, RATE_LIMITED)', async () => {
  const replies = [
    () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
    () => response(502, {}),
    () => response(403, {}, { 'retry-after': '1' }),
    () => response(200, { errors: [{ type: 'RATE_LIMITED', message: 'x' }] }),
    () => response(200, { data: { ok: true } }),
  ];
  const waits = [];
  const graphql = createGraphqlClient({ token: 't', fetchImpl: async () => replies.shift()(), sleep: async (ms) => waits.push(ms), maxAttempts: 5 });
  assert.deepEqual(await graphql('query{ok}'), { ok: true });
  assert.equal(waits.length, 4);
  assert.equal(waits[2], 1000);   // Retry-After honoured
});

test('permission problems fail at once and are not retried', async () => {
  let calls = 0;
  const forbidden = createGraphqlClient({ token: 't', fetchImpl: async () => { calls++; return response(200, { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }); }, sleep: async () => {} });
  await assert.rejects(forbidden('query{x}'), PermissionError);
  assert.equal(calls, 1);
  const unauthorized = createGraphqlClient({ token: 't', fetchImpl: async () => response(401, {}), sleep: async () => {} });
  await assert.rejects(unauthorized('query{x}'), PermissionError);
  const noRetryAfter = createGraphqlClient({ token: 't', fetchImpl: async () => response(403, {}), sleep: async () => {} });
  await assert.rejects(noRetryAfter('query{x}'), PermissionError);
  assert.throws(() => createGraphqlClient({ token: '' }), PermissionError);
});

test('error messages never echo GraphQL error text (it can quote private input)', async () => {
  const graphql = createGraphqlClient({ token: 't', fetchImpl: async () => response(200, { errors: [{ type: 'UNPROCESSABLE', message: 'secret issue title' }] }), sleep: async () => {} });
  await assert.rejects(graphql('query{x}'), (e) => !e.message.includes('secret') && e.message.includes('UNPROCESSABLE'));
});
