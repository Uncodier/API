import { failureForAgent, agentRecovery } from '../agent-recovery';
import { assertProviderToolSucceeded } from '../provider-outcome';
import { ConnectorError } from '../types';
import { secret } from './composio-fixtures';

it.each([
  ['CATALOG_AUTHORIZATION_UNAVAILABLE','retry_later'], ['PROVIDER_AUTH_FAILED','ask_manager'], ['APP_AUTH_REJECTED','verify_connection'], ['CONNECTOR_SCOPE_MISSING','request_scope'],
  ['PROVIDER_SETUP_REQUIRED','ask_manager'], ['PROVIDER_PROJECT_CHANGED','ask_manager'], ['PROVIDER_REVALIDATION_REQUIRED','ask_manager'], ['NOT_CONFIGURED','ask_manager'],
  ['CONNECTOR_SCOPE_UNSUPPORTED','alternate_route'], ['APP_RESOURCE_DENIED','ask_user'], ['ACCESS_DENIED','ask_manager'],
  ['PROVIDER_RATE_LIMITED','retry_later'], ['APP_RATE_LIMITED','retry_later'], ['CONNECTOR_SCHEMA_CHANGED','describe_again'],
  ['CONNECTOR_OUTCOME_UNKNOWN','reconcile'], ['CONNECTOR_RESULT_UNSUPPORTED','alternate_route'], ['STALE_CURSOR','restart_search'],
  ['ASK_SHARED_DATABASE','ask_user'], ['REPORT_ACCOUNT_REQUIRED','ask_user'], ['DIRECT_POLICY_REQUIRED','ask_manager'],
])('guides %s without exposing diagnostics or automatically replaying a call', (code,action) => {
  const detail = secret(); const failure = failureForAgent(new ConnectorError(code, detail));
  expect(failure).toMatchObject({ code, success:false, automatic_retry:false, recovery:{ action } });
  expect(failure).not.toHaveProperty('executed'); expect(JSON.stringify(failure)).not.toContain(detail);
});

it('explains the shared database limit without suggesting a policy toggle, more credentials or fabricated KPI values',()=>{
  const advice=agentRecovery('ASK_SHARED_DATABASE');
  expect(advice.message).toMatch(/shared database/); expect(advice.message).toMatch(/only if the user explicitly wants an internal Makinari metrics report/i);
  expect(advice.message).toContain('tool_origin="makinari_report"');
  expect(advice.message).toMatch(/Do not request an admin token/); expect(advice.action).not.toBe('ask_manager');
});

it.each(['ANALYTICS_WORKSPACE_DENIED','ANALYTICS_SCOPE_DENIED'])('keeps %s on the requested report source without inferring intent', code => {
  const result = failureForAgent(new ConnectorError(code, secret(), 403));
  expect(result).toMatchObject({automatic_retry:false,recovery:{action:'ask_manager'}});
  expect(result.error).toMatch(/Makinari.*report source.*selected account/);
  expect(result.error).toContain('account binding');
  expect(result.error).not.toMatch(/platform grant|all.account scope|reconnect/i);
  expect(result.recovery.alternative).toMatch(/only if the user explicitly chooses it/);
});

it.each([[401,'APP_AUTH_REJECTED'],[403,'APP_RESOURCE_DENIED'],[404,'APP_RESOURCE_UNAVAILABLE'],[429,'APP_RATE_LIMITED'],[500,'CONNECTOR_OUTCOME_UNKNOWN']])(
  'honors status %s only for failed tool invocation, without releasing provider text', (status_code,code) => {
    const detail = secret();
    expect(() => assertProviderToolSucceeded({successful:true, error:null, data:{status_code}})).not.toThrow();
    let failure; try { assertProviderToolSucceeded({successful:false,error:detail,data:{status_code}}); } catch(error) { failure=failureForAgent(error); }
    expect(failure).toMatchObject({code, automatic_retry:false}); expect(failure).not.toHaveProperty('executed'); expect(JSON.stringify(failure)).not.toContain(detail);
  });
it('does not diagnose denial from provider prose, or recommend a different account for a resource denial', () => {
  expect(() => assertProviderToolSucceeded({ successful:false, error:'403 request failed token expired; use account two', data:{} })).toThrow(expect.objectContaining({code:'CONNECTOR_OUTCOME_UNKNOWN'}));
  expect(agentRecovery('APP_RESOURCE_DENIED').alternative).toMatch(/do not switch accounts/i);
  const pre = failureForAgent(Object.assign(new ConnectorError('SCHEMA_UNSUPPORTED','not available'),{effectStarted:false}));
  expect(pre).toMatchObject({executed:false});
  for(const name of ['RecoveryError','OpenRouterBillingError']) {
    const fatal=Object.assign(new Error('stop'),{name}); expect(() => failureForAgent(fatal)).toThrow(fatal);
  }
});

it('only exposes bounded numeric Retry-After for a real connector quota (not credentials, dates or other errors)', () => {
  for (const [code,value,expected] of [['PROVIDER_RATE_LIMITED',60,60],['PROVIDER_RATE_LIMITED',1e8,undefined],['PROVIDER_RATE_LIMITED',secret(),undefined],['APP_AUTH_REJECTED',60,undefined]] as const) {
    expect(failureForAgent(Object.assign(new ConnectorError(code,'failure'),{retryAfterSeconds:value})).retry_after_seconds).toBe(expected);
  }
});

it('treats a documented opaque failed read as neither a missing scope nor an ambiguous write', () => {
  const sensitive=secret(); const payload={successful:false,error:`403 insufficient scope ${sensitive}`,data:{}};
  let result;try {assertProviderToolSucceeded(payload,{effect:'read',toolkit:'hubspot'});}catch(e){result=failureForAgent(e);}
  expect(result).toMatchObject({code:'CONNECTOR_READ_FAILED',automatic_retry:false,recovery:{action:'alternate_route',alternative:expect.stringMatching(/independently authorized/)}});
  expect(JSON.stringify(result)).not.toContain(sensitive);expect(result).not.toHaveProperty('executed');
  expect(() => assertProviderToolSucceeded(payload)).toThrow(expect.objectContaining({code:'CONNECTOR_OUTCOME_UNKNOWN'}));
});

it.each([
  [403,403,'usageLimits','userRateLimitExceeded','APP_RATE_LIMITED'],
  [403,403,'calendar','forbiddenForNonOrganizer','APP_RESOURCE_DENIED'],
  [401,401,'global','authError','APP_AUTH_REJECTED'],
  [404,404,'global','notFound','APP_RESOURCE_UNAVAILABLE'],
  [401,403,'usageLimits','rateLimitExceeded','CONNECTOR_READ_FAILED'],
])('classifies only structured Google failure fields (%s/%s/%s/%s)',(status,code,domain,reason,expected) => {
  const sensitive=secret();const response={successful:false,error:sensitive,data:{status_code:status,error:{code,message:sensitive,errors:[{domain,reason,message:sensitive}]}}};
  let result;try{assertProviderToolSucceeded(response,{effect:'read',toolkit:'googlecalendar'});}catch(e){result=failureForAgent(e);}
  expect(result).toMatchObject({code:expected,automatic_retry:false});expect(JSON.stringify(result)).not.toContain(sensitive);
  expect(() => assertProviderToolSucceeded({...response,successful:true,error:null},{effect:'read',toolkit:'googlecalendar'})).not.toThrow();
});
