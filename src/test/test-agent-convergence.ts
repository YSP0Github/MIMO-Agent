import { describe, it, expect, summary } from './test-runner';
import * as fs from 'fs';
import * as path from 'path';
import { MiMoAgent } from '../agent';
import { MiMoConfig } from '../config';
import { ConversationState } from '../agentTypes';

function makeAgent(): any {
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
        workspace: process.cwd(),
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

function makeConv(messages: ConversationState['messages']): ConversationState {
    return {
        id: 'test',
        title: 'test',
        messages,
        model: 'mimo-test',
        mode: 'auto',
        uiLang: 'zh',
    };
}

describe('agent convergence guards', () => {
    it('emits write preview exactly once and includes old text for overwrites', async () => {
        const agent = makeAgent();
        const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-write-preview-'));
        const relPath = path.join(path.basename(tmpDir), 'existing.txt');
        const fullPath = path.join(process.cwd(), relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, 'before', 'utf-8');

        const previews: Array<{ previewId: string; filePath: string; content: string; isCreate: boolean; oldText?: string }> = [];
        const promise = (agent as any).handleWritePreview(
            { path: relPath, content: 'after' },
            {
                onWritePreview: (previewId: string, filePath: string, content: string, isCreate: boolean, oldText?: string) => {
                    previews.push({ previewId, filePath, content, isCreate, oldText });
                },
            },
        );

        expect(previews.length).toBe(1);
        expect(previews[0].filePath).toBe(relPath);
        expect(previews[0].content).toBe('after');
        expect(previews[0].isCreate).toBe(false);
        expect(previews[0].oldText).toBe('before');

        (agent as any).confirmWrite(previews[0].previewId, false);
        await promise;

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('uses guarded writes when confirming an external write preview', async () => {
        const workspace = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agent-workspace-'));
        const agent = new MiMoAgent({ ...makeAgent().config, workspace }, workspace) as any;
        const externalDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agent-external-'));
        const externalFile = path.join(externalDir, 'external.txt');
        fs.writeFileSync(externalFile, 'before', 'utf-8');

        const previews: Array<{ previewId: string }> = [];
        const promise = agent.handleWritePreview(
            { path: externalFile, content: 'after' },
            {
                onWritePreview: (previewId: string) => {
                    previews.push({ previewId });
                },
            },
        );

        agent.confirmWrite(previews[0].previewId, true);
        const result = await promise;

        expect(result).toContain('Written to');
        expect(result).toContain('[backup]');
        expect(fs.readFileSync(externalFile, 'utf-8')).toBe('after');

        const backupRoot = path.join(workspace, '.mimo', 'backups');
        const backups = fs.existsSync(backupRoot)
            ? fs.readdirSync(backupRoot, { recursive: true }).map(String)
            : [];
        const backupName = backups.find(name => name.endsWith('external.txt.bak'));
        expect(!!backupName).toBe(true);

        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(externalDir, { recursive: true, force: true });
    });

    it('rejects oversized content when confirming a write preview', async () => {
        const agent = makeAgent() as any;
        const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-write-large-'));
        const relPath = path.join(path.basename(tmpDir), 'large.txt');
        const largeContent = 'a'.repeat(6 * 1024 * 1024 + 1);

        const previews: Array<{ previewId: string }> = [];
        const promise = agent.handleWritePreview(
            { path: relPath, content: largeContent },
            {
                onWritePreview: (previewId: string) => {
                    previews.push({ previewId });
                },
            },
        );

        agent.confirmWrite(previews[0].previewId, true);
        const result = await promise;

        expect(result).toContain('Write failed:');
        expect(result).toContain('too large');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('detects completed git push delivery from up-to-date and clean evidence', () => {
        const agent = makeAgent();
        const conv = makeConv([
            { role: 'user', content: '帮我 git 并 push' },
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: "[stderr] git : Everything up-to-date\n[exit code: 1]",
            } as any,
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean",
            } as any,
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: 'e89f408 docs: update release notes',
            } as any,
        ]);

        const result = agent.detectGitPushDeliveryComplete(conv, '帮我 git 并 push');
        expect(result.done).toBe(true);
        expect(result.summary || '').toContain('e89f408');
        expect(result.summary || '').toContain('clean');
    });

    it('does not count read-only git execute_command as valuable progress', () => {
        const agent = makeAgent();
        const statusCall = {
            id: '1',
            type: 'function',
            function: { name: 'execute_command', arguments: JSON.stringify({ command: 'git status --short && git log --oneline -3' }) },
        };
        const commitCall = {
            id: '2',
            type: 'function',
            function: { name: 'execute_command', arguments: JSON.stringify({ command: 'git commit -m "release"' }) },
        };

        expect(agent.isProgressToolCall(statusCall, 'nothing to commit, working tree clean')).toBe(false);
        expect(agent.isProgressToolCall(commitCall, '[main abc1234] release')).toBe(true);
    });

    it('detects repeated reasoning chunks before long loops', () => {
        const agent = makeAgent();
        const repeated = Array.from({ length: 7 })
            .map(() => 'The user wants me to add a return home link, so I need to check the current navigation structure.')
            .join(' ');
        const result = agent.detectReasoningLoop(repeated);
        expect(result.detected).toBe(true);
        expect(result.count).toBeGreaterThanOrEqual(5);
    });
    it('sanitizes oversized write_file payloads before replaying them to the next model round', () => {
        const agent = makeAgent();
        const largeBody = '# Report\n\n' + 'A'.repeat(28000);
        const conv = makeConv([
            { role: 'user', content: 'Write a large report and continue.' } as any,
            {
                role: 'assistant',
                content: null as any,
                tool_calls: [
                    {
                        id: 'call-write-1',
                        type: 'function',
                        function: {
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: 'reports/huge-report.md',
                                content: largeBody,
                            }),
                        },
                    },
                ],
                reasoning_content: '',
            } as any,
            {
                role: 'tool',
                tool_call_id: 'call-write-1',
                _toolName: 'write_file',
                content: 'Written to reports/huge-report.md',
            } as any,
        ]);

        const runtimeMessages = agent.buildRuntimeContextMessages(conv);
        const assistantMsg = runtimeMessages.find((msg: any) => msg.role === 'assistant' && msg.tool_calls?.length);
        expect(!!assistantMsg).toBe(true);

        const replayArgs = JSON.parse(assistantMsg.tool_calls[0].function.arguments);
        expect(replayArgs.path).toBe('reports/huge-report.md');
        expect(replayArgs.content).not.toBe(largeBody);
        expect(replayArgs.content).toContain('omitted from conversation replay');
        expect(replayArgs.content.length).toBeLessThan(1400);
    });

    it('applies reasoning effort to request speed and depth controls', () => {
        const agent = makeAgent();
        const messages = [{ role: 'user', content: 'same question' }];
        const baseConfig = { ...agent.config, model: 'mimo-v2.5-pro', maxTokens: 10000, temperature: 0.7, topP: 0.95 };

        agent.updateConfig({ ...baseConfig, reasoningEffort: 'turbo', enableThinking: false });
        const turbo = agent.buildChatParams('mimo-v2.5-pro', messages, {}, '');
        expect(turbo.max_tokens).toBe(4000);
        expect(turbo.temperature).toBe(0.2);
        expect(turbo.top_p).toBe(0.8);
        expect(turbo.extra_body.thinking.type).toBe('disabled');

        agent.updateConfig({ ...baseConfig, reasoningEffort: 'balanced', enableThinking: false });
        const balanced = agent.buildChatParams('mimo-v2.5-pro', messages, {}, '');
        expect(balanced.max_tokens).toBe(8500);
        expect(balanced.temperature).toBe(0.7);
        expect(balanced.extra_body).toBe(undefined);

        agent.updateConfig({ ...baseConfig, reasoningEffort: 'deep', enableThinking: true });
        const deep = agent.buildChatParams('mimo-v2.5-pro', messages, {}, '');
        expect(deep.max_tokens).toBe(11500);
        expect(deep.temperature).toBe(0.55);
        expect(deep.extra_body.thinking.type).toBe('enabled');

        agent.updateConfig({ ...baseConfig, reasoningEffort: 'max', enableThinking: true });
        const max = agent.buildChatParams('mimo-v2.5-pro', messages, {}, '');
        expect(max.max_tokens).toBe(14500);
        expect(max.temperature).toBe(0.35);
        expect(max.extra_body.thinking.type).toBe('enabled');
    });

    it('keeps direct-answer token caps distinct per reasoning effort', () => {
        const agent = makeAgent();
        const messages = [{ role: 'user', content: 'same question' }];
        agent.updateConfig({ ...agent.config, model: 'mimo-v2.5-pro', maxTokens: 20000, reasoningEffort: 'turbo', enableThinking: false });
        const turbo = agent.buildChatParams('mimo-v2.5-pro', messages, { max_tokens: agent.getReasoningProfile().directMaxTokens, _applyReasoningMultiplier: false }, '');

        agent.updateConfig({ ...agent.config, model: 'mimo-v2.5-pro', maxTokens: 20000, reasoningEffort: 'max', enableThinking: true });
        const max = agent.buildChatParams('mimo-v2.5-pro', messages, { max_tokens: agent.getReasoningProfile().directMaxTokens, _applyReasoningMultiplier: false }, '');

        expect(turbo.max_tokens).toBe(500);
        expect(max.max_tokens).toBe(3800);
        expect(max.max_tokens).toBeGreaterThan(turbo.max_tokens);
    });

    it('treats raw shell command drafts as unfinished tool work', () => {
        const agent = makeAgent();
        const draft = [
            'chcp 65001 > $null',
            '$bytes = [System.IO.File]::ReadAllBytes("mimo-promo/index.html")',
            '$text = [System.Text.Encoding]::UTF8.GetString($bytes)',
            'Find all install-steps and install-step CSS rules',
            "$pattern = '\\.install-steps\\{[^}]+'",
            '$matches = [regex]::Matches($text, $pattern)',
            'foreach ($m in $matches) { Write-Output "CSS: $($m.Value)" }',
        ].join('\n');

        expect(agent.isRawShellCommandDraft(draft)).toBe(true);
        expect(agent.isUnexecutedActionStatement(draft)).toBe(true);
    });

    it('treats Chinese promises to inspect an existing version as unfinished tool work', () => {
        const agent = makeAgent();
        const draft = '好的老板，先看看你现有的版本！';

        expect(agent.isUnexecutedActionStatement(draft)).toBe(true);
    });

    it('keeps Auto mode open when the assistant only promises to inspect', () => {
        const agent = makeAgent();
        const conv = makeConv([
            { role: 'user', content: '开干，不过我已经有一个版本了，你帮我优化一下飞机动画' },
        ]);

        const decision = agent.shouldContinueAutoAfterTextFinal(
            conv,
            'moderate',
            '好的老板，先看看你现有的版本！',
            1,
            600,
        );

        expect(decision.shouldContinue).toBe(true);
        expect(decision.reason).toContain('pending tool-backed step');
    });

    it('does not keep Auto mode open only because a Chinese final summary says completed', () => {
        const agent = makeAgent();
        const conv = makeConv([
            { role: 'user', content: 'fix the homepage styles and summarize the result' },
            { role: 'tool', _toolName: 'read_file', content: 'Read src/webview/styles.css' } as any,
        ]);

        const decision = agent.shouldContinueAutoAfterTextFinal(
            conv,
            'moderate',
            [
                '任务已完成。',
                '',
                '处理结果：',
                '- 调整了标题样式',
                '- 统一了按钮间距',
                '',
                '修改已经保存到目标文件。',
            ].join('\n'),
            2,
            600,
        );

        expect(decision.shouldContinue).toBe(false);
    });

    it('stops Auto mode for completed planning-only delivery that waits for user choice', () => {
        const agent = makeAgent();
        const conv = makeConv([
            { role: 'user', content: '我想用网页实现该游戏，你能给我个实现方案吗？难点在哪' },
        ]);

        const decision = agent.shouldContinueAutoAfterTextFinal(
            conv,
            'complex',
            [
                '任务完成总结',
                '',
                '任务类型：方案分析（纯规划，无代码修改）',
                '已交付：',
                '- 视频分析：识别为手机休闲消除游戏录屏',
                '- 技术方案：单文件 HTML + Canvas 2D',
                '- 难点清单：弧形轨道、发射弹道、颜色匹配消除',
                '- 开发路线：5 步渐进开发',
                '',
                '文件变更：无（纯分析任务，未修改任何文件，无需文件级验证）。',
                '下一步：等待老板指示，A. 直接开始实现 或 B. 调整方案。',
            ].join('\n'),
            1,
            600,
        );

        expect(decision.shouldContinue).toBe(false);
    });

    it('names saved planning summaries from the user task instead of assistant chatter', () => {
        const agent = makeAgent();
        const filename = (agent as any).buildSummaryFilename(
            [
                '好的，我已经有足够的项目上下文了。你的工作区已有多个单文件 HTML5 Canvas 游戏。',
                '',
                '## 技术实现方案',
                '- Canvas 2D',
                '- 发射系统',
            ].join('\n'),
            '我想用网页实现一个类似泡泡龙/祖玛的小游戏。请只做方案分析，不要修改任何文件。',
        );

        expect(filename).toContain('mimo-plan-');
        expect(filename).toContain('泡泡龙-祖玛');
        expect(filename.includes('好的')).toBe(false);
        expect(filename).toMatch(/\.md$/);
    });

    it('uses a Chinese saved-copy label for Chinese long summaries', () => {
        const agent = makeAgent();
        const events = {
            onReasoning: () => {},
        } as any;
        const longSummary = [
            '任务完成总结',
            '',
            '## 技术实现方案',
            ...Array.from({ length: 140 }, (_, i) => `- 第 ${i + 1} 项：方案分析内容，保持中文上下文用于测试另存提示。`),
        ].join('\n');

        const result = (agent as any).maybeSaveLongFinalResponse(
            longSummary,
            events,
            '我想用网页实现一个类似泡泡龙/祖玛的小游戏。请只做方案分析。',
        );
        const saved = String(result).match(/已另存为: (.+\.md)/)?.[1];

        expect(result).toContain('已另存为: mimo-plan-');
        expect(result).toContain('泡泡龙-祖玛');
        if (saved)
            fs.rmSync(path.join(process.cwd(), saved), { force: true });
    });

    it('recognizes Chinese delivery summaries as finalizable', () => {
        const agent = makeAgent();
        const deliverySummary = [
            '任务完成',
            '',
            '交付文件：',
            '- `src/webview/styles.css`',
            '',
            '验证：已检查修改是否写入目标文件。',
            '下一步建议：如需更稳妥可再补一次界面预览。',
        ].join('\n');

        expect(agent.isDeliverySummary(deliverySummary)).toBe(true);
    });

    it('keeps self-check instructions append-only instead of asking for a rewrite', () => {
        const agent = makeAgent();
        const msg = agent.buildSelfCheckInstruction('auto', 'needs validation', 'Task completed.');
        const text = String(msg.content || '');

        expect(text).toContain('preserve it');
        expect(text).toContain('append-only');
        expect(text).toContain('Do not retract or rewrite the whole draft');
    });

    it('formats unlimited round budgets without leaking MAX_SAFE_INTEGER', () => {
        const agent = makeAgent();
        const conv = makeConv([
            { role: 'user', content: 'fix the failing request' },
        ]);

        const summary = agent.buildProgressSummary(conv, 'task interrupted by API or runtime error', {
            round: 3,
            maxRounds: Number.MAX_SAFE_INTEGER,
            softMaxRounds: Number.MAX_SAFE_INTEGER,
        });

        expect(summary.includes(String(Number.MAX_SAFE_INTEGER))).toBe(false);
        expect(summary).toContain('Progress: round 3 (unlimited budget)');
        expect(summary).toContain('Soft budget: unlimited');
    });

    it('filters unchanged dirty workspace diff blocks from execute_command previews', () => {
        const agent = makeAgent();
        const oldDirty = [
            'diff --git a/mimo-promo/index.html b/mimo-promo/index.html',
            '--- a/mimo-promo/index.html',
            '+++ b/mimo-promo/index.html',
            '@@ -1 +1 @@',
            '-old',
            '+old dirty',
            '',
        ].join('\n');
        const newDoc = [
            'diff --git a/essay_on_love.md b/essay_on_love.md',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/essay_on_love.md',
            '@@ -0,0 +1,2 @@',
            '+# 以爱为题',
            '+正文',
            '',
        ].join('\n');

        const filtered = (agent as any).filterNewGitPatchBlocks(oldDirty, oldDirty + newDoc);
        expect(filtered.includes('essay_on_love.md')).toBe(true);
        expect(filtered.includes('mimo-promo/index.html')).toBe(false);
    });

    it('keeps automatic chat fallback inside the active provider model family', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'deepseek-tts',
            models: ['deepseek-tts', 'deepseek-chat', 'mimo-v2.5-pro'],
            baseUrl: 'https://api.deepseek.com/v1',
        });

        const fallback = agent.findChatModel('deepseek-tts', true);
        expect(fallback).toBe('deepseek-chat');
    });

    it('does not fallback from a non-MiMo model to MiMo when no same-provider chat model exists', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'custom-tts',
            models: ['custom-tts', 'mimo-v2.5-pro'],
            baseUrl: 'https://example.test/v1',
        });

        const fallback = agent.findChatModel('custom-tts', true);
        expect(fallback).toBeNull();
    });

    it('falls back to a configured alternate endpoint without reusing the missing model', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'missing-chat',
            activeProviderProfile: 'broken',
            activeRoute: { endpoint_id: 'broken', model: 'missing-chat' },
            providerProfiles: [
                {
                    id: 'broken',
                    name: 'Broken',
                    base_url: 'https://broken.example/v1',
                    api_key: 'broken-key',
                    model: 'missing-chat',
                    models: ['missing-chat'],
                },
                {
                    id: 'working',
                    name: 'Working',
                    base_url: 'https://working.example/v1',
                    api_key: 'working-key',
                    model: 'working-chat',
                    models: ['working-chat'],
                },
            ],
        });

        const route = (agent as any).findFallbackRouteForChat('missing-chat', 'broken');
        expect(route.endpointId).toBe('working');
        expect(route.model).toBe('working-chat');
    });

    it('keeps automatic vision fallback inside MiMo models only when current model is MiMo', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'deepseek-chat',
            models: ['deepseek-chat', 'mimo-v2.5'],
            baseUrl: 'https://api.deepseek.com/v1',
        });
        expect(agent.findVisionModel('deepseek-chat')).toBeNull();

        agent.updateConfig({
            ...agent.config,
            model: 'mimo-v2.5-pro',
            models: ['mimo-v2.5-pro', 'mimo-v2.5', 'deepseek-chat'],
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        });
        expect(agent.findVisionModel('mimo-v2.5-pro')).toBe('mimo-v2.5');
    });

    it('uses the built-in MiMo vision fallback when a profile only lists the Pro model', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'mimo-v2.5-pro',
            models: ['mimo-v2.5-pro'],
            activeProviderProfile: 'mimo-cn',
            activeRoute: { endpoint_id: 'mimo-cn', model: 'mimo-v2.5-pro' },
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            providerProfiles: [
                {
                    id: 'mimo-cn',
                    name: 'MiMo CN',
                    provider: 'mimo',
                    base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
                    api_key: 'cn-key',
                    model: 'mimo-v2.5-pro',
                    models: ['mimo-v2.5-pro'],
                },
            ],
        });

        expect(agent.findVisionModel('mimo-v2.5-pro', 'mimo-cn')).toBe('mimo-v2.5');
    });

    it('keeps image history text-only for non-vision main models', () => {
        const agent = makeAgent();
        const conv = makeConv([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Please inspect this screenshot' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,aaaa' } },
                ],
            } as any,
        ]);
        conv.model = 'mimo-v2.5-pro';

        const runtimeMessages = agent.buildRuntimeContextMessages(conv);
        expect(Array.isArray(runtimeMessages[0].content)).toBe(false);
        expect(String(runtimeMessages[0].content)).toContain('Please inspect this screenshot');
        expect(String(runtimeMessages[0].content)).toContain('1 image');
    });

    it('aggressively slims MiMo runtime replay when tool and reasoning history grow large', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'mimo-v2.5-pro',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            activeRoute: { endpoint_id: '', model: 'mimo-v2.5-pro' },
        });
        const messages: any[] = [];
        for (let i = 0; i < 18; i++) {
            messages.push({ role: 'user', content: `user request ${i} ` + 'u'.repeat(220) });
            messages.push({
                role: 'assistant',
                content: `assistant output ${i} ` + 'a'.repeat(2400),
                reasoning_content: 'r'.repeat(5000),
                tool_calls: i % 2 === 0 ? [{
                    id: `call_${i}`,
                    type: 'function',
                    function: { name: 'write_file', arguments: JSON.stringify({ path: `file_${i}.md`, content: 'x'.repeat(8000) }) },
                }] : undefined,
            });
            if (i % 2 === 0) {
                messages.push({
                    role: 'tool',
                    tool_call_id: `call_${i}`,
                    content: `Written file_${i}.md\n` + 't'.repeat(4000),
                    _toolName: 'write_file',
                });
            }
        }
        const conv = makeConv(messages as any);
        conv.model = 'mimo-v2.5-pro';

        const runtimeMessages = agent.buildRuntimeContextMessages(conv);
        const toolMessages = runtimeMessages.filter((message: any) => message.role === 'tool');
        const assistantToolMessages = runtimeMessages.filter((message: any) => message.role === 'assistant' && !!message.tool_calls?.length);
        const assistantReasoning = runtimeMessages
            .filter((message: any) => message.role === 'assistant')
            .map((message: any) => String(message.reasoning_content || ''));

        expect(runtimeMessages.length <= 17).toBe(true);
        expect(toolMessages.length <= 6).toBe(true);
        expect(assistantToolMessages.length <= 2).toBe(true);
        expect(assistantReasoning.some((text: string) => text.length === 0)).toBe(true);
        expect(assistantReasoning.every((text: string) => text.length <= 800)).toBe(true);
    });

    it('uses earlier summarization and a smaller keep-recent window for MiMo routes', () => {
        const agent = makeAgent();
        const mimoConv = makeConv([{ role: 'user', content: 'task' } as any]);
        mimoConv.model = 'mimo-v2.5-pro';
        mimoConv.modelEndpointId = '';
        agent.updateConfig({
            ...agent.config,
            model: 'mimo-v2.5-pro',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            activeRoute: { endpoint_id: '', model: 'mimo-v2.5-pro' },
        });

        const otherAgent = makeAgent();
        const otherConv = makeConv([{ role: 'user', content: 'task' } as any]);
        otherConv.model = 'deepseek-chat';

        const noisyMessages = Array.from({ length: 8 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `segment ${i} ` + 'x'.repeat(12000),
        })) as any;
        const simplerMessages = Array.from({ length: 4 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `segment ${i} ` + 'x'.repeat(4000),
        })) as any;

        expect(agent.getContextKeepRecent(mimoConv, 'complex')).toBeLessThan(otherAgent.getContextKeepRecent(otherConv, 'complex'));
        expect(agent.shouldUseSummarization(noisyMessages, 'mimo-v2.5-pro', 'moderate', 0)).toBe(true);
        expect(agent.shouldUseSummarization(simplerMessages, 'mimo-v2.5-pro', 'moderate', 0)).toBe(true);
        expect(otherAgent.shouldUseSummarization(simplerMessages, 'deepseek-chat', 'moderate', 0)).toBe(false);
        expect(otherAgent.shouldUseSummarization(noisyMessages, 'deepseek-chat', 'moderate', 0)).toBe(true);
    });

    it('distinguishes the same model id on different endpoints', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'mimo-v2.5-pro',
            activeProviderProfile: 'mimo-cn',
            activeRoute: { endpoint_id: 'mimo-cn', model: 'mimo-v2.5-pro' },
            providerProfiles: [
                {
                    id: 'mimo-cn',
                    name: 'MiMo CN',
                    base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
                    api_key: 'cn-key',
                    model: 'mimo-v2.5-pro',
                    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
                },
                {
                    id: 'mimo-proxy',
                    name: 'MiMo Proxy',
                    base_url: 'https://proxy.example.test/v1',
                    api_key: 'proxy-key',
                    model: 'mimo-v2.5-pro',
                    models: ['mimo-v2.5-pro'],
                },
            ],
        });

        const options = agent.getModelOptions();
        expect(options.map((option: any) => option.value)).toContain('mimo-cn::mimo-v2.5-pro');
        expect(options.map((option: any) => option.value)).toContain('mimo-proxy::mimo-v2.5-pro');

        const convId = agent.createConversation();
        agent.setModel('mimo-proxy::mimo-v2.5-pro', convId);
        expect(agent.getConversation(convId).model).toBe('mimo-v2.5-pro');
        expect(agent.getConversation(convId).modelEndpointId).toBe('mimo-proxy');
        expect(agent.getModelSelectionValue(convId)).toBe('mimo-proxy::mimo-v2.5-pro');
    });

    it('binds built-in multimodal MCP to the current endpoint profile and MiMo speech defaults', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            apiKey: 'global-key',
            baseUrl: 'https://global.example/v1',
            model: 'mimo-v2.5-pro',
            activeProviderProfile: 'voice',
            activeRoute: { endpoint_id: 'voice', model: 'mimo-v2.5-pro' },
            providerProfiles: [
                {
                    id: 'voice',
                    name: 'Voice',
                    provider: 'mimo',
                    base_url: 'https://voice.example/v1',
                    api_endpoint: 'chat_completions',
                    api_key: 'voice-key',
                    model: 'mimo-v2.5-pro',
                    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
                },
            ],
        });

        const convId = agent.createConversation();
        agent.setModel('voice::mimo-v2.5-pro', convId);
        const conv = agent.getConversation(convId);
        const args = (agent as any).prepareBuiltinMultimodalArgs('mcp_mimo_multimodal_transcribe_audio', {}, conv);

        expect(args._mimo_api_key).toBe('voice-key');
        expect(args._mimo_base_url).toBe('https://voice.example/v1');
        expect(args.model).toBe('mimo-v2.5-asr');
        expect(args._mimo_tts_model).toBe('mimo-v2.5-tts');
        expect(args._mimo_multimodal_model).toBe('mimo-v2.5');
    });

    it('keeps one model option per model-card profile', () => {
        const agent = makeAgent();
        agent.updateConfig({
            ...agent.config,
            model: 'mimo-v2.5-pro',
            activeProviderProfile: 'mimo-v2-5-pro',
            activeRoute: { endpoint_id: 'mimo-v2-5-pro', model: 'mimo-v2.5-pro' },
            providerProfiles: [
                {
                    id: 'mimo-v2-5-pro',
                    name: 'MiMo Pro',
                    base_url: 'https://api.example.test/v1',
                    api_key: 'key',
                    model: 'mimo-v2.5-pro',
                    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro'],
                },
                {
                    id: 'mimo-v2-5',
                    name: 'MiMo V2.5',
                    base_url: 'https://api.example.test/v1',
                    api_key: 'key',
                    model: 'mimo-v2.5',
                    models: ['mimo-v2.5'],
                },
            ],
        });

        const values = agent.getModelOptions().map((option: any) => option.value);
        expect(values.includes('mimo-v2-5-pro::mimo-v2.5-pro')).toBe(true);
        expect(values.includes('mimo-v2-5::mimo-v2.5')).toBe(true);
        expect(values.includes('mimo-v2-5-pro::mimo-v2-pro')).toBe(false);
    });

    it('does not infer deliverables from ffprobe-style source paths alone', () => {
        const agent = makeAgent();
        const audioPath = 'g:\\AI World\\output\\高考作文音频\\voicedesign_test.wav';
        const conv = makeConv([
            {
                role: 'assistant',
                content: null as any,
                tool_calls: [
                    {
                        id: 'call-1',
                        type: 'function',
                        function: {
                            name: 'execute_command',
                            arguments: JSON.stringify({ command: `ffprobe -i "${audioPath}"` }),
                        },
                    },
                ],
            } as any,
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: `Input #0, wav, from '${audioPath}': Duration: 00:00:23.20`,
            } as any,
        ]);
        const stableFinalText = agent.appendMissingArtifactSummary(conv, 'Task completed.');
        expect(stableFinalText.includes('交付文件')).toBe(false);
        expect(stableFinalText.includes('Artifacts:')).toBe(false);
        expect(stableFinalText.includes(audioPath)).toBe(false);
        return;

        const finalText = agent.appendMissingArtifactSummary(conv, '任务完成。');
        expect(finalText.includes('交付文件')).toBe(true);
        expect(finalText.includes(audioPath)).toBe(false);
    });

    it('does not duplicate artifact paths already present in final summaries', () => {
        const agent = makeAgent();
        const audioPath = 'g:\\AI World\\output\\高考作文音频\\voicedesign_test.wav';
        const conv = makeConv([
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: `Generated file: ${audioPath}`,
            } as any,
        ]);

        const finalText = agent.appendMissingArtifactSummary(conv, `音频已生成：${audioPath}`);
        expect(finalText.split(audioPath).length - 1).toBe(1);
    });
    it('only adds artifact paths from the current user turn', () => {
        const agent = makeAgent();
        const previousAudio = 'g:\\AI World\\audio\\yujie-voice.mp3';
        const currentArtifact = 'g:\\AI World\\promo\\current-layout.svg';
        const conv = makeConv([
            { role: 'user', content: 'Generate a 10 second voice sample.' } as any,
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: `Generated file: ${previousAudio}`,
            } as any,
            { role: 'assistant', content: `Audio generated: ${previousAudio}` } as any,
            { role: 'user', content: 'Fix the promo page layout.' } as any,
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: `Updated file: ${currentArtifact}`,
            } as any,
        ]);

        const finalText = agent.appendMissingArtifactSummary(conv, 'Task completed.');
        expect(finalText.includes(currentArtifact)).toBe(true);
        expect(finalText.includes(previousAudio)).toBe(false);
    });

    it('ignores code-like shell fragments that merely end with artifact extensions', () => {
        const agent = makeAgent();
        const realArtifact = 'ramanujan_pi_convergence.csv';
        const conv = makeConv([
            { role: 'user', content: 'Analyze the html file.' } as any,
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: `Artifacts:\n- ${realArtifact}\n- /4)*i;ctx.beginPath();ctx.mov\n- /15)pv,y-p.t+ph-(conv[i].c/mx)ph;i===0?ctx.mov`,
            } as any,
        ]);

        const finalText = agent.appendMissingArtifactSummary(conv, 'Task completed.');
        expect(finalText.includes(realArtifact)).toBe(true);
        expect(finalText.includes('ctx.beginPath')).toBe(false);
        expect(finalText.includes('ctx.mov')).toBe(false);
    });

    it('does not treat input or source asset paths introduced by from as new deliverables', () => {
        const agent = makeAgent();
        const sourceAsset = 'G:\\AI World\\moon_texture_4k.jpg';
        const outputHtml = 'G:\\AI World\\tuxedo-cat\\index.html';
        const conv = makeConv([
            { role: 'user', content: '只改一个 HTML 文件。' } as any,
            {
                role: 'tool',
                _toolName: 'execute_command',
                content: `Input #0, image2, from '${sourceAsset}': metadata loaded`,
            } as any,
            {
                role: 'tool',
                _toolName: 'write_file',
                content: `Updated file: ${outputHtml}`,
            } as any,
        ]);

        const finalText = agent.appendMissingArtifactSummary(conv, '任务完成。');
        expect(finalText.includes(outputHtml)).toBe(false);
        expect(finalText.includes(sourceAsset)).toBe(false);
    });
    it('does not keep Auto mode open for a creation-only promise without a real tool step', () => {
        const agent = makeAgent();
        const conv = makeConv([
            { role: 'user', content: '帮我生成一个测试大文件，用来测试MIMO的生成性能' } as any,
        ]);

        const decision = agent.shouldContinueAutoAfterTextFinal(
            conv,
            'moderate',
            '好的，我来创建一个大型测试文件。这个文件将是一个完整的 Python 数据分析脚本，用于测试生成性能。',
            1,
            600,
        );

        expect(decision.shouldContinue).toBe(false);
    });
    it('keeps Auto mode open when final audio count does not match the user request', () => {
        const agent = makeAgent();
        const conv = makeConv([
            { role: 'user', content: '请生成 4 个缺失章节的朗读音频。' } as any,
            {
                role: 'assistant',
                content: null as any,
                tool_calls: Array.from({ length: 4 }, (_, i) => ({
                    id: `call-${i + 1}`,
                    type: 'function',
                    function: {
                        name: 'mcp_mimo_multimodal_synthesize_speech',
                        arguments: JSON.stringify({ output: `chapter0${i + 3}.mp3` }),
                    },
                })),
            } as any,
            {
                role: 'tool',
                _toolName: 'mcp_mimo_multimodal_synthesize_speech',
                content: 'Generated file: G:\\audio\\chapter03.mp3',
            } as any,
            {
                role: 'tool',
                _toolName: 'mcp_mimo_multimodal_synthesize_speech',
                content: 'Generated file: G:\\audio\\chapter04.mp3',
            } as any,
            {
                role: 'tool',
                _toolName: 'mcp_mimo_multimodal_synthesize_speech',
                content: 'Generated file: G:\\audio\\chapter05.mp3',
            } as any,
            {
                role: 'tool',
                _toolName: 'mcp_mimo_multimodal_synthesize_speech',
                content: 'Generated file: G:\\audio\\chapter06.mp3',
            } as any,
        ]);

        const decision = agent.shouldContinueAutoAfterTextFinal(
            conv,
            'moderate',
            '4 个音频全部生成成功。全部 6 个音频文件就绪。',
            2,
            600,
        );

        expect(decision.shouldContinue).toBe(true);
        expect(decision.reason).toContain('requested 4');
    });

    it('self-check instructions forbid unrelated API-key guidance during verification follow-up', () => {
        const agent = makeAgent();
        const msg = agent.buildSelfCheckInstruction('auto', 'needs validation', '音频已生成。');
        const text = String(msg.content || '');

        expect(text).toContain('Do not introduce unrelated topics such as API keys');
        expect(text).toContain('settings.json');
    });
});

summary();
