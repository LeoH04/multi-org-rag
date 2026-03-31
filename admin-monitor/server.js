import express from 'express';
import pg from 'pg';

const { Client } = pg;

const app = express();
const port = Number(process.env.PORT || 3000);

const orgs = {
  gwf: {
    name: 'GWF Wohnungsgenossenschaft eG',
    dbName: 'openwebui_gwf',
    openwebuiUrl: 'http://openwebui-gwf:8080/',
    n8nUrl: 'http://n8n-gwf:5678/'
  },
  'inge-graessle': {
    name: 'Inge Gräßle MdB Büro',
    dbName: 'openwebui_ig_mdb',
    openwebuiUrl: 'http://openwebui-inge-graessle:8080/',
    n8nUrl: 'http://n8n-inge-graessle:5678/'
  },
  ask: {
    name: 'Albert-Schweitzer-Kinderdorf',
    dbName: 'openwebui_ask',
    openwebuiUrl: 'http://openwebui-ask:8080/',
    n8nUrl: 'http://n8n-ask:5678/'
  }
};

const postgresHost = process.env.POSTGRES_HOST || 'postgres';
const postgresPort = Number(process.env.POSTGRES_PORT || 5432);
const postgresUser = process.env.POSTGRES_USER;
const postgresPassword = process.env.POSTGRES_PASSWORD;

const n8nUser = process.env.N8N_ADMIN_USER;
const n8nPassword = process.env.N8N_ADMIN_PASSWORD;

function getOrgFromRequest(orgKey) {
  if (orgKey == null || orgKey === '') {
    return { key: 'gwf', config: orgs.gwf, invalid: false };
  }
  if (orgs[orgKey]) {
    return { key: orgKey, config: orgs[orgKey], invalid: false };
  }
  return { key: null, config: null, invalid: true };
}

async function probeUrl(url) {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual'
    });
    const latencyMs = Date.now() - start;
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function countFromPreferredExistingTable(client, tableConfigs) {
  let fallbackCount = null;

  for (const config of tableConfigs) {
    const tableName = typeof config === 'string' ? config : config.table;
    const countSql = typeof config === 'string' ? 'COUNT(*)::bigint' : config.countSql || 'COUNT(*)::bigint';

    const existsQuery = await client.query('SELECT to_regclass($1) AS table_ref', [
      'public.' + tableName
    ]);

    if (!existsQuery.rows[0].table_ref) {
      continue;
    }

    const countResult = await client.query(
      'SELECT ' + countSql + ' AS count FROM public."' + tableName + '"'
    );
    const count = Number(countResult.rows[0].count || 0);

    if (fallbackCount == null) {
      fallbackCount = count;
    }

    // Prefer the first table that actually has data.
    if (count > 0) {
      return count;
    }
  }

  return fallbackCount == null ? 0 : fallbackCount;
}

async function fetchOpenWebUiDbMetrics(dbName) {
  const client = new Client({
    host: postgresHost,
    port: postgresPort,
    user: postgresUser,
    password: postgresPassword,
    database: dbName,
    statement_timeout: 4000
  });

  await client.connect();

  try {
    const activeConnectionsRes = await client.query(
      'SELECT COUNT(*)::bigint AS count FROM pg_stat_activity WHERE datname = current_database()'
    );

    const dbSizeRes = await client.query(
      'SELECT pg_database_size(current_database())::bigint AS size_bytes'
    );

    const estimatedRowsRes = await client.query(
      'SELECT COALESCE(SUM(n_live_tup), 0)::bigint AS count FROM pg_stat_user_tables'
    );

    const users = await countFromPreferredExistingTable(client, ['users', 'user']);
    const documents = await countFromPreferredExistingTable(client, [
      // Current Open WebUI schemas
      'file',
      { table: 'knowledge_file', countSql: 'COUNT(DISTINCT file_id)::bigint' },
      'knowledge',

      // Legacy/fallback schemas
      'documents',
      'document',
      'files',
      'knowledge_items',
      { table: 'document_chunk', countSql: 'COUNT(DISTINCT collection_name)::bigint' }
    ]);
    const chats = await countFromPreferredExistingTable(client, [
      'chats',
      'chat',
      'messages',
      'conversations'
    ]);

    return {
      dbConnections: Number(activeConnectionsRes.rows[0].count),
      dbSizeBytes: Number(dbSizeRes.rows[0].size_bytes),
      estimatedRows: Number(estimatedRowsRes.rows[0].count),
      users,
      documents,
      chats
    };
  } finally {
    await client.end();
  }
}

function n8nAuthHeader() {
  if (!n8nUser || !n8nPassword) {
    return {};
  }
  const token = Buffer.from(n8nUser + ':' + n8nPassword).toString('base64');
  return {
    Authorization: 'Basic ' + token
  };
}

async function fetchN8nMetrics(n8nBaseUrl) {
  const headers = {
    Accept: 'application/json',
    ...n8nAuthHeader()
  };

  const [workflowRes, executionRes] = await Promise.all([
    fetch(new URL('/rest/workflows?limit=250', n8nBaseUrl), { headers }).catch(() => null),
    fetch(new URL('/rest/executions?limit=100', n8nBaseUrl), { headers }).catch(() => null)
  ]);

  let activeWorkflows = null;
  let executions24h = null;
  let failedExecutions24h = null;

  const workflowStatusCode = workflowRes ? workflowRes.status : null;
  const executionStatusCode = executionRes ? executionRes.status : null;

  const errors = [];
  if (!workflowRes) {
    errors.push('workflows endpoint unreachable');
  } else if (!workflowRes.ok) {
    errors.push('workflows endpoint HTTP ' + workflowRes.status);
  }

  if (!executionRes) {
    errors.push('executions endpoint unreachable');
  } else if (!executionRes.ok) {
    errors.push('executions endpoint HTTP ' + executionRes.status);
  }

  if (workflowRes && workflowRes.ok) {
    const workflowJson = await workflowRes.json();
    const list = Array.isArray(workflowJson)
      ? workflowJson
      : Array.isArray(workflowJson.data)
      ? workflowJson.data
      : [];
    activeWorkflows = list.filter((item) => item && item.active).length;
  }

  if (executionRes && executionRes.ok) {
    const executionJson = await executionRes.json();
    const list = Array.isArray(executionJson)
      ? executionJson
      : Array.isArray(executionJson.data)
      ? executionJson.data
      : [];

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = list.filter((item) => {
      const dateValue = item?.startedAt || item?.stoppedAt || item?.createdAt;
      return dateValue ? new Date(dateValue).getTime() >= cutoff : false;
    });

    executions24h = recent.length;
    failedExecutions24h = recent.filter((item) => {
      const status = String(item?.status || '').toLowerCase();
      const finished = item?.finished === false ? false : true;
      return status.includes('error') || (!finished && status !== 'running');
    }).length;
  }

  return {
    activeWorkflows,
    executions24h,
    failedExecutions24h,
    metricsAvailable: Boolean(workflowRes?.ok && executionRes?.ok),
    workflowStatusCode,
    executionStatusCode,
    apiError: errors.length > 0 ? errors.join('; ') : null
  };
}

function toPercent(value, total) {
  if (!total || total <= 0) {
    return 0;
  }
  return Number(((value / total) * 100).toFixed(1));
}

function formatIsoNow() {
  return new Date().toISOString();
}

async function collectMetricsForOrg(orgKey, org) {
  const [webuiProbe, n8nProbe, dbMetrics, n8nMetrics] = await Promise.all([
    probeUrl(org.openwebuiUrl),
    probeUrl(org.n8nUrl),
    fetchOpenWebUiDbMetrics(org.dbName),
    fetchN8nMetrics(org.n8nUrl)
  ]);

  const failureRate =
    typeof n8nMetrics.executions24h === 'number' && n8nMetrics.executions24h > 0
      ? toPercent(n8nMetrics.failedExecutions24h || 0, n8nMetrics.executions24h)
      : null;

  return {
    org: {
      key: orgKey,
      name: org.name
    },
    health: {
      openwebui: webuiProbe,
      n8n: n8nProbe,
      combinedOk: Boolean(webuiProbe.ok && n8nProbe.ok)
    },
    kpis: {
      activeUsers: dbMetrics.users,
      indexedDocuments: dbMetrics.documents,
      p95LatencyMs: webuiProbe.latencyMs,
      workflowFailureRatePct: failureRate
    },
    details: {
      openwebui: {
        dbConnections: dbMetrics.dbConnections,
        dbSizeBytes: dbMetrics.dbSizeBytes,
        estimatedRows: dbMetrics.estimatedRows,
        chats: dbMetrics.chats
      },
      n8n: {
        activeWorkflows: n8nMetrics.activeWorkflows,
        executions24h: n8nMetrics.executions24h,
        failedExecutions24h: n8nMetrics.failedExecutions24h,
        metricsAvailable: n8nMetrics.metricsAvailable,
        workflowStatusCode: n8nMetrics.workflowStatusCode,
        executionStatusCode: n8nMetrics.executionStatusCode,
        apiError: n8nMetrics.apiError
      }
    }
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, at: formatIsoNow() });
});

app.get('/api/admin/metrics', async (req, res) => {
  const requestedOrg = req.query.org == null ? '' : String(req.query.org);
  const { key: orgKey, config: org, invalid } = getOrgFromRequest(requestedOrg);

  if (invalid) {
    res.status(400).json({
      error: 'Invalid org key',
      message: 'Unknown org "' + requestedOrg + '". Valid keys: ' + Object.keys(orgs).join(', '),
      at: formatIsoNow()
    });
    return;
  }

  try {
    const response = await collectMetricsForOrg(orgKey, org);
    response.at = formatIsoNow();

    res.json(response);
  } catch (error) {
    res.status(502).json({
      error: 'Failed to collect metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
      at: formatIsoNow()
    });
  }
});

app.get('/api/admin/metrics/all', async (_req, res) => {
  try {
    const entries = Object.entries(orgs);
    const orgMetrics = await Promise.all(
      entries.map(async ([orgKey, org]) => {
        try {
          return await collectMetricsForOrg(orgKey, org);
        } catch (error) {
          return {
            org: {
              key: orgKey,
              name: org.name
            },
            health: {
              openwebui: { ok: false, statusCode: null, latencyMs: null },
              n8n: { ok: false, statusCode: null, latencyMs: null },
              combinedOk: false
            },
            kpis: {
              activeUsers: 0,
              indexedDocuments: 0,
              p95LatencyMs: null,
              workflowFailureRatePct: null
            },
            details: {
              openwebui: {
                dbConnections: 0,
                dbSizeBytes: 0,
                estimatedRows: 0,
                chats: 0
              },
              n8n: {
                activeWorkflows: null,
                executions24h: null,
                failedExecutions24h: null,
                metricsAvailable: false,
                workflowStatusCode: null,
                executionStatusCode: null,
                apiError: 'Failed to collect n8n metrics'
              }
            },
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      })
    );

    const summary = orgMetrics.reduce(
      (acc, item) => {
        acc.totalOrgs += 1;
        acc.healthyOrgs += item.health.combinedOk ? 1 : 0;
        acc.totalActiveUsers += Number(item.kpis.activeUsers || 0);
        acc.totalIndexedDocuments += Number(item.kpis.indexedDocuments || 0);
        acc.totalDbSizeBytes += Number(item.details.openwebui.dbSizeBytes || 0);

        if (typeof item.kpis.p95LatencyMs === 'number') {
          acc.latencySamples += 1;
          acc.latencySum += item.kpis.p95LatencyMs;
        }

        if (typeof item.kpis.workflowFailureRatePct === 'number') {
          acc.failureRateSamples += 1;
          acc.failureRateSum += item.kpis.workflowFailureRatePct;
        }

        return acc;
      },
      {
        totalOrgs: 0,
        healthyOrgs: 0,
        totalActiveUsers: 0,
        totalIndexedDocuments: 0,
        totalDbSizeBytes: 0,
        latencySamples: 0,
        latencySum: 0,
        failureRateSamples: 0,
        failureRateSum: 0
      }
    );

    res.json({
      at: formatIsoNow(),
      summary: {
        totalOrgs: summary.totalOrgs,
        healthyOrgs: summary.healthyOrgs,
        totalActiveUsers: summary.totalActiveUsers,
        totalIndexedDocuments: summary.totalIndexedDocuments,
        totalDbSizeBytes: summary.totalDbSizeBytes,
        avgLatencyMs:
          summary.latencySamples > 0
            ? Number((summary.latencySum / summary.latencySamples).toFixed(1))
            : null,
        avgWorkflowFailureRatePct:
          summary.failureRateSamples > 0
            ? Number((summary.failureRateSum / summary.failureRateSamples).toFixed(1))
            : null
      },
      orgs: orgMetrics
    });
  } catch (error) {
    res.status(502).json({
      error: 'Failed to collect all-org metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
      at: formatIsoNow()
    });
  }
});

app.listen(port, () => {
  console.log('admin-monitor listening on port ' + port);
});
