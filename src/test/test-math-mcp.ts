import { describe, it, expect, summary } from './test-runner';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSystemPrompt } from '../prompt';

describe('math mcp guidance', () => {
    it('documents the math MCP tool guidance in the system prompt', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-math-prompt-'));
        const prompt = buildSystemPrompt(workspace);
        expect(prompt).toContain('mcp_mimo_multimodal_sympy_simplify');
        expect(prompt).toContain('mcp_mimo_multimodal_sympy_solve');
        expect(prompt).toContain('mcp_mimo_multimodal_matrix_calculator');
        expect(prompt).toContain('mcp_mimo_multimodal_equation_derivation_checker');
        expect(prompt).toContain('mcp_mimo_multimodal_math_reasoning_mode');
        fs.rmSync(workspace, { recursive: true, force: true });
    });
});

summary();
