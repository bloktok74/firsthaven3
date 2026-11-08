export const INTRODUCTION = "Welcome to First Haven Escrow! I'm your virtual escrow assistant. I can help you get started with opening escrow. Would you like to begin?";
export const TESTER_INTRODUCTION = 'Hi there, welcome to First Haven Escrow. With just five pieces of information, we can open your escrow file. Are you the agent and what is your full name?';
export const REVIEW_NOTICE = 'This is a test request. An escrow employee must review a real request before an escrow order is officially opened. No escrow number has been assigned.';
export const POLICY_VERSION = 'FIRST_HAVEN3_TEST_INTAKE_V1';
export const JESSICA_VOICE_ID = 'cgSgspJ2msm6clMCkdW9';
export const JESSICA_DAILY_SESSION_LIMIT = 50;

export const fields = ['agentName', 'agentEmail', 'agentPhone', 'transactionType', 'propertyAddress', 'purchaseAgreementAvailable'] as const;
export type IntakeField = typeof fields[number];
export type IntakeValues = Record<IntakeField, string>;
export interface IntakeDraft {
  schemaVersion: 1;
  mode: 'synthetic-test';
  status: 'draft' | 'simulated';
  agent: { name: string | null; email: string | null; phone: string | null };
  transaction: { type: string | null; propertyAddress: string | null; purchaseAgreementAvailable: boolean | null };
  buyers: Array<{ name: string }>;
  sellers: Array<{ name: string }>;
  purchasePrice: number | null;
  closingDate: string | null;
  deposit: { amount: number | null; dueDate: string | null };
  documents: Array<{ label: string; status: 'not-uploaded' }>;
  missingFields: IntakeField[];
  skippedFields: IntakeField[];
  humanReviewRequired: true;
  escrowNumber: null;
}

export const labels: Record<IntakeField, string> = {
  agentName: 'Agent name', agentEmail: 'Agent email', agentPhone: 'Agent phone',
  transactionType: 'Transaction type', propertyAddress: 'Property address',
  purchaseAgreementAvailable: 'Purchase agreement available',
};
export const questions: Record<IntakeField, string> = {
  agentName: 'Let’s begin with your name. For this test, use a made-up name such as “Jordan Smith.”',
  agentEmail: 'What email should we include? Use a test address such as jordan@example.com.',
  agentPhone: 'What’s the best test phone number? Please use a reserved number such as (714) 555-0100, or skip this question.',
  transactionType: 'Is this a purchase, refinance, commercial transaction, or another type of escrow?',
  propertyAddress: 'What is the test property address? Start it with “TEST,” for example “TEST 123 Sample Lane, Example City, CA.”',
  purchaseAgreementAvailable: 'Do you have a purchase agreement available? Yes, no, or not sure is fine. No document is uploaded in this test.',
};
export const sampleValues: IntakeValues = {
  agentName: 'Jordan Smith', agentEmail: 'jordan@example.com', agentPhone: '(714) 555-0100',
  transactionType: 'purchase', propertyAddress: 'TEST 123 Sample Lane, Example City, CA',
  purchaseAgreementAvailable: 'yes',
};

export function emptyValues(): IntakeValues {
  return Object.fromEntries(fields.map(field => [field, ''])) as IntakeValues;
}
export function isField(value: unknown): value is IntakeField {
  return typeof value === 'string' && (fields as readonly string[]).includes(value);
}
export function containsSensitiveData(value: string): boolean {
  return /\b(?:\d{3}[- ]\d{2}[- ]\d{4}|\d{9}|\d{12,19})\b/.test(value)
    || /\b(?:social security|ssn|routing number|bank account|account number|wire instructions|password|passcode|private key|api[_ -]?key)\b/i.test(value);
}
export function confirmationReply(value: string): 'yes' | 'no' | null {
  const normalized = value.trim().toLowerCase().replace(/[’']/g, '').replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (['yes', 'yes thats correct', 'yes that is correct', 'thats correct', 'that is correct', 'correct', 'yes thats right', 'thats right', 'confirmed'].includes(normalized)) return 'yes';
  if (['no', 'no thats incorrect', 'no that is incorrect', 'thats incorrect', 'that is incorrect', 'incorrect', 'no thats wrong', 'thats wrong'].includes(normalized)) return 'no';
  return null;
}
export function validateAnswer(field: IntakeField, input: unknown): { value?: string; error?: string } {
  if (typeof input !== 'string' || input.length > 240) return { error: 'Please keep the test answer under 240 characters.' };
  const value = input.trim().replace(/\s+/g, ' ');
  if (containsSensitiveData(value)) return { error: 'Please leave out banking details, passwords, Social Security numbers, and wire instructions. Use made-up test details only.' };
  if (!value) return { error: 'Enter a made-up test answer, or use Skip for an optional question.' };
  if (field === 'agentName' && !/^(?:[\p{L}\p{M}]+(?:['’ʼ.\-‐‑][\p{L}\p{M}]+)*\.?(?: |$)){2,}$/u.test(value)) return { error: 'Enter a fictional first and last name, such as John Smith.' };
  if (field === 'agentEmail' && !/^[\w.+-]+@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|[\w-]+\.(?:test|example))$/i.test(value)) return { error: 'Please use a reserved test email, such as jordan@example.com or jordan@agency.test.' };
  if (field === 'agentPhone') {
    const digits = value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (!/^\d{3}55501\d{2}$/.test(digits)) return { error: 'Use a reserved fictional number ending in 555-0100 through 555-0199, or skip.' };
    return { value: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` };
  }
  if (field === 'transactionType') {
    const normalized = value.toLowerCase();
    const types = ['purchase', 'refinance', 'commercial', '1031 exchange', 'other'];
    if (!types.includes(normalized)) return { error: 'Choose purchase, refinance, commercial, 1031 exchange, or other.' };
    return { value: normalized };
  }
  if (field === 'propertyAddress' && !/^(?:TEST|DEMO)\s+.{5,}$/i.test(value)) return { error: 'Use a made-up address beginning with “TEST” or “DEMO.”' };
  if (field === 'purchaseAgreementAvailable') {
    const normalized = value.toLowerCase().replace(/[.!?]+$/, '');
    if (!['yes', 'no', 'not sure'].includes(normalized)) return { error: 'Please choose yes, no, or not sure.' };
    return { value: normalized };
  }
  return { value };
}
export function makeDraft(values: IntakeValues, skipped: IntakeField[] = []): IntakeDraft {
  const safe = emptyValues();
  for (const field of fields) safe[field] = validateAnswer(field, values[field]).value || '';
  return {
    schemaVersion: 1, mode: 'synthetic-test', status: 'draft',
    agent: { name: safe.agentName || null, email: safe.agentEmail || null, phone: safe.agentPhone || null },
    transaction: {
      type: safe.transactionType || null, propertyAddress: safe.propertyAddress || null,
      purchaseAgreementAvailable: safe.purchaseAgreementAvailable === 'yes' ? true : safe.purchaseAgreementAvailable === 'no' ? false : null,
    },
    buyers: [], sellers: [], purchasePrice: null, closingDate: null,
    deposit: { amount: null, dueDate: null }, documents: [],
    missingFields: fields.filter(field => !safe[field] || safe[field] === 'not sure'),
    skippedFields: skipped.filter(isField), humanReviewRequired: true, escrowNumber: null,
  };
}
export function simulateSubmission(draft: IntakeDraft): IntakeDraft {
  return { ...draft, status: 'simulated', escrowNumber: null, humanReviewRequired: true };
}
