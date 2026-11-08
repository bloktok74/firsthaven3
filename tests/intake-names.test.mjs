import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROMPT } from '../shared/agent-policy.ts';
import { makeDraft, emptyValues, validateAnswer } from '../shared/intake-model.ts';

test('ordinary fictional first and last names reach the local draft', () => {
  for (const name of ['John Smith', 'Ana María García', '李 小龍', 'Jean-Luc O’Connor', 'J. R. Smith']) {
    assert.deepEqual(validateAnswer('agentName', name), { value: name });
    assert.equal(makeDraft({ ...emptyValues(), agentName: name }).agent.name, name);
  }
  for (const value of ['John', 'John 123', 'John Smith 123-45-6789', 'john@personal.com']) {
    assert.ok(validateAnswer('agentName', value).error);
  }
  assert.ok(validateAnswer('agentEmail', 'john@personal.com').error);
  assert.ok(validateAnswer('propertyAddress', '123 Oak Street').error);
  assert.match(AGENT_PROMPT, /first and last names without any required prefix or suffix/);
});
