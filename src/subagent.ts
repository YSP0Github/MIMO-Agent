/**
 * Sub-Agent System
 *
 * Spawns isolated sub-agents for focused tasks:
 * - Explore: read-only codebase search (fast, safe)
 * - General: full tool access for independent tasks
 *
 * Each sub-agent has its own message history and does NOT pollute
 * the main conversation. Results are returned as plain text.
 */

import { MiMoAPI, ChatMessage, ToolCall, ToolDefinition } from './api';
import { TOOL_DEFINITIONS, executeTool } from './tools';
import { buildSystemPrompt } from './prompt';
import { manageContext } from './context';
import { McpManager } from './mcp';
import { SandboxConfig } from './sandbox';
import { DependencyInstallConfig } from './dependencyInstall';
import { sanitizeToolCallsForConversation } from './toolCallSanitizer';

// ── Types ──

export type SubAgentType = 'explore' | 'general';

export interface SubAgentOptions {
    type: SubAgentType;
    task: string;
    maxRounds?: number;
    model?: string;
    worktree?: string;  // Optional worktree path to work in
}

export interface SubAgentResult {
    output: string;
    toolCalls: number;
    rounds: number;
    elapsed: number;
}

export interface SubAgentEvents {
    onToken?: (token: string) => void;
    onStatus?: (status: string) => void;
    onToolCallStart?: (name: string, args: Record<string, any>) => void;
    onToolCallEnd?: (name: string, result: string, isError: boolean, elapsed: number, gitDiff?: string) => void;
    onRoundStart?: (round: number) => void;
    onDone?: (result: SubAgentResult) => void;
    onError?: (error: string) => void;
}

// ── Tool filters by agent type ──

const EXPLORE_TOOLS = new Set([
    'read_file',
    'search_files',
    'glob_files',
    'list_directory',
    'get_file_info',
    'git_status',
    'git_diff',
    'git_log',
]);

// General agent gets all tools except spawn_subagent (no recursion)
const GENERAL_EXCLUDED = new Set(['spawn_subagent']);

function filterTools(type: SubAgentType, allTools: ToolDefinition[]): ToolDefinition[] {
    if (type === 'explore') {
        return allTools.filter(t => EXPLORE_TOOLS.has(t.function.name));
    }
    return allTools.filter(t => !GENERAL_EXCLUDED.has(t.function.name));
}

type ReasoningEffort = 'turbo' | 'fast' | 'balanced' | 'deep' | 'max';

function getReasoningProfile(value?: ReasoningEffort, enableThinking?: boolean): {
    tokenMultiplier: number;
    roundMultiplier: number;
    temperature?: number;
    topP?: number;
    thinking?: 'disabled' | 'enabled';
} {
    const effort = value || (enableThinking ? 'deep' : 'balanced');
    switch (effort) {
        case 'turbo':
            return { tokenMultiplier: 0.4, roundMultiplier: 0.3, temperature: 0.2, topP: 0.8, thinking: 'disabled' };
        case 'fast':
            return { tokenMultiplier: 0.6, roundMultiplier: 0.5, temperature: 0.4, topP: 0.9, thinking: 'disabled' };
        case 'deep':
            return { tokenMultiplier: 1.1, roundMultiplier: 0.95, temperature: 0.55, thinking: 'enabled' };
        case 'max':
            return { tokenMultiplier: 1.35, roundMultiplier: 1.2, temperature: 0.35, topP: 0.9, thinking: 'enabled' };
        default:
            return { tokenMultiplier: 0.85, roundMultiplier: 0.7 };
    }
}

// ── Sub-Agent Runner ──

export async function runSubAgent(
    options: SubAgentOptions,
    api: MiMoAPI,
    workspace: string,
    mcpManager: McpManager,
    config: {
        maxTokens: number;
        temperature: number;
        topP: number;
        maxOutputLen: number;
        commandTimeout: number;
        sandbox?: SandboxConfig;
        enableThinking: boolean;
        reasoningEffort?: ReasoningEffort;
        dependencyInstall?: Partial<DependencyInstallConfig>;
    },
    events: SubAgentEvents = {},
    signal?: AbortSignal,
): Promise<SubAgentResult> {
    const t0 = Date.now();
    const effortProfile = getReasoningProfile(config.reasoningEffort, config.enableThinking);
    const baseRounds = options.maxRounds ?? (options.type === 'explore' ? 4 : 6);
    const minRounds = options.type === 'explore' ? 2 : 3;
    const maxRounds = Math.max(minRounds, Math.round(baseRounds * effortProfile.roundMultiplier));
    const model = options.model || 'mimo-v2.5-pro';
    const cwd = options.worktree || workspace;

    // Build system prompt for sub-agent — heavily differentiated by type
    const typeHint = options.type === 'explore'
        ? `You are an Explore sub-agent — the eyes and ears of the main agent.
Your Mission: Find and report information. You are READ-ONLY — never modify files.

Search Strategy:
1. Start broad (glob for structure), then narrow (grep for specifics)
2. When you find something relevant, read the surrounding context (±20 lines)
3. If the first search doesn't find it, try different patterns/keywords
4. Always report: file path, line numbers, and the actual code snippet

Output Format:
### Findings
- **[Topic]**: [file:line] — [what you found]
### Relevant Context
[Key code snippets or configuration]
### Gaps
[What you couldn't find or needs further investigation]`
        : `You are a General sub-agent — a focused executor.
Your Mission: Complete your assigned task efficiently and precisely.

Working Style:
1. Understand the task fully before acting
2. Make minimal, targeted changes
3. Verify your changes work (syntax check, test if available)
4. Report exactly what you did and any issues encountered

Output Format:
### Result
[What was accomplished]
### Changes Made
- [file]: [what changed]
### Issues (if any)
[What went wrong and what was tried]`;

    const systemPrompt = `${typeHint}

Workspace: ${cwd}
Task: You are working on a specific sub-task. Complete it and return your findings/result.

Rules:
- Be concise and focused on your task
- Use tools efficiently — don't read unnecessary files
- Return your final answer as clear text when done
- Do NOT ask questions — make reasonable assumptions and proceed`;

    // Get available tools filtered by type
    const allTools = [...TOOL_DEFINITIONS, ...mcpManager.getAllToolDefinitions()];
    const tools = filterTools(options.type, allTools);

    // Independent message history for this sub-agent
    const messages: ChatMessage[] = [
        { role: 'user', content: options.task },
    ];

    let totalToolCalls = 0;
    let round = 0;

    for (round = 1; round <= maxRounds; round++) {
        if (signal?.aborted) {
            return { output: '(aborted)', toolCalls: totalToolCalls, rounds: round, elapsed: Date.now() - t0 };
        }

        events.onRoundStart?.(round);
        events.onStatus?.(`Sub-agent round ${round}...`);

        // Context management for sub-agent
        const managed = manageContext(messages, model);

        const params: Record<string, any> = {
            model,
            messages: [
                { role: 'system' as const, content: systemPrompt },
                ...managed,
            ],
            max_tokens: Math.max(256, Math.min(131072, Math.round(config.maxTokens * effortProfile.tokenMultiplier))),
            temperature: effortProfile.temperature ?? config.temperature,
            top_p: effortProfile.topP ?? config.topP,
            stream_options: { include_usage: true },
        };
        if (tools.length > 0) {
            params.tools = tools;
            params.tool_choice = 'auto';
        }
        if (effortProfile.thinking) {
            params.extra_body = { thinking: { type: effortProfile.thinking } };
        }

        let content: string;
        let toolCalls: ToolCall[];
        try {
            const result = await api.chatCompletionsStream(params, {
                onToken: (t) => events.onToken?.(t),
                onReasoning: () => {},
            }, signal);
            content = result.content;
            toolCalls = result.toolCalls;
        } catch (e: any) {
            if (signal?.aborted) {
                return { output: '(aborted)', toolCalls: totalToolCalls, rounds: round, elapsed: Date.now() - t0 };
            }
            return { output: `Sub-agent API error: ${e.message}`, toolCalls: totalToolCalls, rounds: round, elapsed: Date.now() - t0 };
        }

        if (toolCalls.length === 0) {
            // No more tool calls — sub-agent is done
            return {
                output: content || '(no output)',
                toolCalls: totalToolCalls,
                rounds: round,
                elapsed: Date.now() - t0,
            };
        }

        // Execute tool calls
        const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: content || null as any,
            tool_calls: sanitizeToolCallsForConversation(toolCalls),
            reasoning_content: '',
        };
        messages.push(assistantMsg);

        for (const tc of toolCalls) {
            if (signal?.aborted) break;

            let args: Record<string, any> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }

            events.onToolCallStart?.(tc.function.name, args);
            const toolT0 = Date.now();

            // Execute in the sub-agent's working directory
            const result = mcpManager.isMcpTool(tc.function.name)
                ? await mcpManager.callTool(tc.function.name, args)
                : await executeTool(
                    tc.function.name,
                    args,
                    cwd,  // Use worktree or workspace
                    config.maxOutputLen,
                    config.commandTimeout,
                    config.sandbox,
                    undefined,
                    config.dependencyInstall,
                );

            const elapsed = (Date.now() - toolT0) / 1000;
            const isError = result.startsWith('Safety:') || result.startsWith('Tool error:') || result.startsWith('Unknown tool');
            events.onToolCallEnd?.(tc.function.name, result, isError, elapsed);

            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result,
            });
            totalToolCalls++;
        }
    }

    // Max rounds reached — get last assistant content
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    let lastContent: string = '(max rounds reached)';
    if (assistantMsgs.length > 0) {
        const last = assistantMsgs[assistantMsgs.length - 1];
        const content: any = last.content;
        if (typeof content === 'string') lastContent = content;
    }
    return {
        output: lastContent,
        toolCalls: totalToolCalls,
        rounds: maxRounds,
        elapsed: Date.now() - t0,
    };
}
