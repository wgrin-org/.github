// Organization Issues -> GitHub Project sync (scheduled reconciliation). See docs/project-sync.md.
//
// Reads the open Issues of every active repository in the organization and adds new ones to the organization Project,
// setting Area (by repository) and, for newly added items only, Status and Priority from the organization labels.
// Existing project items are never re-added and their Status/Priority are never changed; an empty Area is filled.
//
// Safety: only GraphQL reads plus two project mutations (addProjectV2ItemById, updateProjectV2ItemFieldValue). It never
// writes to repositories, Issues, labels or pull requests, never evaluates Issue content, and logs counts only (this
// repository is public, so logs must not contain private repository names, titles or URLs).
// No dependencies: Node 20+ (built-in fetch).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com/graphql';

export class PermissionError extends Error {}
export class TransientError extends Error {}

// ---------------------------------------------------------------- GraphQL client (retries, rate limits)

/**
 * A GraphQL client with bounded retries: network errors, HTTP 5xx, secondary rate limits (403/429 + Retry-After or
 * x-ratelimit-reset) and GraphQL RATE_LIMITED errors are retried with backoff; permission errors fail at once.
 */
export function createGraphqlClient({ token, fetchImpl = fetch, sleep = defaultSleep, maxAttempts = 5, now = () => Date.now() }) {
  if (!token) throw new PermissionError('No token: the GitHub App token was not provided.');
  return async function graphql(query, variables = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response;
      try {
        response = await fetchImpl(API, {
          method: 'POST',
          headers: {
            authorization: `bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': 'wgrin-org-project-sync',
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (error) {
        lastError = new TransientError(`network error (${error?.code ?? error?.name ?? 'unknown'})`);
        await sleep(backoff(attempt));
        continue;
      }

      if (response.status === 401) throw new PermissionError('HTTP 401: the token is invalid or expired.');
      if (response.status === 403 || response.status === 429) {
        const wait = retryAfterMs(response, now);
        if (wait !== null) {
          lastError = new TransientError(`HTTP ${response.status}: rate limited`);
          await sleep(Math.min(wait, 120_000));
          continue;
        }
        throw new PermissionError(`HTTP ${response.status}: access denied (check the GitHub App permissions and installation).`);
      }
      if (response.status >= 500) {
        lastError = new TransientError(`HTTP ${response.status}`);
        await sleep(backoff(attempt));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = await response.json();
      if (body.errors?.length) {
        const types = body.errors.map((e) => e.type).filter(Boolean);
        if (types.includes('RATE_LIMITED')) {
          lastError = new TransientError('GraphQL RATE_LIMITED');
          await sleep(retryAfterMs(response, now) ?? backoff(attempt) * 4);
          continue;
        }
        if (types.some((t) => ['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'NOT_FOUND'].includes(t))) {
          throw new PermissionError(`GraphQL ${[...new Set(types)].join(', ')}: missing permission or the App is not installed where needed.`);
        }
        // Error messages can quote input; only the error types are reported.
        throw new Error(`GraphQL error (${[...new Set(types)].join(', ') || 'untyped'})`);
      }
      return body.data;
    }
    throw lastError ?? new TransientError('request failed');
  };
}

function backoff(attempt) {
  return Math.min(60_000, 1_000 * 2 ** (attempt - 1));
}

function retryAfterMs(response, now) {
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter && !Number.isNaN(Number(retryAfter))) return Number(retryAfter) * 1000;
  if (response.headers?.get?.('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (reset) return Math.max(0, reset * 1000 - now()) + 1000;
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- planning (pure)

export function statusFor(labels, config) {
  const set = new Set(labels);
  for (const rule of config.statusRules) {
    if (rule.anyLabel && rule.anyLabel.some((l) => set.has(l))) return rule.status;
    if (rule.allLabels && rule.allLabels.every((l) => set.has(l))) return rule.status;
  }
  return config.defaultStatus;
}

export function priorityFor(labels, config) {
  // The highest priority wins if several are present (P0 before P3).
  const found = labels.map((l) => config.priorityByLabel[l]).filter(Boolean).sort();
  return found[0] ?? null;
}

export function areaFor(repository, config, areaOptions) {
  const mapped = config.areaByRepository[repository];
  if (mapped && areaOptions.has(mapped)) return mapped;
  // A new repository is picked up automatically when an Area option with its name exists.
  for (const name of areaOptions.keys()) {
    if (name.toLowerCase() === repository.toLowerCase()) return name;
  }
  return null;
}

// ---------------------------------------------------------------- GraphQL documents

const PROJECT = `query($org:String!,$number:Int!){ rateLimit{remaining resetAt}
  organization(login:$org){ projectV2(number:$number){ id closed
    fields(first:50){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } } } } }`;

const ITEMS = `query($id:ID!,$after:String){ node(id:$id){ ... on ProjectV2{ items(first:100, after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{ id content{ __typename ... on Issue{ id } }
    fieldValues(first:30){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ optionId field{ ... on ProjectV2SingleSelectField{ id } } } } } } } } } }`;

const REPOS = `query($org:String!,$after:String){ organization(login:$org){ repositories(first:100, after:$after){
  pageInfo{ hasNextPage endCursor } nodes{ name isArchived isDisabled hasIssuesEnabled } } } }`;

const ISSUES = `query($org:String!,$repo:String!,$after:String){ rateLimit{remaining} repository(owner:$org, name:$repo){
  issues(states:OPEN, first:100, after:$after, orderBy:{field:CREATED_AT, direction:ASC}){
    pageInfo{ hasNextPage endCursor } nodes{ id createdAt labels(first:50){ nodes{ name } } } } } }`;

const ADD = `mutation($project:ID!,$content:ID!){ addProjectV2ItemById(input:{projectId:$project, contentId:$content}){ item{ id } } }`;

const SET = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
  updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{singleSelectOptionId:$option}}){ projectV2Item{ id } } }`;

async function* paginate(graphql, query, variables, select) {
  let after = null;
  do {
    const data = await graphql(query, { ...variables, after });
    const connection = select(data);
    if (!connection) return;
    yield* connection.nodes;
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
}

// ---------------------------------------------------------------- run

/**
 * One reconciliation pass. Returns counts only. In dry-run mode nothing is written; the counts show what would change.
 */
export async function run({ graphql, config, dryRun = true }) {
  const summary = {
    dryRun, repositoriesScanned: 0, repositoriesSkipped: 0, openIssuesSeen: 0, alreadyInProject: 0,
    skippedBeforeCutoff: 0, added: 0, statusSet: 0, prioritySet: 0, areaSet: 0, areaFilled: 0, areaUnmapped: 0,
    repositoryErrors: 0, stoppedEarly: null,
  };

  // Project and its fields (fails fast without permission: nothing is written in that case).
  const projectData = await graphql(PROJECT, { org: config.organization, number: config.projectNumber });
  const project = projectData?.organization?.projectV2;
  if (!project) throw new PermissionError('Project not found or not accessible to the GitHub App.');
  if (project.closed) throw new Error('The project is closed.');
  if ((projectData.rateLimit?.remaining ?? Infinity) < config.limits.minRateLimitRemaining) {
    summary.stoppedEarly = 'rate limit nearly exhausted; the next run continues';
    return summary;
  }
  const field = (name) => {
    const f = project.fields.nodes.find((n) => n?.name === name);
    if (!f?.options) throw new Error(`Project field missing or not single-select: ${name}`);
    return { id: f.id, options: new Map(f.options.map((o) => [o.name, o.id])) };
  };
  const status = field(config.fields.status);
  const priority = field(config.fields.priority);
  const area = field(config.fields.area);
  if (!status.options.has(config.defaultStatus)) throw new Error('The default status option does not exist.');

  // Existing items: content id -> item (with its current single-select values). Archived items count as existing.
  const existing = new Map();
  for await (const item of paginate(graphql, ITEMS, { id: project.id }, (d) => d?.node?.items)) {
    if (item.content?.__typename !== 'Issue') continue;
    const values = new Map();
    for (const v of item.fieldValues?.nodes ?? []) if (v?.field?.id) values.set(v.field.id, v.optionId);
    existing.set(item.content.id, { id: item.id, values });
  }

  let mutations = 0;
  const budget = config.limits.maxMutationsPerRun;
  const mutate = async (query, variables) => {
    mutations++;
    if (dryRun) return null;
    return graphql(query, variables);
  };
  const setField = (itemId, fieldId, optionId) => mutate(SET, { project: project.id, item: itemId, field: fieldId, option: optionId });

  const cutoff = Date.parse(config.addIssuesCreatedOnOrAfter);
  const excluded = new Set(config.excludeRepositories);

  outer:
  for await (const repo of paginate(graphql, REPOS, { org: config.organization }, (d) => d?.organization?.repositories)) {
    if (repo.isArchived || repo.isDisabled || !repo.hasIssuesEnabled || excluded.has(repo.name)) {
      summary.repositoriesSkipped++;
      continue;
    }

    summary.repositoriesScanned++;
    const areaName = areaFor(repo.name, config, area.options);
    try {
      for await (const issue of paginate(graphql, ISSUES, { org: config.organization, repo: repo.name }, (d) => d?.repository?.issues)) {
        summary.openIssuesSeen++;
        if (mutations >= budget) {
          summary.stoppedEarly = 'mutation budget reached; the next run continues';
          break outer;
        }

        const current = existing.get(issue.id);
        if (current) {
          summary.alreadyInProject++;
          // Never touch Status or Priority of an existing item; only fill an empty Area.
          if (areaName && !current.values.get(area.id)) {
            await setField(current.id, area.id, area.options.get(areaName));
            current.values.set(area.id, area.options.get(areaName));
            summary.areaFilled++;
          }
          continue;
        }

        if (Number.isFinite(cutoff) && Date.parse(issue.createdAt) < cutoff) {
          summary.skippedBeforeCutoff++;
          continue;
        }

        // addProjectV2ItemById is idempotent: an existing item is returned, never duplicated.
        const added = await mutate(ADD, { project: project.id, content: issue.id });
        const itemId = dryRun ? `dry-run:${issue.id}` : added?.addProjectV2ItemById?.item?.id;
        if (!itemId) throw new Error('The item id was not returned.');
        summary.added++;
        existing.set(issue.id, { id: itemId, values: new Map() });

        const labels = issue.labels?.nodes?.map((l) => l.name) ?? [];
        await setField(itemId, status.id, status.options.get(statusFor(labels, config) ?? config.defaultStatus) ?? status.options.get(config.defaultStatus));
        summary.statusSet++;
        const p = priorityFor(labels, config);
        if (p && priority.options.has(p)) {
          await setField(itemId, priority.id, priority.options.get(p));
          summary.prioritySet++;
        }

        if (areaName) {
          await setField(itemId, area.id, area.options.get(areaName));
          summary.areaSet++;
        } else {
          summary.areaUnmapped++;
        }
      }
    } catch (error) {
      if (error instanceof PermissionError) throw error;
      summary.repositoryErrors++;   // other repositories still sync; the run reports failure at the end
    }
  }

  summary.mutations = mutations;
  return summary;
}

// ---------------------------------------------------------------- entry point

async function main() {
  const configPath = new URL('./config.json', import.meta.url);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  try {
    const graphql = createGraphqlClient({ token: process.env.GH_TOKEN });
    const summary = await run({ graphql, config, dryRun });
    console.log(`project-sync ${dryRun ? '(dry run) ' : ''}summary: ${JSON.stringify(summary)}`);
    if (summary.repositoryErrors > 0) {
      console.log('::error::Some repositories could not be synchronized; see docs/project-sync.md (runbook).');
      process.exitCode = 1;
    }
  } catch (error) {
    const kind = error instanceof PermissionError ? 'permission' : error instanceof TransientError ? 'transient' : 'error';
    console.log(`::error::project-sync failed (${kind}): ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
