import {describe,expect,it} from 'vitest'
import {OPERATOR_MCP_INPUTS,OPERATOR_READ_TOOL_NAMES,OPERATOR_WRITE_TOOL_NAMES,getOperatorToolDefinition} from './operator-mcp'
const operationId='12345678-1234-4234-a234-123456789012'
const revision='a'.repeat(64)
describe('independent CRM parity contract review',()=>{
  it('makes exact-history reads and maintenance writes discoverable without a sending tool',()=>{
    expect(OPERATOR_READ_TOOL_NAMES).toContain('crm.get_outreach_history')
    for(const name of ['crm.propose_outreach_history_review','crm.propose_outreach_history_retract','crm.propose_record_update'] as const){expect(OPERATOR_WRITE_TOOL_NAMES).toContain(name);expect(getOperatorToolDefinition(name).description.length).toBeGreaterThan(20)}
    expect(OPERATOR_WRITE_TOOL_NAMES.some(n=>n==='crm.send_email' as string)).toBe(false)
  })
  it('requires exact account/revision/operation identifiers for corrections and soft retractions',()=>{
    const input={organizationId:'account',expectedRevision:revision,operationId,reason:'Reviewed actual provider evidence',change:{kind:'message',messageId:'message',classification:'warm'}}
    expect(OPERATOR_MCP_INPUTS['crm.propose_outreach_history_review'].safeParse(input).success).toBe(true)
    for(const key of ['organizationId','expectedRevision','operationId']){const copy={...input} as Record<string,unknown>;delete copy[key];expect(OPERATOR_MCP_INPUTS['crm.propose_outreach_history_review'].safeParse(copy).success).toBe(false)}
    expect(OPERATOR_MCP_INPUTS['crm.propose_outreach_history_retract'].safeParse({organizationId:'account',expectedRevision:revision,operationId,reason:'Correction',targetEvidenceId:'evidence'}).success).toBe(true)
    expect(OPERATOR_MCP_INPUTS['crm.propose_outreach_history_retract'].safeParse({organizationId:'account',expectedRevision:revision,operationId,reason:'Correction',targetEvidenceId:'evidence',hardDelete:true}).success).toBe(false)
  })
  it('refuses guessed scope, body mutation and caller-supplied reviewer identity',()=>{
    const base={organizationId:'account',expectedRevision:revision,operationId,reason:'Review'}
    for(const change of [{kind:'scope',organizationIds:['other']},{kind:'message',messageId:'message',classification:'human',body:'Rewrite actual email'},{kind:'relationship',relationship:'prospect',reviewerId:'human-owner'}])expect(OPERATOR_MCP_INPUTS['crm.propose_outreach_history_review'].safeParse({...base,change}).success).toBe(false)
  })
  it('requires version and exact reviewed draft hash and never accepts send side effects',()=>{
    const record={type:'draft',draftId:'draft',expectedVersion:2,expectedContentHash:revision,action:'edit',textBody:'Updated draft'}
    expect(OPERATOR_MCP_INPUTS['crm.propose_record_update'].safeParse({operationId,reason:'Correct copy',record}).success).toBe(true)
    for(const extra of [{send:true},{providerMessageId:'invented'},{status:'SENT'}])expect(OPERATOR_MCP_INPUTS['crm.propose_record_update'].safeParse({operationId,reason:'Correct copy',record:{...record,...extra}}).success).toBe(false)
    expect(OPERATOR_MCP_INPUTS['crm.propose_record_update'].safeParse({operationId,reason:'Correct copy',record:{...record,expectedVersion:0}}).success).toBe(false)
  })
  it('offers reversible note operations with a required revision and correction text',()=>{
    const base={type:'note',organizationId:'account',noteId:'note',expectedRevision:revision}
    for(const action of ['archive','restore'])expect(OPERATOR_MCP_INPUTS['crm.propose_record_update'].safeParse({operationId,reason:'Lifecycle change',record:{...base,action}}).success).toBe(true)
    expect(OPERATOR_MCP_INPUTS['crm.propose_record_update'].safeParse({operationId,reason:'Correct capture',record:{...base,action:'correct'}}).success).toBe(false)
  })
})
