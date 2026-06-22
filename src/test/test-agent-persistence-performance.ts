import { describe, it, expect, summary } from './test-runner';
import { MiMoAgent } from '../agent';
import { MiMoConfig } from '../config';

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

describe('agent persistence performance guards', () => {
    it('does not persist large ui snapshot blobs into VS Code conversation state', () => {
        const agent = makeAgent() as any;
        const convId = 'persist_perf_test';
        agent.conversations.set(convId, {
            id: convId,
            title: 'persist',
            model: 'mimo-test',
            mode: 'auto',
            uiLang: 'zh',
            messages: [
                { role: 'user', content: 'hello' },
                {
                    role: 'assistant',
                    content: 'done',
                    reasoning_content: '',
                    _uiSnapshot: {
                        assistantHtml: '<div>' + 'x'.repeat(200000) + '</div>',
                        userHtml: '<div>user</div>',
                    },
                },
            ],
        });
        agent.activeId = convId;

        const snapshot = agent.buildPersistedConversationSnapshot();
        const persistedAssistant = snapshot[convId].messages.find((msg: any) => msg.role === 'assistant') as any;

        expect(!!persistedAssistant).toBe(true);
        expect('_uiSnapshot' in persistedAssistant).toBe(false);
    });
});

summary();
