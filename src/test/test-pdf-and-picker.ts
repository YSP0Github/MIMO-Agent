import { describe, it, expect, summary } from './test-runner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MiMoAgent } from '../agent';
import { MiMoConfig } from '../config';
import { buildSmartOutputPath } from '../mcpMultimodalServer';
import { collectWorkspaceFileEntries, DEFAULT_WORKSPACE_FILE_PICKER_MAX_ENTRIES, orderWorkspaceFileEntriesForTree } from '../workspaceFilePicker';

function makeAgent(workspace = process.cwd()): any {
    const config: MiMoConfig = {
        apiKey: '',
        baseUrl: 'http://localhost',
        model: 'mimo-test',
        models: [],
        activeProviderProfile: '',
        activeRoute: { endpoint_id: '', model: 'mimo-test' },
        providerProfiles: [],
        maxTokens: 1024,
        maxRounds: 0,
        temperature: 0.2,
        topP: 0.95,
        enableThinking: false,
        reasoningEffort: 'fast',
        maxOutputLen: 5000,
        commandTimeout: 30,
        workspace,
        sandbox: { enabled: false, mode: 'safe', image: '', memoryLimit: '1g', cpuLimit: 1, timeoutSec: 30, gitSnapshot: false, logging: false, networkDisabled: false },
        mcpServers: [],
        adversarial: { maxIterations: 3, toolBudget: 10, reviewDimensions: [], enableVerification: true, convergenceThreshold: 2 },
        infinite: { maxRounds: 300, hardMultiplier: 2, stallLimit: 5 },
        context: { autoCompress: false, summarizeAtPercent: 70, summarizeAtMessages: 48, keepRecentMessages: 18, maxSummaryTokens: 1200 },
        memory: { enabled: false, learnFromExplicitPreferences: false, maxItems: 10, maxInjected: 0 },
        dependencyInstall: { enabled: true, projectMode: 'auto', systemMode: 'confirm', longTimeoutSec: 600 },
        settings: {},
        apiEndpoint: 'chat_completions',
    };
    return new MiMoAgent(config, process.cwd());
}

describe('pdf and picker helpers', () => {
    it('builds multimodal outputs next to the source pdf by default', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-pdf-workspace-'));
        const pdfDir = path.join(workspace, '04_methods', '16_fast_gdcst_gamp_sbl', 'docs', 'source');
        fs.mkdirSync(pdfDir, { recursive: true });
        const pdfPath = path.join(pdfDir, 'paper.pdf');
        fs.writeFileSync(pdfPath, 'stub', 'utf-8');

        const out = buildSmartOutputPath('pdf-page', 'png', pdfPath, '');
        expect(path.dirname(out)).toBe(path.join(pdfDir, '.mimo'));

        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('saves long summaries next to a referenced source file when possible', () => {
        const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-summary-source-'));
        const sourceFile = path.join(sourceDir, 'paper.pdf');
        fs.writeFileSync(sourceFile, 'stub', 'utf-8');
        const agent = makeAgent();
        const events = { onReasoning: () => {} } as any;
        const longSummary = ['Summary', '', ...Array.from({ length: 420 }, (_, i) => `Line ${i + 1}: detailed summary content for save-path testing.`)].join('\n');

        const result = (agent as any).maybeSaveLongFinalResponse(
            longSummary,
            events,
            `Please analyze ${sourceFile} and summarize it.`,
        );
        const saved = String(result).match(/Saved path: (.+\.md)/)?.[1];

        expect(!!saved).toBe(true);
        expect(path.dirname(saved || '')).toBe(sourceDir);

        if (saved) fs.rmSync(saved, { force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
    });

    it('collects later root directories instead of starving them behind the first large branch', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-picker-workspace-'));
        const first = path.join(workspace, '01_alpha');
        const second = path.join(workspace, '02_beta');
        const later = path.join(workspace, '09_archive');
        fs.mkdirSync(first, { recursive: true });
        fs.mkdirSync(second, { recursive: true });
        fs.mkdirSync(later, { recursive: true });

        for (let i = 0; i < 300; i++) {
            fs.mkdirSync(path.join(first, `nested-${i}`), { recursive: true });
            fs.writeFileSync(path.join(first, `nested-${i}`, `file-${i}.txt`), 'x', 'utf-8');
        }
        fs.writeFileSync(path.join(second, 'keep.txt'), 'x', 'utf-8');
        fs.writeFileSync(path.join(later, 'seen.txt'), 'x', 'utf-8');

        const entries = collectWorkspaceFileEntries(workspace, 8000);
        const names = entries.filter((e: any) => e.parent === '').map((e: any) => e.name);

        expect(names).toContain('01_alpha');
        expect(names).toContain('02_beta');
        expect(names).toContain('09_archive');

        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('reorders picker entries into parent-before-children tree order for display', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-picker-tree-'));
        const docs = path.join(workspace, '01_docs');
        const notes = path.join(docs, 'notes');
        const later = path.join(workspace, '09_archive');
        fs.mkdirSync(notes, { recursive: true });
        fs.mkdirSync(later, { recursive: true });
        fs.writeFileSync(path.join(notes, 'todo.txt'), 'x', 'utf-8');
        fs.writeFileSync(path.join(later, 'seen.txt'), 'x', 'utf-8');

        const bfsEntries = collectWorkspaceFileEntries(workspace, 8000);
        const ordered = orderWorkspaceFileEntriesForTree(bfsEntries);
        const rel = ordered.map((entry: any) => entry.relativePath);

        expect(rel.indexOf('01_docs')).toBeGreaterThanOrEqual(0);
        expect(rel.indexOf('01_docs/notes')).toBeGreaterThan(rel.indexOf('01_docs'));
        expect(rel.indexOf('01_docs/notes/todo.txt')).toBeGreaterThan(rel.indexOf('01_docs/notes'));
        expect(rel.indexOf('09_archive')).toBeGreaterThan(rel.indexOf('01_docs/notes/todo.txt'));

        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('uses a larger picker collection limit so broad workspaces are less likely to truncate', () => {
        expect(DEFAULT_WORKSPACE_FILE_PICKER_MAX_ENTRIES).toBeGreaterThanOrEqual(12000);
    });

    it('keeps the empty-query tree display cap well above the old 2000-entry limit', () => {
        const displayCap = 6000;
        expect(displayCap).toBeGreaterThan(2000);
    });

    it('keeps the empty-query request limit above the old 500-entry cap', () => {
        expect(DEFAULT_WORKSPACE_FILE_PICKER_MAX_ENTRIES).toBeGreaterThan(500);
    });
});

summary();
