/**
 * @file bridge/core/mcp/mcp-approval-gate.test.js
 *
 * Tests for McpApprovalGate.
 *
 * Uses a fake McpServerRepo (vi.fn stubs) — no real DB required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpApprovalGate } from './mcp-approval-gate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const INST = 'aabbccddeeff001122334455';  // 24-char hex — realistic institution_id

/** A representative set of tool descriptors */
const ALL_TOOLS = [
  { name: 'synaps_chat',    description: 'Chat tool'    },
  { name: 'synaps_search',  description: 'Search tool'  },
  { name: 'synaps_execute', description: 'Execute tool' },
];

/** Build a policy row with sensible defaults, easily overridden */
function makePolicy({
  tcEnabled    = true,
  allowedTools = [],
  raEnabled    = false,
  skipTools    = [],
} = {}) {
  return {
    name:        'synaps-control-plane',
    institution: INST,
    status:      'active',
    tool_configuration: {
      enabled:       tcEnabled,
      allowed_tools: allowedTools,
    },
    require_approval: {
      enabled:              raEnabled,
      skip_approval_tools:  skipTools,
    },
  };
}

// ── Shared fake repo ──────────────────────────────────────────────────────────

let fakeRepo;
let gate;

beforeEach(() => {
  fakeRepo = { findActiveByName: vi.fn() };
  gate     = new McpApprovalGate({ mcpServerRepo: fakeRepo, logger: silentLogger });
});

// ── Constructor ───────────────────────────────────────────────────────────────

describe('McpApprovalGate — constructor', () => {
  it('throws TypeError when mcpServerRepo is missing', () => {
    expect(() => new McpApprovalGate({})).toThrow(TypeError);
    expect(() => new McpApprovalGate({})).toThrow('McpApprovalGate: mcpServerRepo required');
  });

  it('does not throw when mcpServerRepo is provided', () => {
    expect(() => new McpApprovalGate({ mcpServerRepo: fakeRepo })).not.toThrow();
  });
});

// ── filterTools() — guard clauses ─────────────────────────────────────────────

describe('McpApprovalGate.filterTools() — guard clauses', () => {
  it('returns [] when institution_id is missing', async () => {
    const result = await gate.filterTools(ALL_TOOLS, {});
    expect(result).toEqual([]);
    expect(fakeRepo.findActiveByName).not.toHaveBeenCalled();
  });

  it('returns [] when institution_id is an empty string', async () => {
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: '' });
    expect(result).toEqual([]);
  });

  it('returns [] (deny-all) when no matching policy row exists', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(null);
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toEqual([]);
  });
});

// ── filterTools() — tool_configuration ────────────────────────────────────────

describe('McpApprovalGate.filterTools() — tool_configuration', () => {
  it('returns ALL tools when tool_configuration.enabled is false (whitelist bypassed)', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(makePolicy({ tcEnabled: false }));
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toHaveLength(ALL_TOOLS.length);
    expect(result.map(t => t.name)).toEqual(ALL_TOOLS.map(t => t.name));
  });

  it('returns ALL tools when tool_configuration.enabled=true but allowed_tools is empty', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(makePolicy({ tcEnabled: true, allowedTools: [] }));
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toHaveLength(ALL_TOOLS.length);
  });

  it('keeps only whitelisted tools when allowed_tools is non-empty', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: true, allowedTools: ['synaps_chat'] }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('synaps_chat');
  });

  it('returns [] when allowed_tools lists tools that are not in the input array', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: true, allowedTools: ['unknown_tool'] }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toEqual([]);
  });
});

// ── filterTools() — require_approval ──────────────────────────────────────────

describe('McpApprovalGate.filterTools() — require_approval', () => {
  it('passes all tools when require_approval.enabled is false', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: false, raEnabled: false }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toHaveLength(ALL_TOOLS.length);
  });

  it('blocks a tool when require_approval.enabled=true and it is NOT in skip_approval_tools', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: false, raEnabled: true, skipTools: [] }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toEqual([]);
  });

  it('allows a tool when require_approval.enabled=true and it IS in skip_approval_tools', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: false, raEnabled: true, skipTools: ['synaps_chat'] }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('synaps_chat');
  });

  it('exposes exactly the tools in skip_approval_tools (and no others)', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: false, raEnabled: true, skipTools: ['synaps_chat', 'synaps_search'] }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result.map(t => t.name).sort()).toEqual(['synaps_chat', 'synaps_search'].sort());
  });
});

// ── filterTools() — AND logic (whitelist + approval gate) ─────────────────────

describe('McpApprovalGate.filterTools() — AND logic', () => {
  it('requires a tool to pass BOTH whitelist AND approval checks', async () => {
    // Whitelist: only synaps_chat and synaps_search are allowed.
    // Approval:  only synaps_search is in skip_approval_tools.
    // Result:    only synaps_search passes both.
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({
        tcEnabled:    true,
        allowedTools: ['synaps_chat', 'synaps_search'],
        raEnabled:    true,
        skipTools:    ['synaps_search'],
      }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('synaps_search');
  });

  it('passes no tools when whitelist is closed and approval gate is also closed', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({
        tcEnabled:    true,
        allowedTools: ['synaps_chat'],
        raEnabled:    true,
        skipTools:    [],
      }),
    );
    const result = await gate.filterTools(ALL_TOOLS, { institution_id: INST });
    expect(result).toEqual([]);
  });
});

// ── isToolAllowed() ───────────────────────────────────────────────────────────

describe('McpApprovalGate.isToolAllowed()', () => {
  it('returns false when institution_id is absent', async () => {
    const allowed = await gate.isToolAllowed('synaps_chat', {});
    expect(allowed).toBe(false);
  });

  it('returns false when no active policy row exists', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(null);
    const allowed = await gate.isToolAllowed('synaps_chat', { institution_id: INST });
    expect(allowed).toBe(false);
  });

  it('returns true when policy permits the tool (tc disabled, ra disabled)', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: false, raEnabled: false }),
    );
    const allowed = await gate.isToolAllowed('synaps_chat', { institution_id: INST });
    expect(allowed).toBe(true);
  });

  it('returns false when tool is NOT in the whitelist', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: true, allowedTools: ['synaps_search'] }),
    );
    const allowed = await gate.isToolAllowed('synaps_chat', { institution_id: INST });
    expect(allowed).toBe(false);
  });

  it('returns true when tool is in the whitelist and approval is not required', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: true, allowedTools: ['synaps_chat'], raEnabled: false }),
    );
    const allowed = await gate.isToolAllowed('synaps_chat', { institution_id: INST });
    expect(allowed).toBe(true);
  });

  it('returns false when require_approval.enabled=true and tool not in skip_approval_tools', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: false, raEnabled: true, skipTools: ['synaps_search'] }),
    );
    const allowed = await gate.isToolAllowed('synaps_chat', { institution_id: INST });
    expect(allowed).toBe(false);
  });

  it('returns true when tool is in skip_approval_tools', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({ tcEnabled: false, raEnabled: true, skipTools: ['synaps_chat'] }),
    );
    const allowed = await gate.isToolAllowed('synaps_chat', { institution_id: INST });
    expect(allowed).toBe(true);
  });

  it('mirrors filterTools AND logic — must pass both checks', async () => {
    // Whitelist says yes, approval says no → denied
    fakeRepo.findActiveByName.mockResolvedValue(
      makePolicy({
        tcEnabled:    true,
        allowedTools: ['synaps_chat'],
        raEnabled:    true,
        skipTools:    [],
      }),
    );
    const allowed = await gate.isToolAllowed('synaps_chat', { institution_id: INST });
    expect(allowed).toBe(false);
  });
});

// ── policyName override ───────────────────────────────────────────────────────

describe('McpApprovalGate — policyName override', () => {
  it('queries repo with the custom policyName when overridden in constructor', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(null);

    const customGate = new McpApprovalGate({
      mcpServerRepo: fakeRepo,
      policyName:    'custom-policy',
      logger:        silentLogger,
    });

    await customGate.filterTools(ALL_TOOLS, { institution_id: INST });

    expect(fakeRepo.findActiveByName).toHaveBeenCalledWith({
      institution_id: INST,
      name:           'custom-policy',
    });
  });

  it('uses default policyName "synaps-control-plane" when not overridden', async () => {
    fakeRepo.findActiveByName.mockResolvedValue(null);

    await gate.filterTools(ALL_TOOLS, { institution_id: INST });

    expect(fakeRepo.findActiveByName).toHaveBeenCalledWith({
      institution_id: INST,
      name:           'synaps-control-plane',
    });
  });
});
