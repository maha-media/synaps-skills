/**
 * @file tests/scp-phase-7/02-mcp-approval-gate-filtering.test.mjs
 *
 * Use mongo-memory-server. Insert raw `mcpservers` rows.
 * Drive the McpApprovalGate with a real McpServerRepo.
 *
 * Tests:
 *  1.  no row for institution → filterTools returns []
 *  2.  row with status=inactive → filterTools returns []
 *  3.  row with tool_configuration.enabled=false → all tools allowed (whitelist skipped)
 *  4.  row with allowed_tools=['synaps_chat'] → only synaps_chat retained from 2-tool input
 *  5.  row with allowed_tools=[] and tool_configuration.enabled=true → all allowed
 *  6.  row with require_approval.enabled=true, skip_approval_tools=[] → all denied
 *  7.  row with require_approval.enabled=true, skip_approval_tools=['synaps_chat'] → synaps_chat allowed
 *  8.  whitelist + approval combined: tool must pass BOTH (case: in whitelist, blocked by approval)
 *  9.  whitelist + approval combined: tool in skip list but NOT in whitelist → denied
 * 10.  isToolAllowed mirrors filterTools for a single tool
 * 11.  different institution sees different policy (isolation)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { McpServerRepo }   from '../../bridge/core/db/repositories/mcp-server-repo.js';
import { McpApprovalGate } from '../../bridge/core/mcp/mcp-approval-gate.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Two mock tools to use in filter tests. */
const TOOLS = [
  { name: 'synaps_chat',   description: 'Chat tool'   },
  { name: 'synaps_search', description: 'Search tool' },
];

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let mongod;
let m;
let mcpServerRepo;
let gate;
let coll;  // raw collection for inserting test rows

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 10_000, autoIndex: true });

  mcpServerRepo = new McpServerRepo({ db: m.connection });
  gate          = new McpApprovalGate({ mcpServerRepo, logger: silent });
  coll          = m.connection.collection('mcpservers');
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await coll.deleteMany({});
});

// ─── Helper to insert an mcpservers row ───────────────────────────────────────

function insertPolicyRow(institutionId, overrides = {}) {
  const defaultRow = {
    name:               'synaps-control-plane',
    institution:        new mongoose.Types.ObjectId(institutionId),
    status:             'active',
    tool_configuration: { enabled: false, allowed_tools: [] },
    require_approval:   { enabled: false, skip_approval_tools: [] },
  };
  return coll.insertOne({ ...defaultRow, ...overrides });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpApprovalGate — policy filtering', () => {

  it('1. no row for institution → filterTools returns []', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toEqual([]);
  });

  it('2. row with status=inactive → filterTools returns []', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, { status: 'inactive' });

    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toEqual([]);
  });

  it('3. tool_configuration.enabled=false → all tools pass (whitelist disabled)', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: false, allowed_tools: ['synaps_chat'] }, // ignored when enabled=false
      require_approval:   { enabled: false, skip_approval_tools: [] },
    });

    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toHaveLength(2);
  });

  it('4. allowed_tools=[\'synaps_chat\'] → only synaps_chat retained', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: true, allowed_tools: ['synaps_chat'] },
      require_approval:   { enabled: false, skip_approval_tools: [] },
    });

    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('synaps_chat');
  });

  it('5. allowed_tools=[] and tool_configuration.enabled=true → all allowed (empty = open)', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: true, allowed_tools: [] },
      require_approval:   { enabled: false, skip_approval_tools: [] },
    });

    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toHaveLength(2);
  });

  it('6. require_approval.enabled=true, skip_approval_tools=[] → all denied', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: false, allowed_tools: [] },
      require_approval:   { enabled: true, skip_approval_tools: [] },
    });

    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toEqual([]);
  });

  it('7. require_approval.enabled=true, skip=[\'synaps_chat\'] → only synaps_chat allowed', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: false, allowed_tools: [] },
      require_approval:   { enabled: true, skip_approval_tools: ['synaps_chat'] },
    });

    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('synaps_chat');
  });

  it('8. whitelist+approval: tool in whitelist, blocked by approval → denied', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: true, allowed_tools: ['synaps_chat'] }, // passes whitelist
      require_approval:   { enabled: true, skip_approval_tools: [] },        // all blocked
    });

    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toEqual([]); // synaps_chat fails approval
  });

  it('9. whitelist+approval: in skip list but NOT in whitelist → denied', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: true, allowed_tools: ['synaps_search'] },   // only search in whitelist
      require_approval:   { enabled: true, skip_approval_tools: ['synaps_chat'] }, // chat skips approval
    });

    // synaps_chat: fails whitelist → denied
    // synaps_search: passes whitelist, fails approval → denied
    const result = await gate.filterTools(TOOLS, { institution_id: instId });
    expect(result).toEqual([]);
  });

  it('10. isToolAllowed mirrors filterTools for a single tool', async () => {
    const instId = new mongoose.Types.ObjectId().toString();
    await insertPolicyRow(instId, {
      tool_configuration: { enabled: true, allowed_tools: ['synaps_chat'] },
      require_approval:   { enabled: false, skip_approval_tools: [] },
    });

    const chatAllowed   = await gate.isToolAllowed('synaps_chat',   { institution_id: instId });
    const searchAllowed = await gate.isToolAllowed('synaps_search', { institution_id: instId });

    expect(chatAllowed).toBe(true);
    expect(searchAllowed).toBe(false);
  });

  it('11. different institution sees different policy (isolation)', async () => {
    const instA = new mongoose.Types.ObjectId().toString();
    const instB = new mongoose.Types.ObjectId().toString();

    // Inst A: open policy
    await insertPolicyRow(instA, {
      tool_configuration: { enabled: false, allowed_tools: [] },
      require_approval:   { enabled: false, skip_approval_tools: [] },
    });

    // Inst B: deny-all approval gate
    await insertPolicyRow(instB, {
      tool_configuration: { enabled: false, allowed_tools: [] },
      require_approval:   { enabled: true, skip_approval_tools: [] },
    });

    const resultA = await gate.filterTools(TOOLS, { institution_id: instA });
    const resultB = await gate.filterTools(TOOLS, { institution_id: instB });

    expect(resultA).toHaveLength(2); // A sees both
    expect(resultB).toHaveLength(0); // B sees none
  });
});
