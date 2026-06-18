import { ChatMessage, ContentPart, MiMoAPI } from './api';
import { MiMoConfig } from './config';
import { getContextStats } from './context';
import { ConversationState } from './agentTypes';
import { MODEL_CAPABILITIES, inferModelCapabilities } from './modelCapabilities';

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface ContextRefreshDecision {
    should: boolean;
    reason: string;
}

export interface ContextMemoryResult {
    updated: boolean;
    reason?: string;
    segmentMessages?: number;
    keptRecentMessages?: number;
    force?: boolean;
    fallbackNotice?: string;
}

export class AgentContextRuntime {
    constructor(
        private readonly getConfig: () => MiMoConfig,
        private readonly getApi: () => MiMoAPI,
    ) {}

    shouldUseSummarization(
        messages: ChatMessage[],
        model: string,
        taskComplexity: TaskComplexity,
        systemPromptLength?: number,
    ): boolean {
        const stats = getContextStats(messages, model, systemPromptLength);
        if (taskComplexity === 'complex') return stats.percent > 62;
        if (taskComplexity === 'simple') return stats.percent > 86;
        return stats.percent > 74;
    }

    getContextKeepRecent(conv: ConversationState, taskComplexity: TaskComplexity): number {
        const configured = this.getConfig().context?.keepRecentMessages ?? 18;
        const modeBoost = conv.mode === 'infinite' ? 8 : 0;
        const complexityBoost = taskComplexity === 'complex' ? 6 : taskComplexity === 'moderate' ? 2 : 0;
        return Math.max(8, Math.min(80, configured + modeBoost + complexityBoost));
    }

    findSafeRecentStart(messages: ChatMessage[], keepRecent: number): number {
        if (messages.length <= keepRecent) return 0;
        let start = Math.max(0, messages.length - keepRecent);

        while (start > 0 && messages[start]?.role === 'tool') {
            start--;
        }

        while (start > 0 && messages[start - 1]?.role === 'tool') {
            start--;
        }

        return start;
    }

    private modelSupportsVision(model: string): boolean {
        return (MODEL_CAPABILITIES[model] || inferModelCapabilities(model)).vision;
    }

    private buildModelSafeRuntimeMessages(messages: ChatMessage[], model: string): ChatMessage[] {
        if (this.modelSupportsVision(model)) return messages;
        return messages.map((message) => {
            if (!Array.isArray(message.content)) return message;
            const textParts: string[] = [];
            let imageCount = 0;
            for (const part of message.content) {
                if (part?.type === 'text' && part.text) {
                    textParts.push(part.text);
                } else if (part?.type === 'image_url') {
                    imageCount++;
                }
            }
            if (imageCount === 0) return message;
            const imageNote = `[${imageCount} image${imageCount === 1 ? '' : 's'} were attached earlier. If image details were needed, they were converted to text in the corresponding user turn.]`;
            return {
                ...message,
                content: [...textParts, imageNote].filter(Boolean).join('\n\n'),
            };
        });
    }

    buildRuntimeContextMessages(conv: ConversationState): ChatMessage[] {
        const covered = Math.max(0, Math.min(conv.contextSummaryMessageCount || 0, conv.messages.length));
        if (!conv.contextSummary || covered <= 0) {
            return this.buildModelSafeRuntimeMessages(conv.messages, conv.model);
        }
        return this.buildModelSafeRuntimeMessages([
            {
                role: 'system',
                content: `[Auto Context Summary - ${covered} earlier messages compressed]\n${conv.contextSummary}`,
            } as any,
            ...conv.messages.slice(covered),
        ], conv.model);
    }

    shouldRefreshContextMemory(
        conv: ConversationState,
        taskComplexity: TaskComplexity,
        systemContent: string,
        safeStart: number,
        force = false,
    ): ContextRefreshDecision {
        const config = this.getConfig();
        if (force) return { should: true, reason: 'forced by context overflow' };
        if (!config.context?.autoCompress) return { should: false, reason: 'auto compression disabled' };
        if (safeStart < 12) return { should: false, reason: 'not enough old context to summarize' };

        const cfg = config.context;
        const rawStats = getContextStats(conv.messages, conv.model, systemContent.length);
        const runtimeStats = getContextStats(this.buildRuntimeContextMessages(conv), conv.model, systemContent.length);
        const percentTrigger = conv.mode === 'infinite'
            ? Math.min(cfg.summarizeAtPercent, taskComplexity === 'complex' ? 62 : 68)
            : cfg.summarizeAtPercent;
        const messageTrigger = conv.mode === 'infinite'
            ? Math.max(24, Math.floor(cfg.summarizeAtMessages * 0.85))
            : cfg.summarizeAtMessages;
        const covered = conv.contextSummaryMessageCount || 0;
        const newCompressibleMessages = safeStart - covered;
        const minRefreshBatch = Math.max(8, Math.floor(this.getContextKeepRecent(conv, taskComplexity) / 2.5));
        if (newCompressibleMessages <= 0) {
            return { should: false, reason: 'no new old context to summarize' };
        }

        if (runtimeStats.percent >= percentTrigger && newCompressibleMessages >= minRefreshBatch) {
            return { should: true, reason: `runtime context usage ${runtimeStats.percent}%` };
        }

        if (conv.mode === 'infinite' && conv.messages.length >= messageTrigger && newCompressibleMessages >= minRefreshBatch) {
            return { should: true, reason: `long infinite-mode task (${conv.messages.length} messages)` };
        }

        if (rawStats.percent >= percentTrigger || runtimeStats.percent >= percentTrigger) {
            return {
                should: false,
                reason: `context high but waiting for a larger compression batch (${newCompressibleMessages}/${minRefreshBatch})`,
            };
        }

        return { should: false, reason: 'below compression threshold' };
    }

    async ensureContextMemory(
        conv: ConversationState,
        taskComplexity: TaskComplexity,
        systemContent: string,
        signal?: AbortSignal,
        force = false,
    ): Promise<ContextMemoryResult> {
        const keepRecent = this.getContextKeepRecent(conv, taskComplexity);
        const safeStart = this.findSafeRecentStart(conv.messages, keepRecent);
        const decision = this.shouldRefreshContextMemory(conv, taskComplexity, systemContent, safeStart, force);
        if (!decision.should) return { updated: false, reason: decision.reason };

        const covered = Math.max(0, Math.min(conv.contextSummaryMessageCount || 0, conv.messages.length));
        const segmentStart = conv.contextSummary ? covered : 0;
        const segmentEnd = Math.max(segmentStart, safeStart);
        const segment = conv.messages.slice(segmentStart, segmentEnd);
        if (segment.length === 0) return { updated: false, reason: 'no segment to summarize' };

        const generated = await this.generateContextSummary(conv, segment, signal);
        conv.contextSummary = generated.summary;
        conv.contextSummaryMessageCount = segmentEnd;
        conv.contextSummaryUpdatedAt = Date.now();
        return {
            updated: true,
            reason: decision.reason,
            segmentMessages: segment.length,
            keptRecentMessages: conv.messages.length - segmentEnd,
            force,
            fallbackNotice: generated.fallbackNotice,
        };
    }

    private async generateContextSummary(
        conv: ConversationState,
        segment: ChatMessage[],
        signal?: AbortSignal,
    ): Promise<{ summary: string; fallbackNotice?: string }> {
        const config = this.getConfig();
        const existingSummary = conv.contextSummary || '';
        const segmentText = this.trimForSummaryPrompt(this.formatMessagesForSummary(segment), 14_000);
        const prompt = `You are compressing memory for a long-running coding agent. Merge the existing summary and the new conversation segment into one concise, actionable context summary.

Rules:
- Preserve the user's current goal and acceptance criteria.
- Preserve exact file paths, commands, errors, test results, settings, and important decisions.
- Preserve what has already been read, changed, verified, and what remains pending.
- Drop raw logs, repeated chatter, duplicate reasoning, and low-value detail.
- Write as compact operational memory for the next model call, not as a transcript.
- Keep it under ${config.context?.maxSummaryTokens ?? 1200} tokens.

Existing summary:
${existingSummary || '(none)'}

New segment to merge:
${segmentText}

Updated summary:`;

        try {
            const summary = await this.getApi().chatCompletion({
                model: conv.model,
                messages: [
                    { role: 'system', content: 'You summarize coding-agent context. Output only the updated summary.' },
                    { role: 'user', content: prompt },
                ],
                max_tokens: config.context?.maxSummaryTokens ?? 1200,
                temperature: 0.2,
            }, signal);

            if (summary && summary.trim().length > 80) {
                return { summary: summary.trim() };
            }
        } catch (e: any) {
            return {
                summary: this.buildLocalContextSummary(conv, segment, existingSummary),
                fallbackNotice: `[Context compression failed: ${String(e?.message || e).slice(0, 120)}. Using local summary.]`,
            };
        }

        return { summary: this.buildLocalContextSummary(conv, segment, existingSummary) };
    }

    private formatMessagesForSummary(messages: ChatMessage[]): string {
        return messages.map((msg, index) => {
            const text = this.extractMessageText(msg.content).replace(/\s+/g, ' ').trim();
            if (msg.role === 'assistant') {
                const toolNames = msg.tool_calls?.map(tc => tc.function.name).join(', ');
                const parts = [`[${index}] Assistant:`];
                if (text) parts.push(text.slice(0, 1200));
                if (toolNames) parts.push(`Tool calls: ${toolNames}`);
                return parts.join(' ');
            }
            if (msg.role === 'tool') {
                const label = msg._toolName || msg.tool_call_id || 'tool';
                return `[${index}] Tool ${label}: ${text.slice(0, 1000)}`;
            }
            if (msg.role === 'user') {
                return `[${index}] User: ${text.slice(0, 1600)}`;
            }
            return `[${index}] ${msg.role}: ${text.slice(0, 1000)}`;
        }).join('\n\n');
    }

    private trimForSummaryPrompt(text: string, maxChars: number): string {
        if (text.length <= maxChars) return text;
        const head = text.slice(0, Math.floor(maxChars * 0.35));
        const tail = text.slice(text.length - Math.floor(maxChars * 0.6));
        return `${head}\n\n[... middle omitted for summary prompt ...]\n\n${tail}`;
    }

    private buildLocalContextSummary(conv: ConversationState, segment: ChatMessage[], existingSummary?: string): string {
        const userGoals = segment
            .filter(m => m.role === 'user')
            .map(m => this.extractMessageText(m.content).slice(0, 220))
            .filter(Boolean)
            .slice(-5);
        const changedFiles = new Set<string>();
        const recentTools = segment
            .filter(m => m.role === 'tool')
            .slice(-8)
            .map(m => {
                const toolName = m._toolName || 'tool';
                const text = this.extractMessageText(m.content);
                const fileMatch = text.match(/([A-Za-z]:\\[^\r\n]+|\/[^\r\n\s]+)/);
                if (fileMatch && ['edit_file', 'write_file', 'delete_file'].includes(toolName)) {
                    changedFiles.add(fileMatch[1]);
                }
                return `- ${toolName}: ${text.slice(0, 220)}`;
            });

        return [
            existingSummary ? `Previous summary:\n${existingSummary.slice(0, 1600)}` : '',
            `Current mode: ${conv.mode}`,
            userGoals.length ? `Recent user goals:\n${userGoals.map(g => `- ${g}`).join('\n')}` : '',
            changedFiles.size ? `Changed files:\n${Array.from(changedFiles).map(f => `- ${f}`).join('\n')}` : '',
            recentTools.length ? `Recent tool evidence:\n${recentTools.join('\n')}` : '',
            'Next step: continue from the latest raw messages, verify concrete changes before finalizing, and preserve user constraints.',
        ].filter(Boolean).join('\n\n');
    }

    private extractMessageText(content: string | ContentPart[] | null | undefined): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter((part) => part.type === 'text')
                .map((part) => part.text || '')
                .join(' ')
                .trim();
        }
        return '';
    }
}
