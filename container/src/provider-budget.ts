import type { SQL } from 'bun';
export interface ProviderBudgetLimits { minute: number; day: number; month: number }
export const DEFAULT_ZERION_LIMITS: ProviderBudgetLimits = { minute: 120, day: 10000, month: 250000 };
export class ProviderBudgetError extends Error {
 readonly status = 429;
 constructor(readonly window: string) { super(`Zerion request budget exhausted (${window}); cached data remains available`); }
}
/** Reserve before fetching. One transaction charges all UTC windows across all
 * credentials/instances. Failed requests stay charged; uncertain commits fail closed. */
export async function reserveProviderRequest(connection: SQL, limits: ProviderBudgetLimits): Promise<void> {
 await connection`BEGIN`;
 try {
  await connection`SET LOCAL statement_timeout = '5s'`;
  await connection`SELECT pg_advisory_xact_lock(hashtext('provider-budget:zerion'))`;
  const windows = await connection`SELECT 'minute' AS kind, date_trunc('minute', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start
    UNION ALL SELECT 'day', date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    UNION ALL SELECT 'month', date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const usage: Array<{kind: keyof ProviderBudgetLimits; start: Date; used: number; limit: number}> = [];
  for (const row of windows) {
   await connection`INSERT INTO provider_request_budgets (provider, window_kind, window_start, used)
     SELECT 'zerion', ${row.kind}, ${row.start}, coalesce(sum(count),0)
     FROM provider_usage_minute WHERE provider='zerion' AND bucket >= ${row.start} AND left(outcome,9)='upstream_'
     ON CONFLICT DO NOTHING`;
   const [current] = await connection`SELECT used FROM provider_request_budgets
     WHERE provider='zerion' AND window_kind=${row.kind} AND window_start=${row.start} FOR UPDATE`;
   const kind = row.kind as keyof ProviderBudgetLimits;
   usage.push({kind,start:row.start,used:Number(current.used),limit:limits[kind]});
  }
  const exhausted = usage.find(row => row.used >= row.limit);
  for (const row of usage) {
   const after = row.used + (exhausted ? 0 : 1);
   for (const threshold of [50,80,100]) if (after >= Math.ceil(row.limit*threshold/100)) {
    const alerts = await connection`INSERT INTO provider_budget_alerts (provider,window_kind,window_start,threshold,used,request_limit)
      VALUES ('zerion',${row.kind},${row.start},${threshold},${after},${row.limit}) ON CONFLICT DO NOTHING RETURNING threshold`;
    if (alerts.length) console.warn(JSON.stringify({event:'provider_budget_alert',provider:'zerion',window:row.kind,threshold,used:after,limit:row.limit}));
   }
  }
  if (!exhausted) for (const row of usage) await connection`UPDATE provider_request_budgets SET used=used+1
    WHERE provider='zerion' AND window_kind=${row.kind} AND window_start=${row.start}`;
  await connection`COMMIT`;
  if (exhausted) throw new ProviderBudgetError(exhausted.kind);
 } catch (error) { await connection`ROLLBACK`.catch(()=>{}); throw error; }
}
