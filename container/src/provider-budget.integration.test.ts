import {beforeAll,afterAll,beforeEach,expect,test} from 'bun:test';
import {SQL} from 'bun';
import {createDatabase,type Database} from './database';
import {loadConfig} from './config';
import {ProviderBudgetError} from './provider-budget';
const url=process.env.BUDGET_TEST_DATABASE_URL;
const integration=url?test:test.skip;
let first:Database,second:Database,sql:SQL;
beforeAll(async()=>{
 if(!url)return;
 if(!new URL(url).pathname.endsWith('_test'))throw Error('Dedicated test database required');
 const config={...loadConfig({DATABASE_URL:url,DATABASE_MAX_CONNECTIONS:'1'}),zerionLimits:{minute:100,day:5,month:50}};
 first=createDatabase(config);second=createDatabase(config);await first.migrate();
 sql=new SQL(url,{max:1});
});
beforeEach(async()=>{if(sql)await sql`TRUNCATE provider_request_budgets,provider_budget_alerts,provider_usage_minute`;});
afterAll(async()=>{if(first){await first.close();await second.close();await sql.close();}});
integration('parallel instances cannot exceed the shared daily budget',async()=>{
 const results=await Promise.allSettled(Array.from({length:20},(_,i)=>(i%2?first:second).reserveZerionRequest()));
 expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(5);
 expect(results.filter(row=>row.status==='rejected')).toHaveLength(15);
 const counts=await sql`SELECT used FROM provider_request_budgets`;
 expect(counts.every((row:any)=>Number(row.used)===5)).toBe(true);
 const alerts=await sql`SELECT threshold FROM provider_budget_alerts WHERE window_kind='day' ORDER BY threshold`;
 expect(alerts.map((row:any)=>row.threshold)).toEqual([50,80,100]);
 expect((await first.getProviderUsage()).state).toBe('limited');
});
integration('a single-connection cache load can reserve a budget without deadlock',async()=>{
 await first.runExclusive('fixture-cache-lock',()=>first.reserveZerionRequest());
 expect(Number((await sql`SELECT used FROM provider_request_budgets WHERE window_kind='day'`)[0].used)).toBe(1);
});
integration('existing monthly attempts seed the ledger and cannot be reset by another instance',async()=>{
 await sql`INSERT INTO provider_usage_minute(bucket,instance_id,provider,source,client_id,operation,outcome,forced,status,count,duration_ms)
 VALUES(now(),'00000000-0000-0000-0000-000000000001','zerion','http','fixture','positions','upstream_ok',false,200,5,1)`;
 await expect(first.reserveZerionRequest()).rejects.toBeInstanceOf(ProviderBudgetError);
 await expect(second.reserveZerionRequest()).rejects.toBeInstanceOf(ProviderBudgetError);
 expect(Number((await sql`SELECT used FROM provider_request_budgets WHERE window_kind='day'`)[0].used)).toBe(5);
});
integration('old windows do not block the next UTC period',async()=>{
 await sql`INSERT INTO provider_request_budgets VALUES('zerion','day','2020-01-01',999)`;
 await first.reserveZerionRequest();
 expect((await first.getProviderUsage()).state).toBe('normal');
});
