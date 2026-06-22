import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { MiMoAPI, ChatMessage, ContentPart, ToolCall } from './api';
import { TOOL_DEFINITIONS, executeTool, writeTextFileWithGuards } from './tools';
import { buildSystemPrompt, loadInstructions, validateInstructions } from './prompt';
import { MiMoConfig } from './config';
import { Skill, loadSkills, renderSkill, saveUserSkill, deleteUserSkill } from './skills';
import { manageContext, getContextStats, summarizeContext, recordTokenUsage, estimateTotalTokens } from './context';
import { McpManager, McpServerConfig } from './mcp';
import { detectPersona, buildPersonaPrompt, getPersona } from './personas';
import { runSubAgent, SubAgentOptions, SubAgentResult, SubAgentEvents } from './subagent';
import { HookManager } from './hooks';
import { TokenTracker, TokenUsage } from './tokenTracker';
import { executeWorkflow, WorkflowPhase, WorkflowResult, WorkflowEvents } from './workflow';
import { classifyIntent, IntentResult, checkAdversarialSuitability, quickClassifyIntent, requiresToolBackedAnswer, requiresToolEvidence } from './router';
import { MemoryManager, ToolObservation } from './memory';
import { AgentEvents, AgentMode, CompletionGateDecision, ConversationState, PendingAsk, PendingEdit, PendingWrite, RoundProgress, TaskChangeFile, TaskChangeSummary, TrackedIssue } from './agentTypes';
import { DEFAULT_MODELS, MODEL_CAPABILITIES, ModelCapabilities, PREFERRED_CHAT_MODELS, inferModelCapabilities, normalizeModelName } from './modelCapabilities';
import { getFriendlyError } from './agentErrors';
import { buildUserFacingHandoff, stripInternalHandoffNoise } from './handoff';
import { PLAN_MODE_ANALYSIS_GUIDANCE, PLAN_MODE_EXECUTION_GUIDANCE } from './planMode';
import { sanitizeMessageToolCallsForConversation, sanitizeToolCallsForConversation } from './toolCallSanitizer';
export { AgentEvents, AgentMode, ConversationState, TrackedIssue } from './agentTypes';
export class MiMoAgent extends EventEmitter {
    private api: MiMoAPI;
    private endpointApis = new Map<string, MiMoAPI>();
    private systemPrompt: string;
    /** Cached personalized instructions from MIMO.md / Agent.md / claude.md */
    private personalizedInstructions: string = '';
    private skills: Map<string, Skill>;
    private conversations = new Map<string, ConversationState>();
    private activeId: string = '';
    /** Per-conversation abort controllers — each conversation runs independently */
    private abortControllers = new Map<string, AbortController>();
    /** Conversations that have been explicitly stopped by the user */
    private stoppingConversations = new Set<string>();
    private mcpManager: McpManager;
    private hookManager: HookManager;
    private tokenTracker: TokenTracker;
    private memoryManager: MemoryManager;
    private pendingEdits = new Map<string, PendingEdit>();
    private pendingWrites = new Map<string, PendingWrite>();
    private pendingAsks = new Map<string, PendingAsk>();
    private traceSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    private lastPersistedConversationSnapshot = '';
    private conversationSaveTimer: ReturnType<typeof setTimeout> | undefined;
    // ── Input boundary handling ──
    /** Max input length before truncation */
    private static readonly MAX_INPUT_LENGTH = 100000; // 100k chars
    /** Track active chats per conversation to prevent concurrent sends */
    private activeChats = new Map<string, Promise<string>>();
    /** Track recent inputs for repeated input detection */
    private recentInputs = new Map<string, {
        count: number;
        lastTime: number;
    }>();
    private static readonly MODEL_ROUTE_SEPARATOR = '::';
    private static readonly ARTIFACT_EXTENSIONS = [
        'wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg', 'opus',
        'mp4', 'mov', 'webm', 'avi', 'mkv',
        'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
        'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
        'csv', 'vtt', 'srt',
    ];
    private encodeModelRoute(endpointId: string, model: string): string {
        return endpointId
            ? `${endpointId}${MiMoAgent.MODEL_ROUTE_SEPARATOR}${model}`
            : model;
    }
    private decodeModelRoute(value: string): {
        endpointId: string;
        model: string;
    } {
        const raw = String(value || '').trim();
        const sep = MiMoAgent.MODEL_ROUTE_SEPARATOR;
        const idx = raw.indexOf(sep);
        if (idx <= 0)
            return { endpointId: '', model: raw };
        return {
            endpointId: raw.slice(0, idx).trim(),
            model: raw.slice(idx + sep.length).trim(),
        };
    }
    private getProfile(endpointId?: string) {
        const id = String(endpointId || '').trim();
        if (!id)
            return undefined;
        return (this.config.providerProfiles || []).find(profile => profile.id === id);
    }
    private getEndpointBaseUrl(endpointId?: string): string {
        return this.getProfile(endpointId)?.base_url || this.config.baseUrl;
    }
    private isMimoRoute(conv?: ConversationState, endpointId?: string): boolean {
        return this.isMimoModel(conv?.model || this.config.model)
            || /xiaomimimo|mimo/i.test(this.getEndpointBaseUrl(endpointId));
    }
    private friendlyRouteError(error: Error | string, conv?: ConversationState, endpointId?: string): string {
        const api = this.getApiForEndpoint(endpointId);
        return getFriendlyError(error, {
            model: conv?.model || this.config.model,
            baseUrl: this.getEndpointBaseUrl(endpointId),
            requestSummary: api.getLastRequestSummary(),
        });
    }
    private emitTerminalApiError(events: AgentEvents, errorText: string, conv?: ConversationState, endpointId?: string): void {
        if (this.isMimoRoute(conv, endpointId)) {
            events.onStatus('MiMo API 返回了可解释的中断信息，请查看上方原因和建议后继续。');
            return;
        }
        events.onError(errorText);
    }
    private getApiForEndpoint(endpointId?: string): MiMoAPI {
        const profile = this.getProfile(endpointId);
        if (!profile)
            return this.api;
        const cacheKey = JSON.stringify({
            endpointId: String(endpointId || '').trim(),
            apiKey: profile.api_key || this.config.apiKey,
            baseUrl: profile.base_url || this.config.baseUrl,
            apiEndpoint: profile.api_endpoint || this.config.apiEndpoint,
        });
        const cached = this.endpointApis.get(cacheKey);
        if (cached)
            return cached;
        const api = new MiMoAPI(profile.api_key || this.config.apiKey, profile.base_url || this.config.baseUrl, profile.api_endpoint || this.config.apiEndpoint);
        this.endpointApis.set(cacheKey, api);
        return api;
    }
    private prepareBuiltinMultimodalArgs(toolName: string, args: Record<string, any>, conv?: ConversationState): Record<string, any> {
        const endpointId = this.getConversationEndpointId(conv);
        const profile = this.getProfile(endpointId);
        const prepared: Record<string, any> = {
            ...args,
            _mimo_api_key: args._mimo_api_key || profile?.api_key || this.config.apiKey,
            _mimo_base_url: args._mimo_base_url || profile?.base_url || this.config.baseUrl,
            _mimo_api_endpoint: args._mimo_api_endpoint || profile?.api_endpoint || this.config.apiEndpoint,
            _mimo_multimodal_model: args._mimo_multimodal_model || this.findVisionModel(conv?.model || this.config.model, endpointId) || 'mimo-v2.5',
            _mimo_tts_model: args._mimo_tts_model || 'mimo-v2.5-tts',
            _mimo_asr_model: args._mimo_asr_model || 'mimo-v2.5-asr',
        };
        if (/transcribe_audio$/i.test(toolName) && !prepared.model) {
            prepared.model = prepared._mimo_asr_model;
        }
        else if (/synthesize_speech$/i.test(toolName) && !prepared.model) {
            prepared.model = prepared._mimo_tts_model;
        }
        else if (/(?:analyze_pdf|render_pdf_pages|analyze_office_document|render_office_pages|inspect_office_archive|analyze_epub|inspect_epub|preview_tabular_data|extract_document_images|sympy_simplify|sympy_solve|matrix_calculator|equation_derivation_checker|math_reasoning_mode)$/i.test(toolName) && !prepared.model) {
            prepared.model = prepared._mimo_multimodal_model;
        }
        return prepared;
    }
    private getConversationEndpointId(conv?: ConversationState): string {
        return conv?.modelEndpointId || this.config.activeRoute?.endpoint_id || this.config.activeProviderProfile || '';
    }
    private normalizeReadFilePath(filePath: string): string {
        return String(filePath || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    }
    private getReadFileRange(args: Record<string, any>): {
        path: string;
        start: number;
        end: number;
        limit: number;
    } | null {
        const filePath = this.normalizeReadFilePath(args.path || args.file || '');
        if (!filePath)
            return null;
        const rawOffset = Number(args.offset ?? 0);
        const rawLimit = Number(args.limit ?? 500);
        const start = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);
        const limit = Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 500);
        return { path: filePath, start, end: start + limit, limit };
    }
    private mergeReadRanges(ranges: Array<{
        start: number;
        end: number;
    }>): Array<{
        start: number;
        end: number;
    }> {
        const sorted = ranges
            .filter(r => r.end > r.start)
            .sort((a, b) => a.start - b.start || a.end - b.end);
        const merged: Array<{
            start: number;
            end: number;
        }> = [];
        for (const range of sorted) {
            const last = merged[merged.length - 1];
            if (!last || range.start > last.end) {
                merged.push({ ...range });
            }
            else {
                last.end = Math.max(last.end, range.end);
            }
        }
        return merged;
    }
    private readRangeCoveredLength(ranges: Array<{
        start: number;
        end: number;
    }>, start: number, end: number): number {
        let covered = 0;
        for (const range of this.mergeReadRanges(ranges)) {
            const overlapStart = Math.max(start, range.start);
            const overlapEnd = Math.min(end, range.end);
            if (overlapEnd > overlapStart)
                covered += overlapEnd - overlapStart;
        }
        return covered;
    }
    private firstUnreadReadRange(ranges: Array<{
        start: number;
        end: number;
    }>, start: number, end: number): {
        start: number;
        end: number;
    } | null {
        let cursor = start;
        for (const range of this.mergeReadRanges(ranges)) {
            if (range.end <= cursor)
                continue;
            if (range.start > cursor)
                return { start: cursor, end: Math.min(range.start, end) };
            cursor = Math.max(cursor, range.end);
            if (cursor >= end)
                return null;
        }
        return cursor < end ? { start: cursor, end } : null;
    }
    getModelCapabilities(model: string): ModelCapabilities {
        const route = this.decodeModelRoute(model);
        const actualModel = route.model || model;
        return MODEL_CAPABILITIES[actualModel] || inferModelCapabilities(actualModel, this.getEndpointBaseUrl(route.endpointId));
    }
    private shouldSendThinkingControl(model: string, endpointId = ''): boolean {
        const routedModel = endpointId ? this.encodeModelRoute(endpointId, model) : model;
        return this.getModelCapabilities(routedModel).thinkingControl;
    }
    private getReasoningProfile(): {
        tokenMultiplier: number;
        roundMultiplier: number;
        stallMultiplier: number;
        temperature?: number;
        topP?: number;
        thinking?: 'enabled' | 'disabled';
        directMaxTokens: number;
    } {
        const effort = this.config.reasoningEffort || (this.config.enableThinking ? 'deep' : 'balanced');
        switch (effort) {
            case 'turbo':
                return {
                    tokenMultiplier: 0.4,
                    roundMultiplier: 0.3,
                    stallMultiplier: 0.5,
                    temperature: 0.2,
                    topP: 0.8,
                    thinking: 'disabled',
                    directMaxTokens: 500,
                };
            case 'fast':
                return {
                    tokenMultiplier: 0.6,
                    roundMultiplier: 0.5,
                    stallMultiplier: 0.65,
                    temperature: 0.4,
                    topP: 0.9,
                    thinking: 'disabled',
                    directMaxTokens: 900,
                };
            case 'deep':
                return {
                    tokenMultiplier: 1.15,
                    roundMultiplier: 1.05,
                    stallMultiplier: 1.05,
                    temperature: 0.55,
                    thinking: 'enabled',
                    directMaxTokens: 2600,
                };
            case 'max':
                return {
                    tokenMultiplier: 1.45,
                    roundMultiplier: 1.35,
                    stallMultiplier: 1.25,
                    temperature: 0.35,
                    topP: 0.9,
                    thinking: 'enabled',
                    directMaxTokens: 3800,
                };
            default:
                return {
                    tokenMultiplier: 0.85,
                    roundMultiplier: 0.75,
                    stallMultiplier: 0.85,
                    directMaxTokens: 1600,
                };
        }
    }
    private buildChatParams(model: string, messages: ChatMessage[] | Array<{
        role: 'system' | 'user' | 'assistant' | 'tool';
        content: any;
    }>, options: Record<string, any> = {}, endpointId = ''): Record<string, any> {
        const reasoningProfile = this.getReasoningProfile();
        const applyReasoningMultiplier = options._applyReasoningMultiplier !== false;
        const requestedMaxTokens = Number(options.max_tokens ?? this.config.maxTokens);
        const configuredMaxTokens = applyReasoningMultiplier
            ? Math.round(requestedMaxTokens * reasoningProfile.tokenMultiplier)
            : requestedMaxTokens;
        const maxOutputTokens = Math.max(1, Math.min(Number.isFinite(configuredMaxTokens) ? configuredMaxTokens : 8192, 65536));
        const temperature = options.temperature ?? reasoningProfile.temperature ?? this.config.temperature;
        const topP = options.top_p ?? reasoningProfile.topP ?? this.config.topP;
        const params: Record<string, any> = {
            model,
            messages,
            max_tokens: maxOutputTokens,
            temperature,
            top_p: topP,
            stream_options: options.stream_options ?? { include_usage: true },
            ...options,
        };
        params.max_tokens = maxOutputTokens;
        if (params.stream_options === null)
            delete params.stream_options;
        if (this.shouldSendThinkingControl(model, endpointId) && reasoningProfile.thinking && !params.extra_body?.thinking) {
            params.extra_body = {
                ...(params.extra_body || {}),
                thinking: { type: reasoningProfile.thinking },
            };
        }
        delete params._applyReasoningMultiplier;
        return params;
    }
    private findVisionModel(currentModel: string, endpointId = ''): string | null {
        const configuredModels = this.getModelsForEndpoint(endpointId);
        const currentIsMimo = this.isMimoModel(currentModel);
        const candidates = [
            currentModel,
            ...configuredModels.filter(model => this.isMimoModel(model) === currentIsMimo),
            ...(currentIsMimo ? DEFAULT_MODELS.filter(model => this.isMimoModel(model)) : []),
        ];
        const seen = new Set<string>();
        for (const model of candidates) {
            const key = normalizeModelName(model);
            if (!key || seen.has(key))
                continue;
            seen.add(key);
            if (this.getModelCapabilities(model).vision)
                return model;
        }
        return null;
    }
    private async analyzeImagesForTextContext(images: Array<{
        dataUrl: string;
        name: string;
        size: number;
    }>, conv: ConversationState, endpointId: string, signal?: AbortSignal): Promise<string> {
        const visionModel = this.findVisionModel(conv.model, endpointId);
        if (!visionModel) {
            throw new Error(`Current model "${conv.model}" is not known to support images, and no vision-capable MiMo fallback model is available for image analysis.`);
        }
        const api = this.getApiForEndpoint(endpointId);
        const summaries: string[] = [];
        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            const label = image.name || `image-${i + 1}`;
            const params = this.buildChatParams(visionModel, [
                {
                    role: 'system',
                    content: 'You convert images into compact text context for a stronger text reasoning model. Do not answer the user task; describe the image faithfully.',
                },
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: image.dataUrl } },
                        { type: 'text', text: `Analyze this image for a downstream text reasoning model. Return concise factual notes only. Include visible text, UI state, errors, code snippets, diagrams, tables, and relevant details.\nImage name: ${label}` },
                    ],
                },
            ], {
                max_tokens: 2048,
                temperature: 0.1,
                stream_options: null,
                _applyReasoningMultiplier: false,
            }, endpointId);
            const text = (await api.chatCompletion(params, signal)).trim();
            summaries.push(`Image ${i + 1}${label ? ` (${label})` : ''}:\n${text || '(no description returned)'}`);
        }
        return summaries.join('\n\n');
    }
    private buildTextOnlyContentFromImages(userInput: string, imageContext: string): string {
        const input = String(userInput || '').trim();
        const context = String(imageContext || '').trim();
        return [
            input,
            context ? `[Image analysis generated by mimo-v2.5 for the selected text model]\n${context}` : '',
        ].filter(Boolean).join('\n\n');
    }
    private isMimoModel(model: string): boolean {
        return /^mimo[-_]/i.test((model || '').trim());
    }
    private isKnownUnsupportedChatModel(model: string): boolean {
        return /^mimo-v2-(?:flash|lite)$/i.test((model || '').trim());
    }
    /** Check if any message in the history contains image_url content parts */
    private messagesContainImages(messages: ChatMessage[]): boolean {
        for (const msg of messages) {
            if (msg.role !== 'user') continue;
            if (!Array.isArray(msg.content)) continue;
            for (const part of msg.content) {
                if (typeof part === 'object' && (part as any).type === 'image_url') {
                    return true;
                }
            }
        }
        return false;
    }
    private findChatModel(currentModel: string, excludeCurrent = false, endpointId = ''): string | null {
        const configuredModels = this.getModelsForEndpoint(endpointId);
        const currentIsMimo = this.isMimoModel(currentModel);
        const candidates = currentIsMimo
            ? [
                ...configuredModels.filter(model => this.isMimoModel(model)),
                ...PREFERRED_CHAT_MODELS.filter(model => this.isMimoModel(model)),
                ...DEFAULT_MODELS.filter(model => this.isMimoModel(model)),
            ]
            : [
                currentModel,
                ...configuredModels.filter(model => !this.isMimoModel(model)),
            ];
        const seen = new Set<string>();
        for (const model of candidates) {
            const key = normalizeModelName(model);
            if (!key || seen.has(key))
                continue;
            seen.add(key);
            if (excludeCurrent && key === normalizeModelName(currentModel))
                continue;
            if (this.isKnownUnsupportedChatModel(model))
                continue;
            const caps = this.getModelCapabilities(model);
            if (!caps.tts)
                return model;
        }
        return null;
    }
    private findFallbackRouteForChat(currentModel: string, currentEndpointId = ''): {
        endpointId: string;
        model: string;
    } | null {
        const endpointCandidates = [
            currentEndpointId,
            this.config.activeRoute?.endpoint_id || '',
            this.config.activeProviderProfile || '',
            ...(this.config.providerProfiles || []).map(profile => profile.id || ''),
        ];
        const seen = new Set<string>();
        for (const endpointId of endpointCandidates) {
            const key = String(endpointId || '').trim();
            if (seen.has(key))
                continue;
            seen.add(key);
            const model = this.findChatModel(currentModel, true, endpointId);
            if (model)
                return { endpointId, model };
        }
        return null;
    }
    private compactReasoningForContext(text: string, wasTrimmed: boolean): string {
        const clean = (text || '').replace(/\s+/g, ' ').trim();
        if (!clean)
            return wasTrimmed ? '[reasoning trimmed]' : '';
        if (clean.length <= 1200)
            return wasTrimmed ? `[reasoning trimmed]\n${clean}` : clean;
        const head = clean.slice(0, 360);
        const tail = clean.slice(-720);
        return `[reasoning compacted for context]\n${head}\n...\n${tail}`;
    }
    private isUnlimitedRoundLimit(value?: number): boolean {
        return typeof value === 'number'
            && (!Number.isFinite(value) || value >= Number.MAX_SAFE_INTEGER / 2);
    }
    private isModelUnsupportedError(error: any): boolean {
        const message = String(error?.message || error || '');
        return /\b400\b/i.test(message)
            && /not supported model|model .*not supported|not exist|not have access|may not|model_not_found|unsupported model/i.test(message);
    }
    private appendMemoryPrompt(systemContent: string, userInput: string): string {
        const memory = this.memoryManager.formatForPrompt(userInput);
        return memory ? `${systemContent}\n\n${memory}` : systemContent;
    }
    private learnFromCompletedTurn(userInput: string, response: string, events: AgentEvents, toolObservations: ToolObservation[] = []): void {
        try {
            const added = this.memoryManager.learnFromTurn(userInput, response, toolObservations);
            if (added > 0) {
                events.onReasoning(`[Memory] Learned ${added} item${added === 1 ? '' : 's'} for future turns.`);
            }
        }
        catch (e: any) {
            events.onReasoning(`[Memory] Learning skipped: ${String(e?.message || e).slice(0, 120)}`);
        }
    }
    private isSubstantialFinalReport(text: string): boolean {
        const clean = (text || '').trim();
        if (clean.length < 1800)
            return false;
        const headingCount = (clean.match(/^#{1,3}\s+\S+/gm) || []).length;
        const bulletCount = (clean.match(/^\s*(?:[-*]|\d+\.)\s+\S+/gm) || []).length;
        const reportMarkers = /(summary|report|audit|review|findings|conclusion|validation|next steps|final notes|follow-up|fix|fixed|implementation|implemented|总结|报告|审查|评审|结论|验证|后续|修复|实现|交付|结果)/i.test(clean);
        const finalMarkers = /(done|completed|fixed|implemented|saved|resolved|shipped|finished|已完成|任务完成|完成总结|交付完成|处理完成)/i.test(clean);
        const looksStructured = headingCount >= 2 || bulletCount >= 6;
        return reportMarkers && looksStructured && (finalMarkers || clean.length >= 3000);
    }
    private isDeliverySummary(text: string): boolean {
        const clean = (text || '').trim();
        if (clean.length < 60)
            return false;
        const hasDone = /(done|completed|final summary|task completed|finished|任务完成|已完成|完成总结|交付完成|处理完成)/i.test(clean);
        const hasFile = /(\.(?:md|txt|json|html?|css|scss|less|tsx?|jsx?|js|py|java|go|rs)\b|artifacts?:|files? written|saved|generated|written|交付文件|文件[:：]|已保存|已生成|输出文件)/i.test(clean);
        const hasStats = /(stats?|DOI|tokens?|lines?|words?|validated|verification|验证|测试|校验|检查|已检查|行数|字数|耗时|轮次)/i.test(clean);
        const hasRiskOrNext = /(next|risk|warning|recommend|follow-up|下一步|风险|注意事项|建议|后续)/i.test(clean);
        return hasDone && hasFile && (hasStats || hasRiskOrNext);
    }
    private inferSavedResponseKind(response: string, titleSource = ''): string {
        const text = `${titleSource}\n${response}`;
        if (/(方案|规划|路线|步骤|技术实现|开发计划|plan|planning|roadmap|proposal)/i.test(text))
            return 'mimo-plan';
        if (/(review|audit|findings|审查|评审|审计|风险)/i.test(text))
            return 'mimo-review';
        if (/(report|analysis|分析|报告)/i.test(text))
            return 'mimo-report';
        return 'mimo-summary';
    }
    private extractSavedResponseTitle(source: string): string {
        const raw = String(source || '');
        const lines = raw
            .split(/\r?\n/)
            .map(line => line
            .replace(/^#{1,6}\s+/, '')
            .replace(/^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s*/, '')
            .replace(/`+/g, '')
            .replace(/&#\d+;/g, '')
            .trim())
            .filter(line => line.length >= 4
            && !line.startsWith('```')
            && !/^\|/.test(line)
            && !/^(copy saved|saved copy|已另存为|另存为)[:：]/i.test(line)
            && !/^(好的|好，|老板|当然|下面|以下|我已经|我已|先说结论|总结一下)/i.test(line));
        const first = lines[0] || '';
        return first
            .split(/[。！？!?；;\n]/)[0]
            .replace(/^(?:请|麻烦|帮我|给我|我想|我需要|能不能|可以|请你|麻烦你|老板[，,]?)\s*/i, '')
            .replace(/(?:请只做|只做|不要修改任何文件|不要写代码|分析完成后等待我确认下一步|告诉我|请告诉我)[:：，,。]*/gi, '')
            .trim();
    }
    private normalizeSavedFilenamePart(value: string): string {
        return String(value || '')
            .replace(/[<>:"\\|?*\x00-\x1f]/g, '')
            .replace(/[\/]+/g, '-')
            .replace(/[，,、。！？!；;：:\[\]【】（）(){}]+/g, ' ')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 48)
            .replace(/^-+|-+$/g, '');
    }
    private buildSummaryFilename(response: string, titleSource = ''): string {
        const kind = this.inferSavedResponseKind(response, titleSource);
        const title = this.normalizeSavedFilenamePart(this.extractSavedResponseTitle(titleSource) || this.extractSavedResponseTitle(response));
        const base = title ? `${kind}-${title}` : kind;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `${base}-${stamp}.md`;
    }
    private pickRelatedOutputDirectory(titleSource = ''): string {
        const text = String(titleSource || '');
        const matches = Array.from(text.matchAll(/([A-Za-z]:\\[^\r\n"'`]+?\.(?:pdf|md|txt|docx?|pptx?|xlsx?|png|jpe?g)|\/[^\r\n"'`]+?\.(?:pdf|md|txt|docx?|pptx?|xlsx?|png|jpe?g))/gi));
        for (const match of matches) {
            const raw = String(match[1] || '').trim();
            if (!raw) continue;
            const normalized = raw.replace(/[)"'`]+$/g, '');
            const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(this.config.workspace, normalized);
            try {
                if (fs.existsSync(resolved)) {
                    const stat = fs.statSync(resolved);
                    if (stat.isFile()) return path.dirname(resolved);
                    if (stat.isDirectory()) return resolved;
                }
            } catch {
                // Fall through to workspace default.
            }
        }
        return this.config.workspace;
    }
    private maybeSaveLongFinalResponse(response: string, events: AgentEvents, titleSource = ''): string {
        const clean = (response || '').trim();
        if (clean.length < 3000 && !this.isSubstantialFinalReport(clean))
            return response;
        if (/Saved copy:\s+.+\.md|Copy saved:\s+.+\.md|已另存为[:：]\s+.+\.md/i.test(clean))
            return response;
        try {
            const filename = this.buildSummaryFilename(clean, titleSource);
            const outputDir = this.pickRelatedOutputDirectory(titleSource);
            const target = path.join(outputDir, filename);
            fs.writeFileSync(target, clean.endsWith('\n') ? clean : `${clean}\n`, 'utf-8');
            events.onReasoning(`[Summary] Long final response saved to ${filename}.`);
            const savedLabel = /[\u4e00-\u9fff]/.test(clean) ? '已另存为' : 'Copy saved';
            const pathLabel = /[\u4e00-\u9fff]/.test(clean) ? '保存路径' : 'Saved path';
            return `${clean}\n\n${savedLabel}: ${filename}\n${pathLabel}: ${target}`;
        }
        catch (e: any) {
            events.onReasoning(`[Summary] Failed to save long final response: ${String(e?.message || e).slice(0, 160)}`);
            return response;
        }
    }
    private collectStringValues(value: any): string[] {
        if (value === null || value === undefined)
            return [];
        if (typeof value === 'string')
            return [value];
        if (Array.isArray(value))
            return value.flatMap(item => this.collectStringValues(item));
        if (typeof value === 'object') {
            return Object.values(value).flatMap(item => this.collectStringValues(item));
        }
        return [];
    }
    private cleanArtifactPath(candidate: string): string {
        return String(candidate || '')
            .trim()
            .replace(/^[`"'\u201c\u201d\u2018\u2019]+|[`"'\u201c\u201d\u2018\u2019]+$/g, '')
            .replace(/[.,;:?\]}]+$/g, '')
            .trim();
    }
    private looksLikeRealArtifactPath(filePath: string): boolean {
        const normalized = String(filePath || '').trim().replace(/\\/g, '/');
        if (!normalized)
            return false;
        if (/[^\S\r\n]{2,}/.test(normalized))
            return false;
        if (/[{};]/.test(normalized))
            return false;
        if (/=>|==|!=|<=|>=/.test(normalized))
            return false;
        if (/\b(?:const|let|var|function|return|if|for|while|class|ctx)\b/i.test(normalized))
            return false;
        const segments = normalized.split('/').filter(Boolean);
        if (segments.length === 0)
            return false;
        return segments.every((segment, index) => {
            if (index === 0 && /^[A-Za-z]:$/.test(segment))
                return true;
            return /^[\p{L}\p{N}._\-+()\[\] :]+$/u.test(segment);
        });
    }
    private isDeliverablePath(filePath: string): boolean {
        const normalized = String(filePath || '').trim().replace(/\\/g, '/');
        if (!normalized)
            return false;
        const ext = path.extname(normalized).replace(/^\./, '').toLowerCase();
        if (!ext)
            return false;
        const sourceCodeExtensions = new Set([
            'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'jsx', 'ts', 'tsx', 'json', 'md', 'txt', 'xml', 'yml', 'yaml', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'rs', 'go', 'php', 'rb', 'sh', 'ps1', 'bat'
        ]);
        return !sourceCodeExtensions.has(ext) && this.looksLikeRealArtifactPath(normalized);
    }
    private extractArtifactPathsFromText(text: string): string[] {
        const raw = String(text || '');
        if (!raw)
            return [];
        const ext = MiMoAgent.ARTIFACT_EXTENSIONS.join('|');
        const evidencePatterns = [
            new RegExp(String.raw `(?:artifacts?|generated file|updated file|saved(?: to)?|written to|exported(?: to)?|(?:^|[\s(])output file|(?:^|[\s(])outputs?)\s*[:?-]?\s*['"]?([^'"\r\n]+\.(?:${ext}))`, 'giu'),
            new RegExp(String.raw `(?:^|\n)\s*[-*]\s+([^\r\n]+\.(?:${ext}))\s*$`, 'gimu'),
        ];
        const found: string[] = [];
        for (const pattern of evidencePatterns) {
            for (const match of raw.matchAll(pattern)) {
                const value = this.cleanArtifactPath(match[1] || '');
                if (value && this.isDeliverablePath(value))
                    found.push(value);
            }
        }
        return found;
    }
    private collectRecentArtifactPaths(conv: ConversationState, lookback = 80): string[] {
        const seen = new Set<string>();
        const artifacts: string[] = [];
        const add = (candidate: string) => {
            const clean = this.cleanArtifactPath(candidate);
            if (!clean || !this.isDeliverablePath(clean))
                return;
            const key = clean.replace(/\\/g, '/').toLowerCase();
            if (seen.has(key))
                return;
            seen.add(key);
            artifacts.push(clean);
        };
        const recentMessages = conv.messages.slice(-lookback);
        let startIndex = 0;
        for (let i = recentMessages.length - 1; i >= 0; i--) {
            if (recentMessages[i].role === 'user') {
                startIndex = i;
                break;
            }
        }
        for (const msg of recentMessages.slice(startIndex)) {
            if (msg.role === 'assistant' && msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    const args = this.parseToolArgs(tc);
                    for (const value of this.collectStringValues(args)) {
                        for (const artifact of this.extractArtifactPathsFromText(value))
                            add(artifact);
                    }
                }
                continue;
            }
            if (msg.role === 'tool') {
                for (const artifact of this.extractArtifactPathsFromText(this.extractMessageText(msg.content))) {
                    add(artifact);
                }
            }
        }
        return artifacts.slice(-8);
    }
    private appendMissingArtifactSummary(conv: ConversationState, finalText: string): string {
        const cleanFinal = String(finalText || '');
        const artifacts = this.collectRecentArtifactPaths(conv)
            .filter(filePath => !cleanFinal.includes(filePath));
        if (artifacts.length === 0)
            return finalText;
        const useChinese = conv.uiLang !== 'en' || /[\u4e00-\u9fff]/.test(cleanFinal);
        const heading = useChinese ? '交付文件：' : 'Artifacts:';
        const lines = artifacts.map(filePath => `- \`${filePath}\``);
        return `${cleanFinal.trim()}\n\n${heading}\n${lines.join('\n')}`;
    }
    constructor(private config: MiMoConfig, private extensionPath: string, private context?: vscode.ExtensionContext, private windowSessionId?: string) {
        super();
        this.api = new MiMoAPI(config.apiKey, config.baseUrl, config.apiEndpoint);
        this.systemPrompt = buildSystemPrompt(config.workspace);
        this.skills = loadSkills(extensionPath);
        this.mcpManager = new McpManager();
        this.hookManager = new HookManager(config.settings || {});
        this.tokenTracker = new TokenTracker(config.workspace, windowSessionId);
        this.memoryManager = new MemoryManager(config.workspace, config.memory, windowSessionId);
        if (this.context) {
            this.loadConversations();
        }
        // Connect to MCP servers asynchronously
        this.initMcp();
    }
    /** Public cleanup method for extension deactivation */
    dispose(): void {
        this.flushConversationState();
        this.tokenTracker.flush();
        this.mcpManager.disconnectAll();
    }
    /** Hot-reload config after settings change (no restart needed) */
    updateConfig(newConfig: MiMoConfig): void {
        this.config = newConfig;
        this.api = new MiMoAPI(newConfig.apiKey, newConfig.baseUrl, newConfig.apiEndpoint);
        this.endpointApis.clear();
        this.systemPrompt = buildSystemPrompt(newConfig.workspace);
        this.hookManager = new HookManager(newConfig.settings || {});
        this.memoryManager.updateConfig(newConfig.workspace, newConfig.memory, this.windowSessionId);
        this.mcpManager.disconnectAll();
        this.initMcp();
    }
    setReasoningEffort(effort: MiMoConfig['reasoningEffort']): void {
        this.config.reasoningEffort = effort;
        this.config.enableThinking = effort === 'deep' || effort === 'max';
    }
    private async initMcp(): Promise<void> {
        const mcpServers = this.buildMcpServers();
        if (mcpServers.length === 0)
            return;
        try {
            const tools = await this.mcpManager.connectAll(mcpServers);
            if (tools.length > 0) {
                console.log(`[MiMo] MCP: ${tools.length} tools loaded from ${mcpServers.length} server(s)`);
            }
        }
        catch (e: any) {
            console.error(`[MiMo] MCP init error: ${e.message}`);
        }
    }
    private buildMcpServers(): McpServerConfig[] {
        const servers = [...(this.config.mcpServers || [])];
        const disabled = this.config.settings?.mcp?.builtin_multimodal === false
            || process.env.MIMO_DISABLE_BUILTIN_MULTIMODAL_MCP === '1';
        const hasBuiltin = servers.some(server => server.name === 'mimo_multimodal');
        if (!disabled && !hasBuiltin) {
            servers.push({
                name: 'mimo_multimodal',
                command: process.execPath,
                args: [path.join(this.extensionPath, 'out', 'mcpMultimodalServer.js')],
                env: {
                    MIMO_API_KEY: this.config.apiKey,
                    MIMO_BASE_URL: this.config.baseUrl,
                    MIMO_WORKSPACE: this.config.workspace,
                },
                timeoutMs: 180000,
            });
        }
        return servers;
    }
    // ── Persistence ──
    private stateKey(name: string): string {
        return this.windowSessionId ? `mimo.${name}.${this.windowSessionId}` : `mimo.${name}`;
    }
    private loadConversations(): void {
        if (!this.context)
            return;
        const saved = this.context.globalState.get<Record<string, ConversationState>>(this.stateKey('conversations'));
        if (saved) {
            for (const [id, conv] of Object.entries(saved)) {
                this.conversations.set(id, conv);
            }
            const lastActive = this.context.globalState.get<string>(this.stateKey('activeConversationId'));
            if (lastActive && this.conversations.has(lastActive)) {
                this.activeId = lastActive;
            }
        }
    }
    private trimPersistedText(text: string, maxChars: number): string {
        if (!text || text.length <= maxChars)
            return text || '';
        const head = text.slice(0, Math.floor(maxChars * 0.55));
        const tail = text.slice(-Math.floor(maxChars * 0.35));
        return `${head}\n\n... (${text.length - head.length - tail.length} chars omitted from VS Code state; full transcript is in MiMo history) ...\n\n${tail}`;
    }
    private trimPersistedContent(content: ChatMessage['content'] | null | undefined, maxChars: number): ChatMessage['content'] {
        if (typeof content === 'string') {
            return this.trimPersistedText(content, maxChars);
        }
        if (Array.isArray(content)) {
            return content.map((part) => {
                if (part.type === 'text') {
                    return { ...part, text: this.trimPersistedText(part.text || '', maxChars) };
                }
                const url = part.image_url?.url || '';
                if (url.length > 750000) {
                    return {
                        type: 'image_url' as const,
                        image_url: { url: '[large image omitted from VS Code state; full image is kept in MiMo history]' },
                    };
                }
                return part;
            });
        }
        return '';
    }
    private sanitizeConversationToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
        return sanitizeToolCallsForConversation(toolCalls);
    }
    private sanitizeConversationMessage(message: ChatMessage): ChatMessage {
        return sanitizeMessageToolCallsForConversation(message);
    }
    private buildPersistedConversationSnapshot(): Record<string, ConversationState> {
        const MAX_CONVERSATIONS = 30;
        const MAX_MESSAGES_PER_CONVERSATION = 48;
        const entries = Array.from(this.conversations.entries())
            .sort(([a], [b]) => b.localeCompare(a));
        const selected = entries.slice(0, MAX_CONVERSATIONS);
        if (this.activeId && !selected.some(([id]) => id === this.activeId)) {
            const active = this.conversations.get(this.activeId);
            if (active)
                selected.push([this.activeId, active]);
        }
        const snapshot: Record<string, ConversationState> = {};
        for (const [id, conv] of selected) {
            const firstUser = conv.messages.find(m => m.role === 'user');
            const recent = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
            const messages = firstUser && !recent.includes(firstUser)
                ? [firstUser, ...recent]
                : recent;
            snapshot[id] = {
                ...conv,
                messages: messages.map((msg) => {
                    const safeMsg = this.sanitizeConversationMessage(msg) as any;
                    const { _uiSnapshot, _uiImages, ...persistableMsg } = safeMsg;
                    const maxContent = msg.role === 'tool' ? 1600 : msg.role === 'assistant' ? 5000 : 7000;
                    const reasoningMax = safeMsg.role === 'assistant' && safeMsg.tool_calls?.length ? 100_000 : 1200;
                    return {
                        ...persistableMsg,
                        content: this.trimPersistedContent(persistableMsg.content as any, maxContent),
                        reasoning_content: safeMsg.reasoning_content
                            ? this.trimPersistedText(safeMsg.reasoning_content, reasoningMax)
                            : safeMsg.reasoning_content,
                    };
                }),
                contextSummary: conv.contextSummary
                    ? this.trimPersistedText(conv.contextSummary, 6000)
                    : conv.contextSummary,
            };
        }
        return snapshot;
    }
    private flushConversationState(): void {
        if (!this.context)
            return;
        if (this.conversationSaveTimer) {
            clearTimeout(this.conversationSaveTimer);
            this.conversationSaveTimer = undefined;
        }
        const data = this.buildPersistedConversationSnapshot();
        const serialized = JSON.stringify({ activeId: this.activeId, data });
        if (serialized === this.lastPersistedConversationSnapshot)
            return;
        this.lastPersistedConversationSnapshot = serialized;
        this.context.globalState.update(this.stateKey('conversations'), data);
        this.context.globalState.update(this.stateKey('activeConversationId'), this.activeId);
    }
    private saveConversations(): void {
        if (!this.context || this.conversationSaveTimer)
            return;
        this.conversationSaveTimer = setTimeout(() => {
            this.flushConversationState();
        }, 1000);
    }
    hasApiKey(): boolean {
        return !!this.config.apiKey;
    }
    private getModelsForEndpoint(endpointId = ''): string[] {
        const profile = this.getProfile(endpointId);
        const configured = profile
            ? [profile.model, ...(profile.models || [])]
            : this.config.models.length > 0
                ? [this.config.model, ...this.config.models]
                : [this.config.model, ...DEFAULT_MODELS];
        const seen = new Set<string>();
        const models: string[] = [];
        for (const model of configured) {
            const key = normalizeModelName(model);
            if (!key || seen.has(key))
                continue;
            seen.add(key);
            models.push(model);
        }
        return models;
    }
    getModelList(): string[] {
        return this.getModelsForEndpoint(this.config.activeRoute?.endpoint_id || this.config.activeProviderProfile || '');
    }
    getModelOptions(): Array<{
        value: string;
        label: string;
        model: string;
        endpointId: string;
        endpointName: string;
    }> {
        const profiles = this.config.providerProfiles || [];
        const options: Array<{
            value: string;
            label: string;
            model: string;
            endpointId: string;
            endpointName: string;
        }> = [];
        const add = (endpointId: string, endpointName: string, model: string) => {
            if (!model)
                return;
            const value = this.encodeModelRoute(endpointId, model);
            if (options.some(option => option.value === value))
                return;
            options.push({ value, label: endpointId ? `${endpointName || endpointId} / ${model}` : model, model, endpointId, endpointName });
        };
        for (const profile of profiles) {
            if (profile.show_in_picker === false)
                continue;
            const models = profile.model
                ? [profile.model]
                : this.getModelsForEndpoint(profile.id);
            for (const model of models)
                add(profile.id, profile.name || profile.id, model);
        }
        if (options.length === 0) {
            const endpointId = this.config.activeRoute?.endpoint_id || this.config.activeProviderProfile || '';
            const endpointName = this.getProfile(endpointId)?.name || endpointId;
            for (const model of this.getModelsForEndpoint(endpointId))
                add(endpointId, endpointName, model);
        }
        const activeValue = this.encodeModelRoute(this.config.activeRoute?.endpoint_id || '', this.config.model);
        if (this.config.model && !options.some(option => option.value === activeValue)) {
            add(this.config.activeRoute?.endpoint_id || '', this.getProfile(this.config.activeRoute?.endpoint_id)?.name || '', this.config.model);
        }
        return options;
    }
    getModelSelectionValue(id: string): string {
        const conv = this.conversations.get(id);
        return this.encodeModelRoute(this.getConversationEndpointId(conv), conv?.model || this.config.model);
    }
    private getDefaultConversationModelRoute(): {
        model: string;
        endpointId: string;
    } {
        const firstOption = this.getModelOptions()[0];
        if (firstOption?.model) {
            return {
                model: firstOption.model,
                endpointId: firstOption.endpointId || this.config.activeRoute?.endpoint_id || this.config.activeProviderProfile || '',
            };
        }
        return {
            model: this.config.model,
            endpointId: this.config.activeRoute?.endpoint_id || this.config.activeProviderProfile || '',
        };
    }
    // ── Conversation management ──
    createConversation(): string {
        // Unique ID: timestamp + random suffix (no collision even in same ms)
        const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const defaultRoute = this.getDefaultConversationModelRoute();
        this.conversations.set(id, {
            id,
            title: '新对话',
            messages: [],
            model: defaultRoute.model,
            modelEndpointId: defaultRoute.endpointId,
            mode: 'auto',
        });
        // DO NOT set this.activeId — panels manage their own active conversation
        this.saveConversations();
        return id;
    }
    switchConversation(id: string): boolean {
        // Just verify the conversation exists — panels manage their own active conversation
        return this.conversations.has(id);
    }
    getActiveId(): string {
        return this.activeId;
    }
    getActive(): ConversationState | undefined {
        return this.conversations.get(this.activeId);
    }
    getConversation(id: string): ConversationState | undefined {
        return this.conversations.get(id);
    }
    getAllConversations(): ConversationState[] {
        return Array.from(this.conversations.values());
    }
    loadConversation(id: string, title: string, messages: ChatMessage[], model: string, options: Partial<Pick<ConversationState, 'mode' | 'personaId' | 'activeSkillPrompt' | 'modelEndpointId'>> = {}): void {
        this.conversations.set(id, {
            id,
            title,
            messages: [...messages],
            model,
            modelEndpointId: options.modelEndpointId,
            mode: options.mode || 'auto',
            personaId: options.personaId,
            activeSkillPrompt: options.activeSkillPrompt,
        });
        // DO NOT set this.activeId — panels manage their own active conversation
        this.saveConversations();
    }
    removeConversation(id: string): void {
        this.conversations.delete(id);
        // Panels manage their own active conversation — no global activeId update needed
        this.saveConversations();
    }
    setTitle(id: string, title: string): void {
        const conv = this.conversations.get(id);
        if (conv) {
            conv.title = title;
            this.saveConversations();
        }
    }
    // ── Per-conversation getters ──
    getMessages(id: string): ChatMessage[] {
        const conv = this.conversations.get(id);
        return conv ? [...conv.messages] : [];
    }
    getModel(id: string): string {
        const conv = this.conversations.get(id);
        return conv?.model || this.config.model;
    }
    getMode(id: string): AgentMode {
        const conv = this.conversations.get(id);
        return conv?.mode || 'auto';
    }
    setUiLang(lang: 'en' | 'zh', id?: string): void {
        const convId = id || this.activeId;
        const conv = this.conversations.get(convId);
        if (!conv)
            return;
        conv.uiLang = lang;
        this.saveConversations();
    }
    // ── Per-conversation setters ──
    setModel(model: string, convId?: string): void {
        const conv = this.conversations.get(convId || this.activeId);
        if (conv) {
            const route = this.decodeModelRoute(model);
            conv.model = route.model || model;
            conv.modelEndpointId = route.endpointId || conv.modelEndpointId || this.config.activeRoute?.endpoint_id || '';
            this.saveConversations();
        }
    }
    setMode(mode: AgentMode, convId?: string): void {
        const conv = this.conversations.get(convId || this.activeId);
        if (conv) {
            conv.mode = mode;
            this.saveConversations();
        }
    }
    reset(convId?: string): void {
        const conv = this.conversations.get(convId || this.activeId);
        if (conv) {
            conv.messages = [];
            conv.contextSummary = undefined;
            conv.contextSummaryMessageCount = undefined;
            conv.contextSummaryUpdatedAt = undefined;
            this.saveConversations();
        }
    }
    // ── Skills ──
    getSkills(): Skill[] {
        return Array.from(this.skills.values());
    }
    /** Reload skills from both builtin and user directories */
    reloadSkills(): void {
        this.skills = loadSkills(this.extensionPath);
    }
    /** Save or update a user skill */
    saveSkill(skill: {
        name: string;
        description: string;
        tools?: string[];
        prompt: string;
    }): boolean {
        const ok = saveUserSkill(skill);
        if (ok)
            this.reloadSkills();
        return ok;
    }
    /** Delete a user skill */
    deleteSkill(name: string): boolean {
        const ok = deleteUserSkill(name);
        if (ok)
            this.reloadSkills();
        return ok;
    }
    // ── Edit Preview ──
    /** Confirm or reject a pending edit preview */
    confirmEdit(previewId: string, approved: boolean): void {
        const pending = this.pendingEdits.get(previewId);
        if (!pending)
            return;
        this.pendingEdits.delete(previewId);
        if (approved) {
            // Execute the actual edit
            const fs = require('fs');
            try {
                const content = fs.readFileSync(pending.path, 'utf-8');
                let newContent: string;
                if (typeof pending.lineStart === 'number' && typeof pending.lineEnd === 'number') {
                    const lines = content.split('\n');
                    const start = Math.max(1, Math.min(pending.lineStart, lines.length));
                    const end = Math.max(start, Math.min(pending.lineEnd, lines.length));
                    const before = lines.slice(0, start - 1);
                    const after = lines.slice(end);
                    newContent = [...before, ...pending.newText.split('\n'), ...after].join('\n');
                }
                else if (typeof pending.oldText === 'string') {
                    newContent = content.split(pending.oldText).join(pending.newText);
                }
                else {
                    pending.resolve('Edit failed: missing old_text or line range.');
                    return;
                }
                fs.writeFileSync(pending.path, newContent, 'utf-8');
                pending.resolve(`Replaced (approved by user)`);
            }
            catch (e: any) {
                pending.resolve(`Edit failed: ${e.message}`);
            }
        }
        else {
            pending.resolve('Edit rejected by user');
        }
    }
    /**

     * Confirm or reject the plan in Plan mode.

     * When confirmed, the next chat() call will enable tools for execution.

     */
    confirmPlan(approved: boolean, convId?: string): void {
        const conv = this.conversations.get(convId || this.activeId);
        if (!conv || conv.mode !== 'plan')
            return;
        conv.planConfirmed = approved;
        this.saveConversations();
    }
    /**

     * Handle a run_workflow tool call: execute multi-phase parallel/sequential workflow.

     */
    private async handleWorkflow(args: Record<string, any>, events: AgentEvents, signal?: AbortSignal, convId?: string): Promise<string> {
        const phases = args.phases as WorkflowPhase[];
        if (!phases || phases.length === 0)
            return 'Error: run_workflow requires at least one phase';
        const conv = this.conversations.get(convId || this.activeId);
        const model = conv?.model || this.config.model;
        const endpointId = this.getConversationEndpointId(conv);
        const api = this.getApiForEndpoint(endpointId);
        // Inject model into tasks that don't specify one
        for (const phase of phases) {
            for (const task of phase.tasks) {
                if (!task.model)
                    task.model = model;
            }
        }
        const workflowEvents: WorkflowEvents = {
            onWorkflowStart: (totalPhases, totalTasks) => {
                events.onWorkflowStart?.(totalPhases, totalTasks);
            },
            onWorkflowPhaseStart: (pi, title, mode, taskCount) => {
                events.onWorkflowPhaseStart?.(pi, title, mode, taskCount);
            },
            onWorkflowTaskStart: (pi, ti, label) => {
                events.onWorkflowTaskStart?.(pi, ti, label);
            },
            onWorkflowTaskEnd: (pi, ti, result) => {
                events.onWorkflowTaskEnd?.(pi, ti, result);
            },
            onWorkflowPhaseEnd: (pi, result) => {
                events.onWorkflowPhaseEnd?.(pi, result);
            },
            onWorkflowEnd: (result) => {
                events.onWorkflowEnd?.(result);
            },
            onStatus: (s) => events.onStatus(s),
            onReasoning: (t) => events.onReasoning(t),
        };
        const result = await executeWorkflow(phases, api, this.config.workspace, this.mcpManager, {
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
            topP: this.config.topP,
            maxOutputLen: this.config.maxOutputLen,
            commandTimeout: this.config.commandTimeout,
            sandbox: this.config.sandbox,
            enableThinking: this.config.enableThinking,
            dependencyInstall: this.config.dependencyInstall,
        }, workflowEvents, signal);
        // Format result as text for the tool response
        let output = `## Workflow Complete\n\n`;
        output += `**${result.phases.length} phases**, **${result.totalToolCalls} tool calls**, **${(result.elapsed / 1000).toFixed(1)}s**\n\n`;
        for (let pi = 0; pi < result.phases.length; pi++) {
            const phase = result.phases[pi];
            output += `### Phase ${pi + 1}: ${phase.title} (${phase.mode})\n`;
            for (const task of phase.results) {
                const status = task.error ? '❌' : '✅';
                output += `- ${status} **${task.label}** (${task.toolCalls} tools, ${(task.elapsed / 1000).toFixed(1)}s)\n`;
                if (task.output && task.output.length > 0) {
                    const preview = task.output.substring(0, 300);
                    output += `  > ${preview}${task.output.length > 300 ? '...' : ''}\n`;
                }
            }
            output += '\n';
        }
        return output;
    }
    /**

     * Handle edit_file with preview: send diff to webview, wait for user approval.

     */
    private handleEditPreview(args: Record<string, any>, events: AgentEvents, signal?: AbortSignal, convId?: string): Promise<string> {
        const fs = require('fs');
        const { isPathSafe, resolvePath } = require('./safety');
        if (signal?.aborted || (convId && this.isStopping(convId, signal)))
            return Promise.resolve('(stopped by user)');
        const fullPath = resolvePath(args.path, this.config.workspace);
        const { safe, reason } = isPathSafe(fullPath, this.config.workspace);
        if (!safe)
            return Promise.resolve(`Safety: ${reason}`);
        if (!fs.existsSync(fullPath))
            return Promise.resolve(`File not found: ${args.path}`);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        let oldText: string | undefined;
        let lineStart: number | undefined;
        let lineEnd: number | undefined;
        let count = 1;
        if (args.line_start !== undefined && args.line_end !== undefined) {
            lineStart = Math.max(1, Math.min(Number(args.line_start), lines.length));
            lineEnd = Math.max(lineStart, Math.min(Number(args.line_end), lines.length));
            oldText = lines.slice(lineStart - 1, lineEnd).join('\n');
        }
        else {
            if (typeof args.old_text !== 'string') {
                return Promise.resolve('Error: old_text is required unless line_start/line_end are provided.');
            }
            oldText = args.old_text;
            count = content.split(oldText).length - 1;
            if (count === 0)
                return Promise.resolve('old_text not found. Ensure exact match including whitespace.');
        }
        const previewId = `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Send preview to webview
        events.onEditPreview?.(previewId, args.path, oldText || '', args.new_text, count, lineStart, lineEnd);
        // Return a promise that resolves when user confirms or rejects
        return new Promise<string>((resolve) => {
            this.pendingEdits.set(previewId, {
                previewId,
                path: fullPath,
                oldText,
                newText: args.new_text,
                lineStart,
                lineEnd,
                convId,
                resolve,
            });
        });
    }
    /**

     * Handle write_file with preview: send content to webview, wait for user approval.

     */
    private handleWritePreview(args: Record<string, any>, events: AgentEvents, signal?: AbortSignal, convId?: string): Promise<string> {
        const fs = require('fs');
        const { isPathSafe, resolvePath } = require('./safety');
        if (signal?.aborted || (convId && this.isStopping(convId, signal)))
            return Promise.resolve('(stopped by user)');
        const fullPath = resolvePath(args.path, this.config.workspace);
        const { safe, reason } = isPathSafe(fullPath, this.config.workspace);
        if (!safe)
            return Promise.resolve(`Safety: ${reason}`);
        const isCreate = !fs.existsSync(fullPath);
        // Read old content for diff display
        let oldText = '';
        if (!isCreate) {
            try {
                oldText = fs.readFileSync(fullPath, 'utf-8');
            }
            catch { /* file read failed */ }
        }
        const previewId = `write_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Send preview to webview once, including oldText for overwrite diff rendering.
        events.onWritePreview?.(previewId, args.path, args.content, isCreate, oldText);
        // Return a promise that resolves when user confirms or rejects
        return new Promise<string>((resolve) => {
            this.pendingWrites.set(previewId, {
                previewId,
                path: fullPath,
                content: args.content,
                convId,
                resolve,
            });
        });
    }
    /** Handle ask_user tool: show question to user and wait for response */
    private handleAskUser(args: Record<string, any>, events: AgentEvents, convId?: string): Promise<string> {
        const previewId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const question = args.question || '';
        const options = (args.options as string[]) || [];
        events.onAskUser?.(previewId, question, options);
        return new Promise<string>((resolve) => {
            this.pendingAsks.set(previewId, { previewId, convId, resolve });
        });
    }
    private canPauseForUserDecision(conv: ConversationState): boolean {
        return conv.mode === 'polling' || (conv.mode === 'plan' && !conv.planConfirmed);
    }
    private getInfiniteSoftMaxRounds(): number {
        const configured = Math.floor(this.config.infinite?.maxRounds || 300);
        return Math.max(20, configured);
    }
    private getInfiniteHardMultiplier(): number {
        const configured = this.config.infinite?.hardMultiplier ?? 2;
        return Math.max(1, Math.min(10, configured));
    }
    private getInfiniteStallLimit(): number {
        const configured = Math.floor(this.config.infinite?.stallLimit || 5);
        return Math.max(2, Math.min(20, configured));
    }
    private shouldUseSummarization(messages: ChatMessage[], model: string, taskComplexity: 'simple' | 'moderate' | 'complex', systemPromptLength?: number): boolean {
        const stats = getContextStats(messages, model, systemPromptLength);
        if (this.isMimoModel(model)) {
            const totalTokens = estimateTotalTokens(messages);
            switch (taskComplexity) {
                case 'complex':
                    return stats.percent > 18 || totalTokens > 3_500;
                case 'simple':
                    return stats.percent > 32 || totalTokens > 8_000;
                default:
                    return stats.percent > 24 || totalTokens > 4_000;
            }
        }
        switch (taskComplexity) {
            case 'complex':
                return stats.percent > 42;
            case 'simple':
                return stats.percent > 72;
            default:
                return stats.percent > 58;
        }
    }
    private getContextKeepRecent(conv: ConversationState, taskComplexity: 'simple' | 'moderate' | 'complex'): number {
        const configured = this.config.context?.keepRecentMessages ?? 18;
        if (this.isMimoRoute(conv, conv.modelEndpointId)) {
            const mimoBase = Math.min(configured, 10);
            const mimoModeBoost = conv.mode === 'infinite' ? 4 : 0;
            const mimoComplexityBoost = taskComplexity === 'complex' ? 4 : taskComplexity === 'moderate' ? 1 : 0;
            return Math.max(6, Math.min(28, mimoBase + mimoModeBoost + mimoComplexityBoost));
        }
        const modeBoost = conv.mode === 'infinite' ? 8 : 0;
        const complexityBoost = taskComplexity === 'complex' ? 6 : taskComplexity === 'moderate' ? 2 : 0;
        return Math.max(8, Math.min(80, configured + modeBoost + complexityBoost));
    }
    private findSafeRecentStart(messages: ChatMessage[], keepRecent: number): number {
        if (messages.length <= keepRecent)
            return 0;
        let start = Math.max(0, messages.length - keepRecent);
        // Avoid starting with tool results; include their assistant tool-call parent.
        while (start > 0 && messages[start]?.role === 'tool') {
            start--;
        }
        // If the boundary lands in a run of tool results, walk back to the assistant.
        while (start > 0 && messages[start - 1]?.role === 'tool') {
            start--;
        }
        return start;
    }
    private buildModelSafeRuntimeMessages(messages: ChatMessage[], model: string): ChatMessage[] {
        return messages.map((message) => {
            const safeMessage = this.sanitizeConversationMessage(message);
            if (this.getModelCapabilities(model).vision || !Array.isArray(safeMessage.content)) {
                return safeMessage;
            }
            const textParts: string[] = [];
            let imageCount = 0;
            for (const part of safeMessage.content) {
                if (part?.type === 'text' && part.text) {
                    textParts.push(part.text);
                } else if (part?.type === 'image_url') {
                    imageCount++;
                }
            }
            if (imageCount === 0) {
                return safeMessage;
            }
            const imageNote = `[${imageCount} image${imageCount === 1 ? '' : 's'} were attached earlier. If image details were needed, they were converted to text in the corresponding user turn.]`;
            return {
                ...safeMessage,
                content: [...textParts, imageNote].filter(Boolean).join('\n\n'),
            };
        });
    }
    private compactAssistantTextForMimo(content: string, maxChars: number): string {
        const text = String(content || '').trim();
        if (!text || text.length <= maxChars)
            return text;
        const head = text.slice(0, Math.floor(maxChars * 0.55));
        const tail = text.slice(-Math.floor(maxChars * 0.25));
        return `${head}\n\n... [assistant output compacted for MiMo replay] ...\n\n${tail}`;
    }
    private buildMimoLeanRuntimeMessages(messages: ChatMessage[]): ChatMessage[] {
        const nonSystem = messages.filter(message => message.role !== 'system');
        const recentSlice = nonSystem.slice(-16);
        const toolMessages = recentSlice.filter(message => message.role === 'tool');
        const toolKeep = new Set(toolMessages.slice(-6));
        const assistantToolMessages = recentSlice.filter(message => message.role === 'assistant' && !!message.tool_calls?.length);
        const assistantToolKeep = new Set(assistantToolMessages.slice(-2));
        return messages
            .filter((message) => {
                if (message.role === 'system')
                    return true;
                if (!recentSlice.includes(message))
                    return false;
                if (message.role === 'tool')
                    return toolKeep.has(message);
                if (message.role === 'assistant' && message.tool_calls?.length)
                    return assistantToolKeep.has(message);
                return true;
            })
            .map((message, index, kept) => {
                const safeMessage = this.sanitizeConversationMessage(message);
                if (safeMessage.role === 'assistant') {
                    const next: ChatMessage = {
                        ...safeMessage,
                        content: typeof safeMessage.content === 'string'
                            ? this.compactAssistantTextForMimo(safeMessage.content, safeMessage.tool_calls?.length ? 900 : 1400)
                            : safeMessage.content,
                    };
                    if (next.tool_calls?.length) {
                        const isRecentAssistant = index >= kept.length - 4;
                        next.reasoning_content = isRecentAssistant
                            ? String(next.reasoning_content || '').slice(-800)
                            : '';
                    }
                    else if (next.reasoning_content) {
                        next.reasoning_content = '';
                    }
                    return next;
                }
                if (safeMessage.role === 'tool' && typeof safeMessage.content === 'string') {
                    return {
                        ...safeMessage,
                        content: this.trimPersistedText(safeMessage.content, 600),
                    };
                }
                if (safeMessage.role === 'user' && typeof safeMessage.content === 'string') {
                    return {
                        ...safeMessage,
                        content: this.trimPersistedText(safeMessage.content, 1800),
                    };
                }
                return safeMessage;
            });
    }
    private buildRuntimeContextMessages(conv: ConversationState): ChatMessage[] {
        const covered = Math.max(0, Math.min(conv.contextSummaryMessageCount || 0, conv.messages.length));
        const messages: ChatMessage[] = (!conv.contextSummary || covered <= 0)
            ? conv.messages
            : [
                {
                    role: 'system',
                    content: `[Auto Context Summary - ${covered} earlier messages compressed]
${conv.contextSummary}`,
                } as any,
                ...conv.messages.slice(covered),
            ];
        const modelSafe = this.buildModelSafeRuntimeMessages(messages, conv.model);
        return this.isMimoRoute(conv, conv.modelEndpointId)
            ? this.buildMimoLeanRuntimeMessages(modelSafe)
            : modelSafe;
    }
    private shouldRefreshContextMemory(conv: ConversationState, taskComplexity: 'simple' | 'moderate' | 'complex', systemContent: string, safeStart: number, force = false): {
        should: boolean;
        reason: string;
    } {
        if (force)
            return { should: true, reason: 'forced by context overflow' };
        if (!this.config.context?.autoCompress)
            return { should: false, reason: 'auto compression disabled' };
        if (safeStart < 8)
            return { should: false, reason: 'not enough old context to summarize' };
        const cfg = this.config.context;
        const rawStats = getContextStats(conv.messages, conv.model, systemContent.length);
        const runtimeStats = getContextStats(this.buildRuntimeContextMessages(conv), conv.model, systemContent.length);
        const percentTrigger = this.isMimoRoute(conv, conv.modelEndpointId)
            ? (conv.mode === 'infinite'
                ? Math.min(cfg.summarizeAtPercent, taskComplexity === 'complex' ? 18 : 24)
                : Math.min(cfg.summarizeAtPercent, taskComplexity === 'complex' ? 20 : 28))
            : (conv.mode === 'infinite'
                ? Math.min(cfg.summarizeAtPercent, taskComplexity === 'complex' ? 45 : 55)
                : cfg.summarizeAtPercent);
        const messageTrigger = this.isMimoRoute(conv, conv.modelEndpointId)
            ? Math.max(10, Math.floor(cfg.summarizeAtMessages * 0.35))
            : (conv.mode === 'infinite'
                ? Math.max(16, Math.floor(cfg.summarizeAtMessages * 0.7))
                : cfg.summarizeAtMessages);
        const covered = conv.contextSummaryMessageCount || 0;
        const newCompressibleMessages = safeStart - covered;
        const minRefreshBatch = this.isMimoRoute(conv, conv.modelEndpointId)
            ? Math.max(3, Math.floor(this.getContextKeepRecent(conv, taskComplexity) / 4))
            : Math.max(6, Math.floor(this.getContextKeepRecent(conv, taskComplexity) / 3));
        if (newCompressibleMessages <= 0) {
            return { should: false, reason: 'no new old context to summarize' };
        }
        if (runtimeStats.percent >= percentTrigger && newCompressibleMessages >= minRefreshBatch) {
            return { should: true, reason: `runtime context usage ${runtimeStats.percent}%` };
        }
        if (runtimeStats.percent >= percentTrigger && newCompressibleMessages >= minRefreshBatch) {
            return { should: true, reason: `上下文估算使用率 ${Math.max(rawStats.percent, runtimeStats.percent)}%` };
        }
        if (conv.mode === 'infinite' && conv.messages.length >= messageTrigger && newCompressibleMessages >= minRefreshBatch) {
            return { should: true, reason: `无限模式长任务（${conv.messages.length} 条消息）` };
        }
        if (rawStats.percent >= percentTrigger || runtimeStats.percent >= percentTrigger) {
            return {
                should: false,
                reason: `context high but waiting for a larger compression batch (${newCompressibleMessages}/${minRefreshBatch})`,
            };
        }
        return { should: false, reason: 'below compression threshold' };
    }
    private formatMessagesForSummary(messages: ChatMessage[]): string {
        return messages.map((msg, index) => {
            const text = this.extractMessageText(msg.content).replace(/\s+/g, ' ').trim();
            if (msg.role === 'assistant') {
                const toolNames = msg.tool_calls?.map(tc => tc.function.name).join(', ');
                const parts = [`[${index}] Assistant:`];
                if (text)
                    parts.push(text.slice(0, 1200));
                if (toolNames)
                    parts.push(`Tool calls: ${toolNames}`);
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
        if (text.length <= maxChars)
            return text;
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
    private async generateContextSummary(conv: ConversationState, segment: ChatMessage[], events: AgentEvents, signal?: AbortSignal): Promise<string> {
        const existingSummary = conv.contextSummary || '';
        const segmentText = this.trimForSummaryPrompt(this.formatMessagesForSummary(segment), 14000);
        const prompt = `You are compressing memory for a long-running coding agent. Merge the existing summary and the new conversation segment into one concise, actionable context summary.



Rules:

- Preserve the user's current goal and acceptance criteria.

- Preserve exact file paths, commands, errors, test results, settings, and important decisions.

- Preserve what has already been read, changed, verified, and what remains pending.

- Drop raw logs, repeated chatter, duplicate reasoning, and low-value detail.

- Write as compact operational memory for the next model call, not as a transcript.

- Keep it under ${this.config.context?.maxSummaryTokens ?? 1200} tokens.



Existing summary:

${existingSummary || '(none)'}



New segment to merge:

${segmentText}



Updated summary:`;
        try {
            const summary = await this.api.chatCompletion({
                model: conv.model,
                messages: [
                    { role: 'system', content: 'You summarize coding-agent context. Output only the updated summary.' },
                    { role: 'user', content: prompt },
                ],
                max_tokens: this.config.context?.maxSummaryTokens ?? 1200,
                temperature: 0.2,
            }, signal);
            if (summary && summary.trim().length > 80) {
                return summary.trim();
            }
        }
        catch (e: any) {
            events.onReasoning(`[上下文压缩失败：${String(e?.message || e).slice(0, 120)}。改用本地摘要。]`);
        }
        return this.buildLocalContextSummary(conv, segment, existingSummary);
    }
    private async ensureContextMemory(conv: ConversationState, taskComplexity: 'simple' | 'moderate' | 'complex', systemContent: string, events: AgentEvents, signal?: AbortSignal, force = false): Promise<boolean> {
        const keepRecent = this.getContextKeepRecent(conv, taskComplexity);
        const safeStart = this.findSafeRecentStart(conv.messages, keepRecent);
        const decision = this.shouldRefreshContextMemory(conv, taskComplexity, systemContent, safeStart, force);
        if (!decision.should)
            return false;
        const covered = Math.max(0, Math.min(conv.contextSummaryMessageCount || 0, conv.messages.length));
        const segmentStart = conv.contextSummary ? covered : 0;
        const segmentEnd = Math.max(segmentStart, safeStart);
        const segment = conv.messages.slice(segmentStart, segmentEnd);
        if (segment.length === 0)
            return false;
        events.onReasoning(`[上下文压缩] ${decision.reason}；压缩 ${segment.length} 条旧消息，保留最近 ${conv.messages.length - segmentEnd} 条消息。`);
        this.traceEvent(conv, 'context.compress', {
            reason: decision.reason,
            segmentMessages: segment.length,
            keptRecentMessages: conv.messages.length - segmentEnd,
            force,
        });
        const summary = await this.generateContextSummary(conv, segment, events, signal);
        conv.contextSummary = summary;
        conv.contextSummaryMessageCount = segmentEnd;
        conv.contextSummaryUpdatedAt = Date.now();
        this.saveConversations();
        return true;
    }
    private getRoundTimeoutMs(conv: ConversationState, taskComplexity: 'simple' | 'moderate' | 'complex'): number {
        const base = conv.mode === 'infinite' ? 180000 : 90000;
        if (taskComplexity === 'simple')
            return Math.max(60000, Math.floor(base * 0.8));
        if (taskComplexity === 'complex')
            return Math.min(180000, Math.floor(base * 1.25));
        return base;
    }
    private withoutUserPauseTools(tools: typeof TOOL_DEFINITIONS | undefined): typeof TOOL_DEFINITIONS | undefined {
        return tools?.filter(t => t.function.name !== 'ask_user');
    }
    private traceEvent(conv: ConversationState | undefined, type: string, data: Record<string, any> = {}): void {
        try {
            if (this.config.settings?.agent_trace?.enabled === false)
                return;
            const traceDir = path.join(os.homedir(), '.mimo', 'traces');
            if (!fs.existsSync(traceDir))
                fs.mkdirSync(traceDir, { recursive: true });
            const file = path.join(traceDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
            const safeData: Record<string, any> = {};
            for (const [key, value] of Object.entries(data)) {
                if (/key|token|secret|password|authorization/i.test(key))
                    continue;
                if (typeof value === 'string') {
                    safeData[key] = value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
                }
                else {
                    safeData[key] = value;
                }
            }
            const entry = {
                ts: new Date().toISOString(),
                session: this.traceSessionId,
                conversationId: conv?.id,
                mode: conv?.mode,
                model: conv?.model,
                type,
                ...safeData,
            };
            fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
        }
        catch {
            // Trace logging must never affect the user task.
        }
    }
    private buildAutonomousAskUserResult(args: Record<string, any>, mode: AgentMode): string {
        const question = String(args.question || '').trim();
        const options = Array.isArray(args.options)
            ? args.options.map((o: any) => String(o)).filter(Boolean)
            : [];
        const optionText = options.length > 0 ? ` Options: ${options.join(' | ')}.` : '';
        return [
            `User interruption is disabled in ${mode} mode.`,
            question ? `Question the model tried to ask: ${question}` : '',
            optionText,
            'Make the best autonomous decision now. Prefer the safest reversible option that satisfies the user request, document the assumption, continue execution, and do not call ask_user again for this branch.',
        ].filter(Boolean).join('\n');
    }
    /** Confirm or reject a pending write preview */
    confirmWrite(previewId: string, approved: boolean, newPath?: string): void {
        const pending = this.pendingWrites.get(previewId);
        if (!pending)
            return;
        this.pendingWrites.delete(previewId);
        const { isPathSafe, resolvePath } = require('./safety');
        const targetPath = newPath ? resolvePath(newPath, this.config.workspace) : pending.path;
        const { safe, reason } = isPathSafe(targetPath, this.config.workspace);
        if (!safe) {
            pending.resolve(`Safety: ${reason}`);
            return;
        }
        if (approved) {
            try {
                const displayPath = newPath || pending.path;
                const { bytes, backupNote } = writeTextFileWithGuards(targetPath, displayPath, pending.content, this.config.workspace);
                pending.resolve(`Written to ${targetPath} (approved by user, ${pending.content.length} chars, ${pending.content.split('\n').length} lines, ${bytes} bytes)${backupNote}`);
            }
            catch (e: any) {
                pending.resolve(`Write failed: ${e.message}`);
            }
        }
        else {
            pending.resolve('Write rejected by user');
        }
    }
    /** Answer a pending ask_user question */
    confirmAskUser(previewId: string, answer: string): void {
        const pending = this.pendingAsks.get(previewId);
        if (!pending)
            return;
        this.pendingAsks.delete(previewId);
        pending.resolve(answer);
    }
    // ── Abort (per-conversation) ──
    /** Abort a specific conversation, or all if no convId given */
    abort(convId?: string): void {
        if (convId) {
            this.stoppingConversations.add(convId);
            this.resolvePendingInteractions(convId, 'Stopped by user');
            const ac = this.abortControllers.get(convId);
            if (ac) {
                ac.abort();
                this.abortControllers.delete(convId);
            }
        }
        else {
            for (const [id] of this.abortControllers)
                this.stoppingConversations.add(id);
            this.resolvePendingInteractions(undefined, 'Stopped by user');
            for (const [, ac] of this.abortControllers)
                ac.abort();
            this.abortControllers.clear();
        }
    }
    private resolvePendingInteractions(convId: string | undefined, reason: string): void {
        for (const [id, pending] of Array.from(this.pendingEdits.entries())) {
            if (convId && pending.convId !== convId)
                continue;
            this.pendingEdits.delete(id);
            pending.resolve(reason);
        }
        for (const [id, pending] of Array.from(this.pendingWrites.entries())) {
            if (convId && pending.convId !== convId)
                continue;
            this.pendingWrites.delete(id);
            pending.resolve(reason);
        }
        for (const [id, pending] of Array.from(this.pendingAsks.entries())) {
            if (convId && pending.convId !== convId)
                continue;
            this.pendingAsks.delete(id);
            pending.resolve(reason);
        }
    }
    /** Fast check: should this conversation stop? (signal OR explicit stop) */
    private isStopping(convId: string, signal?: AbortSignal): boolean {
        return signal?.aborted === true || this.stoppingConversations.has(convId);
    }
    /**

     * Detect if reasoning text contains a repeated loop pattern.

     * Uses a multi-phase approach with progressively more aggressive detection:

     * 1. Strip known prefixes → detect short repeating phrases (the most common loop type)

     * 2. N-gram extraction → find the most repeated substring of any length

     * 3. Raw text fallback → strict check on unstripped text

     */
    private detectReasoningLoop(text: string): {
        detected: boolean;
        count: number;
    } {
        const MIN_REPEATS = 5; // Higher threshold to avoid false positives on normal reasoning patterns
        const MIN_TEXT_LEN = 300; // Don't check very short reasoning
        if (text.length < MIN_TEXT_LEN)
            return { detected: false, count: 0 };
        // Phase 1: Strip known persona/intent prefixes and detect short repeating phrases
        // e.g. "[意图: code_task] 需要工具 — Proceed with tools 让我看第一个结果"
        // After stripping, the real action description (unique per round) remains.
        const cleaned = text.replace(/\[(?:Role|意图|Context)[^\]]*\]\s*/g, '').replace(/Proceed with tools[\s—-]*/g, '').replace(/需要工具[\s—-]*/g, '').replace(/让我[看查检]?\S{0,8}[，。.]\s*/g, '').replace(/现在[让我]?\S{0,8}[，。.]\s*/g, '').replace(/\s+/g, ' ').trim();
        const repeatedChunk = this.detectRepeatedReasoningChunk(cleaned);
        if (repeatedChunk.detected) {
            return repeatedChunk;
        }
        // Try multiple pattern lengths: shorter patterns catch more loop types
        for (const patLen of [20, 30, 40, 60]) {
            if (cleaned.length < patLen * MIN_REPEATS)
                continue;
            const pattern = cleaned.slice(-patLen);
            // Skip if pattern is mostly whitespace/punctuation
            if (/^[\s—\-.:,;!?]+$/.test(pattern))
                continue;
            // Scan a wide window (up to 3000 chars back)
            const scanStart = Math.max(0, cleaned.length - 3000);
            const region = cleaned.slice(scanStart, cleaned.length - patLen);
            let count = 0;
            let pos = 0;
            while ((pos = region.indexOf(pattern, pos)) !== -1) {
                count++;
                pos += patLen;
            }
            if (count >= MIN_REPEATS) {
                return { detected: true, count: count + 1 };
            }
        }
        // Phase 2: N-gram extraction — find the most repeated substring of any length
        // This catches loops that don't match a fixed pattern length
        if (cleaned.length >= 400) {
            const bestRepeat = this.findMostRepeatedSubstring(cleaned);
            if (bestRepeat && bestRepeat.count >= MIN_REPEATS && bestRepeat.length >= 20) {
                return { detected: true, count: bestRepeat.count };
            }
        }
        // Phase 3: Raw text fallback — very strict check on unstripped text
        if (text.length >= 600) {
            const rawPat = text.slice(-50);
            if (rawPat.length >= 50) {
                const rawStart = Math.max(0, text.length - 2000);
                const rawRegion = text.slice(rawStart, text.length - 50);
                let rawCount = 0;
                let rawPos = 0;
                while ((rawPos = rawRegion.indexOf(rawPat, rawPos)) !== -1) {
                    rawCount++;
                    rawPos += 50;
                }
                if (rawCount >= 8) {
                    return { detected: true, count: rawCount + 1 };
                }
            }
        }
        return { detected: false, count: 0 };
    }
    private detectRepeatedReasoningChunk(text: string): {
        detected: boolean;
        count: number;
    } {
        const recent = String(text || '').slice(-5000);
        if (recent.length < 300)
            return { detected: false, count: 0 };
        const chunks = recent
            .split(/(?:\r?\n+|(?<=[.!?。！？])\s+)/)
            .map(chunk => chunk.replace(/\s+/g, ' ').trim())
            .filter(chunk => chunk.length >= 40 && /[A-Za-z\u4e00-\u9fff]/.test(chunk));
        const counts = new Map<string, number>();
        for (const chunk of chunks) {
            const normalized = chunk
                .replace(/^(?:The user wants me to|I need to|Let me|Now I|用户希望|我需要|让我)\s*/i, '')
                .slice(0, 240);
            if (normalized.length < 40)
                continue;
            const count = (counts.get(normalized) || 0) + 1;
            if (count >= 5)
                return { detected: true, count };
            counts.set(normalized, count);
        }
        const intentLoopCount = (recent.match(/The user wants me to|I need to check|Let me check|用户希望我|我需要检查|让我检查/gi) || []).length;
        if (intentLoopCount >= 5)
            return { detected: true, count: intentLoopCount };
        return { detected: false, count: 0 };
    }
    /**

     * Find the most frequently repeated substring in text.

     * Uses sliding window with short-to-long pattern extraction.

     * Returns the pattern with the highest repetition count (min length 15).

     */
    private findMostRepeatedSubstring(text: string): {
        pattern: string;
        count: number;
        length: number;
    } | null {
        let bestPattern = '';
        let bestCount = 0;
        // Try pattern lengths from short to long
        for (let patLen = 15; patLen <= 60; patLen += 5) {
            if (text.length < patLen * 4)
                break;
            // Sample positions: last N chars as potential patterns
            const sampleCount = Math.min(5, Math.floor(text.length / patLen));
            for (let s = 0; s < sampleCount; s++) {
                const endPos = text.length - s * patLen;
                const pattern = text.slice(endPos - patLen, endPos);
                if (/^[\s—\-.:,;!?]+$/.test(pattern))
                    continue;
                // Count occurrences in the full text
                let count = 0;
                let pos = 0;
                while ((pos = text.indexOf(pattern, pos)) !== -1) {
                    count++;
                    pos += patLen;
                }
                if (count > bestCount) {
                    bestCount = count;
                    bestPattern = pattern;
                }
            }
        }
        return bestPattern ? { pattern: bestPattern, count: bestCount, length: bestPattern.length } : null;
    }
    private isToolResultError(result: string): boolean {
        return result.startsWith('Safety:')
            || result.startsWith('Tool error:')
            || result.startsWith('Unknown tool')
            || result.startsWith('Blocked by')
            || result.startsWith('MCP tool error')
            || result.startsWith('MCP error:')
            || result === '(aborted)';
    }
    private isProgressTool(toolName: string, result: string): boolean {
        if (this.isToolResultError(result))
            return false;
        if (this.isNoProgressToolResult(result))
            return false;
        return [
            'edit_file',
            'write_file',
            'delete_file',
            'schedule_tasks',
            'update_todos',
            'execute_command',
            'git_commit',
            'run_workflow',
            'spawn_subagent',
        ].includes(toolName);
    }
    private parseToolArgs(toolCall: ToolCall): Record<string, any> {
        try {
            const parsed = JSON.parse(toolCall.function.arguments || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch {
            const raw = String(toolCall.function.arguments || '');
            const recovered: Record<string, any> = {};
            const pathMatch = raw.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
            if (pathMatch) {
                recovered.path = pathMatch[1]
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\')
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r')
                    .replace(/\\t/g, '\t');
            }
            const contentMatch = raw.match(/"content"\s*:\s*"([\s\S]*)$/);
            if (contentMatch) {
                recovered.content = '[streamed content omitted: tool arguments were incomplete during parsing]';
            }
            return recovered;
        }
    }
    private normalizeCommandForIntent(command: string): string {
        return String(command || '')
            .replace(/`/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }
    private isReadOnlyExecuteCommand(args: Record<string, any>): boolean {
        const command = this.normalizeCommandForIntent(args.command || '');
        if (!command || !/\bgit\b/.test(command))
            return false;
        const mutatingGit = /\bgit\b[\s\S]{0,120}\b(add|commit|push|pull|fetch|merge|rebase|checkout|switch|restore|reset|clean|stash|tag|branch|remote\s+(?:add|set-url|remove|rename|prune)|submodule\s+(?:update|add|sync))\b/i;
        if (mutatingGit.test(command))
            return false;
        return /\bgit\b[\s\S]{0,120}\b(status|log|diff|show|remote\s+-v|rev-parse|branch(?:\s+--show-current)?|ls-files)\b/i.test(command);
    }
    private isProgressToolCall(toolCall: ToolCall, result: string): boolean {
        if (!this.isProgressTool(toolCall.function.name, result))
            return false;
        if (toolCall.function.name !== 'execute_command')
            return true;
        return !this.isReadOnlyExecuteCommand(this.parseToolArgs(toolCall));
    }
    private isGitPushDeliveryRequest(text: string): boolean {
        const normalized = String(text || '').toLowerCase();
        const hasGit = /\bgit\b|提交|commit|暂存|推送|同步|push/.test(normalized);
        const wantsPush = /\bpush\b|推送|同步到远程|同步远程|上传到远程|提交并推送|git\s*并\s*push|git\s*and\s*push|commit\s+and\s+push/.test(normalized);
        return hasGit && wantsPush;
    }
    private extractRecentGitToolEvidence(conv: ConversationState, lookback = 80): {
        text: string;
        commitHash?: string;
        pushed: boolean;
        clean: boolean;
        upToDate: boolean;
        blocked: boolean;
        hardFailure: boolean;
    } {
        const gitTexts: string[] = [];
        for (const msg of conv.messages.slice(-lookback)) {
            if (msg.role !== 'tool')
                continue;
            const name = msg._toolName || '';
            const text = this.extractMessageText(msg.content);
            if (name.startsWith('git_')
                || name === 'execute_command'
                || /\bgit\b|Everything up-to-date|nothing to commit|working tree clean|Your branch is up to date with|up to date with 'origin\//i.test(text)) {
                gitTexts.push(text);
            }
        }
        const text = gitTexts.join('\n');
        const commitMatches = Array.from(text.matchAll(/(?:\[[^\]\r\n]*\]\s*)?([0-9a-f]{7,40})\s+([^\r\n]+)/gi));
        const commitHash = commitMatches.length > 0 ? commitMatches[commitMatches.length - 1][1] : undefined;
        const pushed = /Everything up-to-date|To\s+\S+[\s\S]{0,800}(?:\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b|\*\s+\[new branch\])|branch .*set up to track|up to date with 'origin\/|Your branch is up to date with/i.test(text);
        const clean = /nothing to commit, working tree clean|working tree clean|nothing added to commit/i.test(text);
        const upToDate = /Everything up-to-date|Your branch is up to date with|up to date with 'origin\/|origin\/\S+.*(?:[0-9a-f]{7,40})/i.test(text);
        const blocked = /Safety:|Blocked by|Force push|forbidden|protected branch|Permission denied|Authentication failed|Repository not found|fatal: Authentication failed/i.test(text);
        const hardFailure = /Git error:|Tool error:|fatal:|rejected|failed to push|could not read Username|Could not resolve host|unable to access/i.test(text)
            && !/Everything up-to-date|Your branch is up to date with|nothing to commit, working tree clean/i.test(text);
        return { text, commitHash, pushed, clean, upToDate, blocked, hardFailure };
    }
    private detectGitPushDeliveryComplete(conv: ConversationState, userInput: string): {
        done: boolean;
        summary?: string;
        reason?: string;
    } {
        if (!this.isGitPushDeliveryRequest(userInput))
            return { done: false };
        const evidence = this.extractRecentGitToolEvidence(conv);
        if (!evidence.text.trim())
            return { done: false };
        if (evidence.blocked || evidence.hardFailure)
            return { done: false };
        const remoteVerified = evidence.pushed || evidence.upToDate;
        const worktreeSettled = evidence.clean || remoteVerified;
        if (!remoteVerified || !worktreeSettled)
            return { done: false };
        const useChinese = this.prefersChinese(userInput, conv);
        const commitLine = evidence.commitHash
            ? (useChinese ? `提交: ${evidence.commitHash}` : `Commit: ${evidence.commitHash}`)
            : (useChinese ? '未检测到新的本地提交哈希，远端同步状态已确认。' : 'No new local commit hash was detected; remote sync state was verified.');
        const statusLine = evidence.clean
            ? (useChinese ? '工作区状态: clean' : 'Workspace: clean')
            : (useChinese ? '工作区状态: 未看到未提交改动阻塞交付' : 'Workspace: no blocking uncommitted changes detected');
        const remoteLine = evidence.upToDate || evidence.pushed
            ? (useChinese ? '远端状态: 已与 origin 同步或无需推送。' : 'Remote: synced with origin or already up to date.')
            : '';
        const summary = useChinese
            ? `已完成 git 提交/推送检查并确认任务可以收口。\n\n- ${commitLine}\n- ${statusLine}\n- ${remoteLine}\n\n后续不会继续重复执行 git log/status/diff 检查。`
            : `Git commit/push delivery is complete.\n\n- ${commitLine}\n- ${statusLine}\n- ${remoteLine}\n\nMIMO will stop instead of repeating git log/status/diff checks.`;
        return { done: true, summary, reason: 'remote verified and workspace settled' };
    }
    private finishWithLocalSummary(conv: ConversationState, userInput: string, summary: string, events: AgentEvents, toolObservations: ToolObservation[], convId: string, traceType: string, traceData: Record<string, any> = {}): string {
        const summaryWithArtifacts = this.appendMissingArtifactSummary(conv, summary);
        const finalOutput = this.maybeSaveLongFinalResponse(summaryWithArtifacts, events, userInput);
        conv.messages.push({ role: 'assistant', content: finalOutput, reasoning_content: '' } as any);
        this.saveConversations();
        this.traceEvent(conv, traceType, {
            ...traceData,
            responseChars: finalOutput.length,
        });
        this.learnFromCompletedTurn(userInput, finalOutput, events, toolObservations);
        events.onFinalAnswer?.(finalOutput);
        events.onDone(finalOutput);
        this.finishChat(convId);
        return finalOutput;
    }
    private isNoProgressToolResult(result: string): boolean {
        return /^Skipped (?:duplicate|repeated) read-only tool call\b/i.test(result || '');
    }
    private isReadOnlyAuditRequest(text: string): boolean {
        const raw = String(text || '');
        if (!raw.trim())
            return false;
        const lower = raw.toLowerCase();
        const english = /(read-?only|review|audit|do not modify|no changes|analy[sz]e|analysis|inspect|explain)/i.test(lower);
        const chinese = ['??', '????', '?????', '???', '???', '???', '??', '??', '??', '??', '??'].some(token => raw.includes(token));
        const fileMention = /(.(html|htm|css|js|ts|tsx|jsx|json|md|py|java|cpp|c|h|hpp|rs|go|php|rb|sh))/i.test(lower);
        const analysisVerb = /(analy[sz]e|analysis|inspect|review|explain)/i.test(lower) || ['?', '??', '??', '??', '??'].some(token => raw.includes(token));
        return english || chinese || (fileMention && analysisVerb);
    }
    private isLoopGuardReadOnlyTool(toolName: string): boolean {
        return [
            'schedule_tasks',
            'read_file', 'search_files', 'glob_files', 'list_directory',
            'get_file_info', 'git_status', 'git_diff', 'git_log',
            'fetch_url', 'web_search', 'git_worktree_list', 'read_notebook',
        ].includes(toolName);
    }
    private isLoopGuardStateChangingTool(toolName: string): boolean {
        return [
            'edit_file', 'write_file', 'delete_file', 'move_file', 'copy_file',
            'schedule_tasks', 'update_todos', 'execute_command', 'git_commit', 'run_workflow', 'spawn_subagent',
        ].includes(toolName);
    }
    private normalizeToolArgsForLoopGuard(toolName: string, args: Record<string, any>): string {
        return `${toolName}:${JSON.stringify(this.normalizeLoopGuardValue(args))}`;
    }
    private normalizeLoopGuardValue(value: any, key = ''): any {
        if (value === null || value === undefined)
            return value;
        if (Array.isArray(value)) {
            return value.map(item => this.normalizeLoopGuardValue(item, key));
        }
        if (typeof value === 'object') {
            const out: Record<string, any> = {};
            for (const childKey of Object.keys(value).sort()) {
                out[childKey] = this.normalizeLoopGuardValue(value[childKey], childKey);
            }
            return out;
        }
        if (typeof value === 'string') {
            let text = value.trim();
            if (/^(path|file|filePath|dir|directory|cwd|workspace)$/i.test(key)) {
                text = text.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
            }
            return text;
        }
        return value;
    }
    private countReadOnlyRepeatsThisTurn(conv: ConversationState, toolName: string, args: Record<string, any>): number {
        if (!this.isLoopGuardReadOnlyTool(toolName))
            return 0;
        const key = this.normalizeToolArgsForLoopGuard(toolName, args);
        let currentUserIndex = -1;
        for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === 'user') {
                currentUserIndex = i;
                break;
            }
        }
        if (currentUserIndex < 0)
            return 0;
        let count = 0;
        // The latest assistant message is the current batch being planned, so exclude it.
        const endIndex = conv.messages.length - 1;
        for (let i = currentUserIndex + 1; i < endIndex; i++) {
            const msg = conv.messages[i];
            if (msg.role !== 'assistant' || !msg.tool_calls?.length)
                continue;
            for (const tc of msg.tool_calls) {
                let priorArgs: Record<string, any> = {};
                try {
                    priorArgs = JSON.parse(tc.function.arguments || '{}');
                }
                catch {
                    priorArgs = {};
                }
                if (this.isLoopGuardStateChangingTool(tc.function.name)) {
                    count = 0;
                    continue;
                }
                if (tc.function.name === toolName
                    && this.normalizeToolArgsForLoopGuard(tc.function.name, priorArgs) === key) {
                    count++;
                }
            }
        }
        return count;
    }
    private collectReadFileRangesThisTurn(conv: ConversationState): Map<string, Array<{
        start: number;
        end: number;
    }>> {
        const ranges = new Map<string, Array<{
            start: number;
            end: number;
        }>>();
        let currentUserIndex = -1;
        for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === 'user') {
                currentUserIndex = i;
                break;
            }
        }
        if (currentUserIndex < 0)
            return ranges;
        const endIndex = conv.messages.length - 1;
        for (let i = currentUserIndex + 1; i < endIndex; i++) {
            const msg = conv.messages[i];
            if (msg.role !== 'assistant' || !msg.tool_calls?.length)
                continue;
            for (const tc of msg.tool_calls) {
                if (this.isLoopGuardStateChangingTool(tc.function.name)) {
                    ranges.clear();
                    continue;
                }
                if (tc.function.name !== 'read_file')
                    continue;
                let priorArgs: Record<string, any> = {};
                try {
                    priorArgs = JSON.parse(tc.function.arguments || '{}');
                }
                catch {
                    priorArgs = {};
                }
                const range = this.getReadFileRange(priorArgs);
                if (!range)
                    continue;
                const list = ranges.get(range.path) || [];
                list.push({ start: range.start, end: range.end });
                ranges.set(range.path, list);
            }
        }
        return ranges;
    }
    private shouldSkipOverlappingReadFile(args: Record<string, any>, readRanges: Map<string, Array<{
        start: number;
        end: number;
    }>>): string | null {
        const range = this.getReadFileRange(args);
        if (!range)
            return null;
        const prior = readRanges.get(range.path) || [];
        if (prior.length === 0) {
            readRanges.set(range.path, [{ start: range.start, end: range.end }]);
            return null;
        }
        const requested = range.end - range.start;
        const covered = this.readRangeCoveredLength(prior, range.start, range.end);
        const overlapRatio = requested > 0 ? covered / requested : 0;
        if (covered >= requested || overlapRatio >= 0.72) {
            const gap = this.firstUnreadReadRange(prior, range.start, range.end);
            const shownStart = range.start + 1;
            const shownEnd = range.end;
            const gapHint = gap
                ? ` If more context is needed, read only the uncovered gap with offset=${gap.start}, limit=${Math.max(1, gap.end - gap.start)}.`
                : ' Use the earlier read_file result instead of rereading this range.';
            return `Skipped overlapping read_file range for ${args.path || range.path} [L${shownStart}-${shownEnd}]; ${Math.round(overlapRatio * 100)}% was already read in this user turn.${gapHint}`;
        }
        prior.push({ start: range.start, end: range.end });
        readRanges.set(range.path, prior);
        return null;
    }
    private summarizeRoundProgress(toolCalls: ToolCall[], toolResults: string[], elapsedMs: number): RoundProgress {
        const completed = toolResults.filter(Boolean);
        const errors = completed.filter(result => this.isToolResultError(result));
        const noProgress = completed.filter(result => this.isNoProgressToolResult(result));
        const progressTools = toolCalls.filter((tc, index) => this.isProgressToolCall(tc, toolResults[index] || ''));
        const readOnlySuccessCount = toolCalls.filter((tc, index) => !this.isToolResultError(toolResults[index] || '')
            && !this.isNoProgressToolResult(toolResults[index] || '')
            && (['read_file', 'search_files', 'glob_files', 'list_directory', 'get_file_info', 'git_status', 'git_diff', 'git_log', 'fetch_url', 'web_search'].includes(tc.function.name)
                || (tc.function.name === 'execute_command' && this.isReadOnlyExecuteCommand(this.parseToolArgs(tc))))).length;
        const readOnlySuccess = readOnlySuccessCount > 0;
        const valuableProgress = progressTools.length > 0;
        const madeProgress = valuableProgress || readOnlySuccess;
        const errorOnly = completed.length > 0 && errors.length === completed.length;
        let reason = valuableProgress
            ? `${progressTools.length} 个推进型工具成功`
            : readOnlySuccess
                ? '只读探索成功'
                : errorOnly
                    ? `${errors.length} 个工具错误`
                    : noProgress.length > 0
                        ? `${noProgress.length} 个重复/无进展工具`
                        : '没有完成的工具结果';
        if (elapsedMs > 90000) {
            reason += '；本轮达到超时保护';
        }
        return {
            madeProgress,
            valuableProgress,
            errorOnly,
            reason,
            completedCount: completed.length,
            errorCount: errors.length,
            noProgressCount: noProgress.length,
            progressToolCount: progressTools.length,
            readOnlySuccessCount,
        };
    }
    private buildRoundNarration(round: number, taskComplexity: 'simple' | 'moderate' | 'complex', conv: ConversationState, stallRounds: number, softMaxRounds: number, hardMaxRounds: number, unlimitedRounds: boolean): string {
        const useChinese = this.prefersChinese('', conv);
        const mode = conv.mode === 'infinite' ? 'Infinite' : conv.mode === 'auto' ? 'Auto' : conv.mode;
        const budgetHint = unlimitedRounds ? 'no fixed cap' : `${softMaxRounds}/${hardMaxRounds}`;
        const roundStallHint = stallRounds > 0 ? `, low-progress streak ${stallRounds}` : '';
        if (useChinese) {
            const zhMode = conv.mode === 'infinite' ? '无限' : conv.mode === 'auto' ? '自动' : conv.mode;
            const zhBudget = unlimitedRounds ? '无固定轮次上限' : `${softMaxRounds}/${hardMaxRounds}`;
            const zhStall = stallRounds > 0 ? `，低进展连续 ${stallRounds} 轮` : '';
            return `[第 ${round} 轮] ${zhMode}模式，任务复杂度 ${taskComplexity}，预算 ${zhBudget}${zhStall}。正在选择下一步具体动作。`;
        }
        return `[Round ${round}] ${mode}, ${taskComplexity}, budget ${budgetHint}${roundStallHint}. Choosing the next concrete action.`;
        const budget = unlimitedRounds
            ? '当前没有软轮次预算，但仍会监测停滞和重复。'
            : `软预算 ${softMaxRounds} 轮，硬上限 ${hardMaxRounds} 轮。`;
        const modeHint = conv.mode === 'infinite'
            ? 'Infinite 模式会允许更长执行，但低进展时仍会暂停交接。'
            : 'Auto 模式会在探索、修改、验证之间尽量收敛。';
        const stallHint = stallRounds > 0
            ? `上一轮进展偏低，当前停滞计数 ${stallRounds}。本轮会优先换一个更具体的动作。`
            : '本轮会先根据已有上下文选择最有信息量的下一步。';
        return `[第 ${round} 轮] 任务复杂度：${taskComplexity}。${budget} ${modeHint} ${stallHint}`;
    }
    private buildRoundStatus(round: number, conv: ConversationState): string {
        return conv.uiLang === 'en'
            ? `Round ${round}: planning next step...`
            : `第 ${round} 轮：规划下一步...`;
    }
    private describeToolAction(name: string, args: Record<string, any>): string {
        const pathArg = args.path || args.filePath || args.directory || args.dir || args.cwd;
        switch (name) {
            case 'read_file': {
                const offset = Number(args.offset ?? 0);
                const limit = Number(args.limit ?? 500);
                const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) + 1 : 1;
                const end = Number.isFinite(limit) ? start + Math.max(1, Math.floor(limit)) - 1 : '...';
                return `读取 ${pathArg || '文件'} [L${start}-${end}]`;
            }
            case 'write_file':
                return `写入 ${pathArg || '文件'}`;
            case 'edit_file':
                return `编辑 ${pathArg || '文件'}`;
            case 'list_directory':
                return `查看目录 ${pathArg || ''}`.trim();
            case 'search_files':
                return `搜索 "${args.pattern || args.query || ''}"`;
            case 'glob_files':
                return `匹配 ${args.pattern || ''}`;
            case 'execute_command': {
                const command = String(args.command || '').replace(/\s+/g, ' ').trim();
                return `运行命令 ${command.slice(0, 90)}${command.length > 90 ? '...' : ''}`;
            }
            case 'schedule_tasks': {
                const tasks = Array.isArray(args.tasks) ? args.tasks : [];
                return `分析任务顺序 ${tasks.length} 项`;
            }
            case 'update_todos': {
                const todos = Array.isArray(args.todos) ? args.todos : [];
                const done = todos.filter((item: any) => /completed|done/i.test(String(item?.status || ''))).length;
                return `更新任务清单 ${done}/${todos.length}`;
            }
            case 'git_status':
                return '查看 git 状态';
            case 'git_diff':
                return '查看 git diff';
            case 'git_log':
                return '查看提交历史';
            case 'fetch_url':
                return `获取 ${args.url || '网页'}`;
            case 'web_search':
                return `搜索网页 "${args.query || ''}"`;
            case 'spawn_subagent':
                return '启动子代理';
            case 'run_workflow':
                return '运行工作流';
            default:
                return `调用 ${name}`;
        }
    }
    private describeToolOutcome(name: string, args: Record<string, any>, result: string, elapsed: number): string {
        const action = this.describeToolAction(name, args);
        const seconds = `${elapsed.toFixed(1)}s`;
        if (this.isToolResultError(result)) {
            const firstLine = this.extractMessageText(result).split(/\r?\n/).find(Boolean) || '工具返回错误';
            return `[工具结果] ${action}失败（${seconds}）：${firstLine.slice(0, 160)}`;
        }
        if (this.isNoProgressToolResult(result)) {
            return `[工具结果] ${action}被跳过：检测到重复或无进展。`;
        }
        const text = this.extractMessageText(result);
        const lineCount = text ? text.split(/\r?\n/).length : 0;
        const sizeHint = text.length > 0
            ? `返回约 ${lineCount} 行 / ${text.length} 字符`
            : '没有返回正文';
        return `[工具结果] ${action}完成（${seconds}），${sizeHint}。`;
    }
    private describeToolPlan(round: number, tasks: Array<{
        tc: ToolCall;
        args: Record<string, any>;
        parallel: boolean;
    }>, skippedCount: number): string {
        const preview = tasks
            .slice(0, 5)
            .map(task => this.describeToolAction(task.tc.function.name, task.args))
            .join('；');
        const more = tasks.length > 5 ? `；另有 ${tasks.length - 5} 个动作` : '';
        const skipped = skippedCount > 0 ? ` 已跳过 ${skippedCount} 个重复只读调用。` : '';
        return `[工具计划] 第 ${round} 轮准备执行 ${tasks.length} 个动作：${preview || '无工具动作'}${more}。${skipped}`;
    }
    private buildProgressRecoveryInstruction(reason: string, roundProgress: RoundProgress, readonlyOnlyRounds: number, stallRounds: number): ChatMessage {
        return {
            role: 'system',
            content: `[Progress guard]

The last round showed low-value progress: ${reason}.

Stats: valuable tools=${roundProgress.progressToolCount || 0}, read-only successes=${roundProgress.readOnlySuccessCount || 0}, no-progress tools=${roundProgress.noProgressCount || 0}, errors=${roundProgress.errorCount || 0}, read-only-only rounds=${readonlyOnlyRounds}, stall rounds=${stallRounds}.



Change strategy now:

1. Do not repeat broad listing/searching/checking that already happened.

2. If enough evidence exists, either make the smallest concrete change, run validation, or produce the final answer.

3. If a tool is needed, choose one high-value tool call with a specific target.

4. State briefly what you learned and what you are doing next.

5. If there is no credible next action, stop and summarize current progress instead of continuing to inspect.`,
        } as any;
    }
    private getLatestUserGoal(conv: ConversationState): string {
        for (let i = conv.messages.length - 1; i >= 0; i--) {
            const msg = conv.messages[i];
            if (msg.role === 'user') {
                const text = this.extractMessageText(msg.content);
                if (text)
                    return text;
            }
        }
        return '';
    }
    private parseCountToken(token: string): number | null {
        const text = String(token || '').trim();
        if (!text)
            return null;
        if (/^\d+$/.test(text))
            return Number(text);
        const digitMap: Record<string, number> = {
            '零': 0,
            '一': 1,
            '二': 2,
            '两': 2,
            '三': 3,
            '四': 4,
            '五': 5,
            '六': 6,
            '七': 7,
            '八': 8,
            '九': 9,
        };
        if (text === '十')
            return 10;
        if (/^[一二两三四五六七八九]十[一二三四五六七八九]?$/.test(text)) {
            const tens = digitMap[text[0]] || 0;
            const ones = text.length > 2 ? (digitMap[text[2]] || 0) : 0;
            return tens * 10 + ones;
        }
        if (/^十[一二三四五六七八九]$/.test(text)) {
            return 10 + (digitMap[text[1]] || 0);
        }
        if (/^[零一二两三四五六七八九]$/.test(text)) {
            return digitMap[text] ?? null;
        }
        return null;
    }
    private classifyRequestedDeliverableKind(text: string): 'audio' | 'image' | 'video' | 'file' | null {
        const raw = String(text || '');
        if (/(?:音频|语音|音轨|朗读|配音|旁白|tts|mp3|wav|audio|speech|voice)/i.test(raw))
            return 'audio';
        if (/(?:图片|图像|海报|封面|截图|png|jpg|jpeg|webp|gif|image)/i.test(raw))
            return 'image';
        if (/(?:视频|短片|片段|动画|mp4|mov|webm|video)/i.test(raw))
            return 'video';
        if (/(?:文件|文档|脚本|表格|pdf|docx?|xlsx?|pptx?|markdown|txt|json|html|file)/i.test(raw))
            return 'file';
        return null;
    }
    private getDeliverableCountPattern(kind: 'audio' | 'image' | 'video' | 'file'): RegExp {
        const count = '(\\d+|十[一二三四五六七八九]?|[一二两三四五六七八九]十[一二三四五六七八九]?|[零一二两三四五六七八九])';
        const unit = '(?:个|段|条|份|章|首|篇)?';
        const gap = '[^\\r\\n]{0,24}?';
        switch (kind) {
            case 'audio':
                return new RegExp(`${count}\\s*${unit}\\s*${gap}(?:音频|语音|音轨|朗读|配音|旁白|mp3|wav|audio|speech|voice)`, 'i');
            case 'image':
                return new RegExp(`${count}\\s*${unit}\\s*${gap}(?:图片|图像|海报|封面|截图|png|jpg|jpeg|webp|gif|image)`, 'i');
            case 'video':
                return new RegExp(`${count}\\s*${unit}\\s*${gap}(?:视频|短片|片段|动画|mp4|mov|webm|video)`, 'i');
            default:
                return new RegExp(`${count}\\s*${unit}\\s*${gap}(?:文件|文档|脚本|表格|pdf|docx?|xlsx?|pptx?|markdown|txt|json|html|file)`, 'i');
        }
    }
    private extractRequestedDeliverableCount(text: string): { kind: 'audio' | 'image' | 'video' | 'file'; count: number } | null {
        const raw = String(text || '');
        if (!/(?:生成|创建|导出|输出|制作|合成|产出|render|generate|create|export|produce|synthesize|build|write)/i.test(raw)) {
            return null;
        }
        const kind = this.classifyRequestedDeliverableKind(raw);
        if (!kind)
            return null;
        const match = raw.match(this.getDeliverableCountPattern(kind));
        const count = this.parseCountToken(match?.[1] || '');
        return count && count > 0 ? { kind, count } : null;
    }
    private extractClaimedDeliverableCount(text: string, kind: 'audio' | 'image' | 'video' | 'file'): number | null {
        const match = String(text || '').match(this.getDeliverableCountPattern(kind));
        return this.parseCountToken(match?.[1] || '');
    }
    private extractClaimedDeliverableCounts(text: string, kind: 'audio' | 'image' | 'video' | 'file'): number[] {
        const counts: number[] = [];
        const pattern = this.getDeliverableCountPattern(kind);
        for (const match of String(text || '').matchAll(new RegExp(pattern.source, 'gi'))) {
            const count = this.parseCountToken(match[1] || '');
            if (count !== null) {
                counts.push(count);
            }
        }
        return counts;
    }
    private isArtifactOfKind(filePath: string, kind: 'audio' | 'image' | 'video' | 'file'): boolean {
        const ext = path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase();
        if (!ext)
            return false;
        if (kind === 'audio')
            return ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus'].includes(ext);
        if (kind === 'image')
            return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
        if (kind === 'video')
            return ['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext);
        return ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'txt', 'json', 'md', 'html', 'htm'].includes(ext);
    }
    private countCurrentTurnGeneratedDeliverables(conv: ConversationState, kind: 'audio' | 'image' | 'video' | 'file'): number {
        const recentMessages = conv.messages.slice(-80);
        let startIndex = 0;
        for (let i = recentMessages.length - 1; i >= 0; i--) {
            if (recentMessages[i].role === 'user') {
                startIndex = i;
                break;
            }
        }
        const currentTurn = recentMessages.slice(startIndex);
        let toolCallCount = 0;
        const artifacts = new Set<string>();
        for (const msg of currentTurn) {
            if (msg.role === 'assistant' && msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    const name = String(tc.function?.name || '');
                    if (kind === 'audio' && /synthesize_speech/i.test(name))
                        toolCallCount++;
                    else if (kind === 'image' && /(generate|render).*(image|poster|cover)|image_?generation/i.test(name))
                        toolCallCount++;
                    else if (kind === 'video' && /(render|generate).*(video|clip|animation)|video_?generation/i.test(name))
                        toolCallCount++;
                    else if (kind === 'file' && /^(?:write_file|copy_file|move_file)$/i.test(name))
                        toolCallCount++;
                }
                continue;
            }
            if (msg.role !== 'tool')
                continue;
            for (const artifact of this.extractArtifactPathsFromText(this.extractMessageText(msg.content))) {
                if (this.isArtifactOfKind(artifact, kind)) {
                    artifacts.add(artifact.replace(/\\/g, '/').toLowerCase());
                }
            }
        }
        return Math.max(toolCallCount, artifacts.size);
    }
    private detectRequestedDeliverableMismatch(conv: ConversationState, finalText: string): string {
        const goal = this.getLatestUserGoal(conv);
        const requested = this.extractRequestedDeliverableCount(goal);
        if (!requested)
            return '';
        const claimedCounts = this.extractClaimedDeliverableCounts(finalText, requested.kind);
        const claimed = claimedCounts.length > 0 ? claimedCounts[0] : null;
        const generated = this.countCurrentTurnGeneratedDeliverables(conv, requested.kind);
        const inconsistentClaim = claimedCounts.find(count => count !== requested.count);
        if (inconsistentClaim !== undefined) {
            return `final answer claims ${inconsistentClaim} ${requested.kind} items, but the user requested ${requested.count}`;
        }
        if (claimed !== null && claimed !== requested.count) {
            return `final answer claims ${claimed} ${requested.kind} items, but the user requested ${requested.count}`;
        }
        if (claimed !== null && generated > 0 && claimed !== generated) {
            return `final answer claims ${claimed} ${requested.kind} items, but this turn only generated ${generated}`;
        }
        const soundsComplete = /(?:全部|已全部|全部完成|全部生成|就绪|完成|已完成|done|completed|generated successfully|all .* ready)/i.test(finalText);
        if (soundsComplete && generated > 0 && generated !== requested.count) {
            return `user requested ${requested.count} ${requested.kind} items, but only ${generated} generation actions were observed`;
        }
        return '';
    }
    private hasRecentTool(conv: ConversationState, names: string[], lookback = 40): boolean {
        const set = new Set(names);
        return conv.messages.slice(-lookback).some(msg => msg.role === 'tool' && set.has(msg._toolName || ''));
    }
    private hasRecentValidation(conv: ConversationState, lookback = 50): boolean {
        const validationPattern = /\b(npm run (compile|build|test|lint|package)|npm test|pnpm test|yarn test|pytest|python -m py_compile|node --check|tsc|eslint|vitest|jest|cargo test|go test|mvn test|gradle test)\b/i;
        return conv.messages.slice(-lookback).some(msg => {
            if (msg.role === 'assistant' && msg.tool_calls?.length) {
                return msg.tool_calls.some(tc => {
                    if (tc.function.name !== 'execute_command')
                        return false;
                    return validationPattern.test(tc.function.arguments || '');
                });
            }
            if (msg.role !== 'tool')
                return false;
            const text = this.extractMessageText(msg.content);
            if (msg._toolName === 'execute_command' && validationPattern.test(text))
                return true;
            return /(compile|test|lint|validation|验证|测试).{0,80}(pass|success|ok|通过|成功)/i.test(text);
        });
    }
    private hasRecentEvidenceTool(conv: ConversationState, userInput: string, lookback = 80): boolean {
        const text = String(userInput || '');
        const wantsExternalEvidence = /(?:crossref|doi\b|api\b|endpoint|url\b|https?:\/\/|http status|status\s*code|web|internet|online|database|pubmed|arxiv|github|npm|pypi|\u63a5\u53e3|\u7f51\u7edc|\u7f51\u9875|\u5b98\u7f51|\u6570\u636e\u5e93|\u6587\u732e|\u8bba\u6587)/i.test(text);
        const evidenceTools = wantsExternalEvidence
            ? ['fetch_url', 'web_search']
            : [
                'read_file', 'search_files', 'glob_files', 'list_directory',
                'get_file_info', 'git_status', 'git_diff', 'git_log',
                'fetch_url', 'web_search', 'execute_command',
            ];
        const targetTerms = [
            /crossref/i.test(text) ? 'crossref' : '',
            /\bdoi\b/i.test(text) ? 'doi' : '',
            /\bapi\b/i.test(text) || /\u63a5\u53e3/.test(text) ? 'api' : '',
        ].filter(Boolean);
        const recent = conv.messages.slice(-lookback);
        return recent.some(msg => {
            if (msg.role === 'tool' && evidenceTools.includes(msg._toolName || '')) {
                if (!targetTerms.length) return true;
                const content = this.extractMessageText(msg.content).toLowerCase();
                return targetTerms.some(term => content.includes(term));
            }
            if (msg.role === 'assistant' && msg.tool_calls?.length) {
                return msg.tool_calls.some(tc => {
                    if (!evidenceTools.includes(tc.function.name)) return false;
                    if (!targetTerms.length) return true;
                    const args = String(tc.function.arguments || '').toLowerCase();
                    return targetTerms.some(term => args.includes(term));
                });
            }
            return false;
        });
    }
    private shouldForceToolEvidence(userInput: string, conv: ConversationState): boolean {
        if (!requiresToolEvidence(userInput))
            return false;
        return !this.hasRecentEvidenceTool(conv, userInput);
    }
    private shouldForceToolBackedAnswer(userInput: string, conv: ConversationState): boolean {
        if (!requiresToolBackedAnswer(userInput))
            return false;
        if (requiresToolEvidence(userInput))
            return this.shouldForceToolEvidence(userInput, conv);
        return !this.hasRecentTool(conv, [
            'read_file', 'search_files', 'glob_files', 'list_directory',
            'get_file_info', 'git_status', 'git_diff', 'git_log',
            'fetch_url', 'web_search', 'execute_command',
        ], 80);
    }
    private isReadOnlyAnalysisFinal(finalText: string): boolean {
        const text = String(finalText || '');
        if (!text.trim())
            return false;
        const lower = text.toLowerCase();
        const saysNoChanges = /(read-?only analysis|no changes were made|no file changes|did not modify|not modify|analysis only|pure analysis|planning only|no validation needed|无需(?:文件级)?验证|无(?:代码|文件)?(?:修改|变更)|未(?:修改|变更|写入|创建)任何文件|没有(?:代码|文件)?(?:修改|变更)|纯(?:分析|规划|方案))/i.test(text);
        const isAnalysisStyle = /(analysis|review|audit|inspection|explain|plan|planning|roadmap|方案|规划|分析|审查|评审|难点|路线)/i.test(text);
        const avoidsAction = !this.isUnexecutedActionStatement(text);
        const avoidsChangeClaims = !/(changed|modified|updated|implemented|fixed|created|wrote|edited)/i.test(lower);
        return saysNoChanges && isAnalysisStyle && avoidsAction && avoidsChangeClaims;
    }
    private isPlanningOrAnalysisDelivery(finalText: string): boolean {
        const text = String(finalText || '').trim();
        if (text.length < 80)
            return false;
        const hasCompletion = /(done|completed|final summary|task completed|finished|delivered|已完成|任务完成|完成总结|交付完成|已交付|处理完成)/i.test(text);
        const hasPlanningDeliverable = /(analysis|plan|planning|roadmap|proposal|architecture|design|difficulty|risk|trade-?off|方案|规划|分析|架构|设计|难点|清单|路线|步骤|技术方案|开发路线)/i.test(text);
        const saysNoChangesOrValidationNeeded = /(read-?only analysis|no changes were made|no file changes|did not modify|not modify|analysis only|pure analysis|planning only|no validation needed|无需(?:文件级)?验证|无(?:代码|文件)?(?:修改|变更)|未(?:修改|变更|写入|创建)任何文件|没有(?:代码|文件)?(?:修改|变更)|纯(?:分析|规划|方案))/i.test(text);
        const waitsForUserDecision = /(waiting for|wait(?:ing)? for your|choose|confirm|which option|next step|等待(?:老板|用户|你|您)?(?:确认|指示|决定|选择|下一步)|等(?:老板|用户|你|您).{0,24}(?:确认|选择|指示|决定)|请选择|选哪个|选哪一个|直接开始|调整方案|开工实现)/i.test(text);
        return hasCompletion && hasPlanningDeliverable && (saysNoChangesOrValidationNeeded || waitsForUserDecision);
    }
    private hasExplicitChangeClaim(text: string): boolean {
        const lower = String(text || '').toLowerCase();
        return /changed|modified|updated|implemented|fixed|created|wrote|edited|refactored|rewired|patched|已修改|已实现|已修复|已创建|新增|更新了|优化了|重构了|调整了|改了/.test(lower);
    }
    private admitsMissingValidation(text: string): boolean {
        const lower = String(text || '').toLowerCase();
        return /not run|did not run|untested|not verified|validation not run|tests? not run|未运行|未验证|没有验证|未测试|未跑测试|未执行验证|未执行测试/.test(lower);
    }
    private shouldContinueInfiniteAfterTextFinal(conv: ConversationState, taskComplexity: 'simple' | 'moderate' | 'complex', finalText: string, round: number, hardMaxRounds: number): CompletionGateDecision {
        if (conv.mode !== 'infinite')
            return { shouldContinue: false, reason: '' };
        if (taskComplexity === 'simple')
            return { shouldContinue: false, reason: '' };
        if (round >= hardMaxRounds)
            return { shouldContinue: false, reason: '' };
        if (this.isPlanningOrAnalysisDelivery(finalText) || this.isReadOnlyAnalysisFinal(finalText))
            return { shouldContinue: false, reason: '' };
        const deliverableMismatch = this.detectRequestedDeliverableMismatch(conv, finalText);
        if (deliverableMismatch) {
            return { shouldContinue: true, reason: deliverableMismatch };
        }
        const recentTools = conv.messages.slice(-50).filter(msg => msg.role === 'tool');
        const hasExploration = this.hasRecentTool(conv, [
            'read_file', 'search_files', 'glob_files', 'list_directory',
            'get_file_info', 'git_status', 'git_diff', 'git_log',
        ]);
        const hasMutation = this.hasRecentTool(conv, ['edit_file', 'write_file', 'delete_file', 'move_file', 'copy_file']);
        const hasValidation = this.hasRecentValidation(conv);
        const text = finalText.toLowerCase();
        const claimsDone = /完成|已修复|已实现|done|fixed|implemented|success|通过|验证/.test(text);
        if (round <= 2 && recentTools.length < 2 && !claimsDone) {
            return { shouldContinue: true, reason: 'final answer arrived before enough workspace exploration' };
        }
        if (taskComplexity === 'complex' && !hasExploration) {
            return { shouldContinue: true, reason: 'complex task has no recent file exploration evidence' };
        }
        if (hasMutation && !hasValidation) {
            return { shouldContinue: true, reason: 'changes were made but no recent validation was detected' };
        }
        if (taskComplexity === 'complex' && round < 4 && !hasValidation && recentTools.length > 0) {
            return { shouldContinue: true, reason: 'complex task needs one more verification/self-review pass' };
        }
        return { shouldContinue: false, reason: '' };
    }
    private hasPendingActionStatement(conv: ConversationState, lookback = 8): boolean {
        for (const msg of conv.messages.slice(-lookback).reverse()) {
            if (msg.role === 'tool')
                return false;
            if (msg.role !== 'assistant' || msg.tool_calls?.length)
                continue;
            const text = this.extractMessageText(msg.content);
            if (this.isUnexecutedActionStatement(text))
                return true;
        }
        return false;
    }
    private isUnexecutedActionStatement(text: string): boolean {
        const trimmed = this.extractMessageText(text).trim();
        if (!trimmed)
            return false;
        if (this.isDeliverySummary(trimmed) || this.isSubstantialFinalReport(trimmed) || this.isPlanningOrAnalysisDelivery(trimmed))
            return false;
        if (this.isRawShellCommandDraft(trimmed))
            return true;
        const saysWillInspect = /(?:let me|i(?:'|’)ll|i will|i need to|first i|now i).{0,120}(?:inspect|check|read|list|search|look|open|scan|run|verify|diff)|(?:我来|我先|让我|先|现在|接下来).{0,120}(?:看看|查看|检查|读取|列出|浏览|搜索|找|运行|验证|确认|diff|审核)/i.test(trimmed);
        const referencesToolTarget = /[A-Za-z]:[\\/]|(?:^|[\s"'`])\.{1,2}[\\/]|(?:read_file|list_directory|search_files|glob_files|git diff|git status|execute_command)|(?:\.pptx?|\.pdf|\.docx?|\.xlsx?|\.html?|\.tsx?|\.jsx?|\.ts|\.js|\.py|\.json|\.md)\b|(?:目录|文件|文件夹|项目|代码|页面|网页|动画|效果|版本|现有版本|改动|变更|diff|暂存|git|工作区|开题)/i.test(trimmed);
        const asksUserToWait = /稍等|等我|马上|我先看|我检查后|after I|once I|let me first/i.test(trimmed);
        const tooShortToBeDeliverable = trimmed.length < 900;
        return (saysWillInspect || asksUserToWait) && referencesToolTarget && tooShortToBeDeliverable;
    }
    private isRawShellCommandDraft(text: string): boolean {
        const lines = String(text || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        if (lines.length < 3)
            return false;
        const commandLike = lines.filter(line => /^\$[A-Za-z_][\w-]*\s*=/.test(line)
            || /^[A-Za-z_][\w-]*=.*$/.test(line)
            || /^(?:chcp|cd|dir|ls|rg|grep|findstr|git|npm|pnpm|yarn|node|python|py|powershell|pwsh|cmd|foreach|for|if|Get-|Set-|Write-|Select-|Copy-|Move-|Remove-)/i.test(line)
            || /\|\s*(?:Select-|Where-|ForEach-|findstr|grep|rg)/i.test(line)
            || /\[System\.[^\]]+\]::/.test(line)).length;
        const hasPlainInstruction = lines.some(line => /^(?:find|check|inspect|search|replace|update|write|read|list)\b/i.test(line)
            && !/[;|&]|\$\(|^\w+\s*=/.test(line));
        return commandLike >= 3 && (hasPlainInstruction || commandLike / lines.length >= 0.6);
    }
    private shouldContinueAutoAfterTextFinal(conv: ConversationState, taskComplexity: 'simple' | 'moderate' | 'complex', finalText: string, round: number, hardMaxRounds: number): CompletionGateDecision {
        if (conv.mode !== 'auto')
            return { shouldContinue: false, reason: '' };
        if (round >= hardMaxRounds)
            return { shouldContinue: false, reason: '' };
        if (this.isPlanningOrAnalysisDelivery(finalText) || this.isReadOnlyAnalysisFinal(finalText))
            return { shouldContinue: false, reason: '' };
        const deliverableMismatch = this.detectRequestedDeliverableMismatch(conv, finalText);
        if (deliverableMismatch) {
            return { shouldContinue: true, reason: deliverableMismatch };
        }
        const recentTools = conv.messages.slice(-40).filter(msg => msg.role === 'tool');
        const creationOnlyPromise = /(?:let me|i(?:'|’)?ll|i will|now i).{0,120}(?:create|generate|write|make|produce|build).{0,160}(?:file|script|document|markdown|python|test file)|(?:我来|我会|现在我来|接下来我).{0,120}(?:创建|生成|写入|写一个|做一个|产出).{0,160}(?:文件|脚本|文档|markdown|python|测试文件)/i.test(finalText)
            && !/(?:inspect|check|read|list|search|look|open|scan|run|verify|diff|查看|检查|读取|列出|搜索|验证|确认|审查)/i.test(finalText);
        if (creationOnlyPromise) {
            return { shouldContinue: false, reason: '' };
        }
        if (this.isUnexecutedActionStatement(finalText)) {
            return { shouldContinue: true, reason: 'assistant announced a pending tool-backed step instead of a final answer' };
        }
        if (taskComplexity === 'simple')
            return { shouldContinue: false, reason: '' };
        const hasExploration = this.hasRecentTool(conv, [
            'read_file', 'search_files', 'glob_files', 'list_directory',
            'get_file_info', 'git_status', 'git_diff', 'git_log',
        ], 40);
        const hasMutation = this.hasRecentTool(conv, ['edit_file', 'write_file', 'delete_file', 'move_file', 'copy_file'], 50);
        const hasValidation = this.hasRecentValidation(conv, 60);
        const claimsChanged = this.hasExplicitChangeClaim(finalText);
        const admitsNoValidation = this.admitsMissingValidation(finalText);
        const userVisibleDone = /任务完成|已完成|完成总结|交付文件|验证结果|文件保存|作文已保存|符合要求|内容充实|task complete|saved to|validation result|meets? the requirement/i.test(finalText);
        if (userVisibleDone && (hasValidation || /验证结果|符合要求|validation result|meets? the requirement/i.test(finalText))) {
            return { shouldContinue: false, reason: '' };
        }
        if (this.isDeliverySummary(finalText)) {
            return { shouldContinue: false, reason: '' };
        }
        if (this.isSubstantialFinalReport(finalText) && (!hasMutation || hasValidation || admitsNoValidation)) {
            return { shouldContinue: false, reason: '' };
        }
        if (round <= 1 && taskComplexity === 'complex' && recentTools.length === 0) {
            return { shouldContinue: true, reason: 'complex Auto task produced a final answer without workspace evidence' };
        }
        if (taskComplexity === 'complex' && recentTools.length > 0 && !hasExploration && round < 4) {
            return { shouldContinue: true, reason: 'complex Auto task needs file exploration before finalizing' };
        }
        if (hasMutation && !hasValidation && !admitsNoValidation) {
            return { shouldContinue: true, reason: 'Auto task appears to have changes but no validation evidence' };
        }
        if (!hasMutation && claimsChanged && taskComplexity === 'complex' && round < 4 && !this.isDeliverySummary(finalText) && !this.isSubstantialFinalReport(finalText)) {
            return { shouldContinue: true, reason: 'complex Auto task claims changes but lacks strong workspace-backed evidence' };
        }
        if (hasMutation && admitsNoValidation && round < Math.min(hardMaxRounds, 6)) {
            return { shouldContinue: true, reason: 'changes were made and validation is still missing' };
        }
        return { shouldContinue: false, reason: '' };
    }
    private buildSelfCheckInstruction(mode: AgentMode, reason: string, finalText: string): ChatMessage {
        return {
            role: 'system',
            content: `[${mode === 'infinite' ? 'Infinite' : 'Auto'} completion gate]
The previous assistant response looked like a final answer, but the completion gate kept the task open: ${reason}.

Previous final draft:
${finalText.slice(0, 1600)}

Continue the task now. Treat the previous final draft as already shown to the user and preserve it unless new evidence proves it wrong. Prefer append-only follow-up: verification results, concrete checks, or a concise correction. Do not retract or rewrite the whole draft just to restate it. Use tools if needed to inspect files, validate changes, or close the missing evidence. Keep user-visible progress concise and in the user's language. Avoid "Let me..." narration; state only the concrete next action. Only produce a final answer after the user requirements, file evidence, and validation status are clear. Do not introduce unrelated topics such as API keys, provider setup, settings.json, endpoint switching, or configuration advice unless the user explicitly asked about configuration or the tool/model actually returned a configuration/authentication error in this turn.`,
        } as any;
    }
    /** Mark a conversation's agent as finished */
    private finishChat(convId?: string): void {
        const id = convId || this.activeId;
        if (id) {
            this.abortControllers.delete(id);
            this.stoppingConversations.delete(id);
            // Reset planConfirmed so next message in plan mode triggers a new plan
            const conv = this.conversations.get(id);
            if (conv?.mode === 'plan' && conv.planConfirmed) {
                conv.planConfirmed = false;
                this.saveConversations();
            }
        }
    }
    /** Check if ANY conversation is running */
    isRunning(): boolean {
        return this.abortControllers.size > 0;
    }
    /** Check if a specific conversation is running */
    isConvRunning(convId: string): boolean {
        return this.abortControllers.has(convId);
    }
    /** Check if a conversation is still occupied by an in-flight chat promise. */
    isConvBusy(convId: string): boolean {
        return this.abortControllers.has(convId) || this.activeChats.has(convId);
    }
    /** Force-clear runtime busy markers after a provider/runtime failure has been surfaced to the UI. */
    releaseConversation(convId: string): void {
        this.finishChat(convId);
        this.activeChats.delete(convId);
    }
    getTokenTracker(): TokenTracker {
        return this.tokenTracker;
    }
    private execGit(args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile('git', args, {
                cwd: this.config.workspace,
                windowsHide: true,
                maxBuffer,
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error((stderr || error.message || '').trim()));
                    return;
                }
                resolve(stdout || '');
            });
        });
    }
    private applyGitPatch(args: string[], patch: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn('git', args, {
                cwd: this.config.workspace,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', chunk => { stderr += String(chunk); });
            child.on('error', reject);
            child.on('close', code => {
                if (code === 0) {
                    resolve();
                }
                else {
                    reject(new Error(stderr.trim() || `git ${args.join(' ')} exited with ${code}`));
                }
            });
            child.stdin.write(patch);
            child.stdin.end();
        });
    }
    private filterNewGitPatchBlocks(previousPatch: string, currentPatch: string): string {
        const splitBlocks = (patch: string): string[] => {
            const normalized = String(patch || '').replace(/\r\n/g, '\n');
            const matches = normalized.match(/^diff --git [\s\S]*?(?=^diff --git |\s*$)/gm);
            return matches ? matches.map(block => block.trim()).filter(Boolean) : [];
        };
        const previous = new Set(splitBlocks(previousPatch).map(block => block.replace(/\s+$/gm, '').trim()));
        return splitBlocks(currentPatch)
            .filter(block => !previous.has(block.replace(/\s+$/gm, '').trim()))
            .join('\n\n');
    }
    private parseGitNumstat(numstat: string): TaskChangeFile[] {
        return numstat
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
            const parts = line.split('\t');
            const addedRaw = parts[0] || '0';
            const removedRaw = parts[1] || '0';
            const filePath = parts.slice(2).join('\t') || '(unknown)';
            const binary = addedRaw === '-' || removedRaw === '-';
            return {
                path: filePath,
                added: binary ? 0 : (parseInt(addedRaw, 10) || 0),
                removed: binary ? 0 : (parseInt(removedRaw, 10) || 0),
                binary,
            };
        });
    }
    private mergeTaskChangeFiles(files: TaskChangeFile[]): TaskChangeFile[] {
        const map = new Map<string, TaskChangeFile>();
        for (const file of files) {
            const existing = map.get(file.path);
            if (!existing) {
                map.set(file.path, { ...file });
                continue;
            }
            existing.added += file.added || 0;
            existing.removed += file.removed || 0;
            existing.binary = existing.binary || file.binary;
            existing.staged = existing.staged || file.staged;
        }
        return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    }
    private isTextBufferForPatch(buffer: Buffer): boolean {
        if (buffer.length === 0)
            return true;
        const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
        let nul = 0;
        for (const byte of sample) {
            if (byte === 0)
                nul++;
        }
        return nul <= sample.length * 0.05;
    }
    private escapeGitPathForPatch(filePath: string): string {
        return filePath.replace(/\\/g, '/').replace(/\t/g, ' ');
    }
    private buildUntrackedFilePatch(filePath: string, content: string): string {
        const safePath = this.escapeGitPathForPatch(filePath);
        const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalized.length ? normalized.split('\n') : [''];
        const addLines = lines.map(line => `+${line}`).join('\n');
        const finalNewline = normalized.endsWith('\n') ? '' : '\n\\ No newline at end of file';
        return [
            `diff --git a/${safePath} b/${safePath}`,
            'new file mode 100644',
            'index 0000000..0000000',
            '--- /dev/null',
            `+++ b/${safePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
            addLines + finalNewline,
        ].join('\n') + '\n';
    }
    private async getUntrackedChangeSummary(existingPaths: Set<string>): Promise<{
        files: TaskChangeFile[];
        patch: string;
        warning?: string;
    }> {
        const output = await this.execGit(['ls-files', '--others', '--exclude-standard', '--', '.'], 1024 * 1024);
        const untracked = output
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .filter(file => !existingPaths.has(file));
        const files: TaskChangeFile[] = [];
        const patches: string[] = [];
        let skipped = 0;
        for (const file of untracked) {
            const fullPath = path.resolve(this.config.workspace, file);
            let buffer: Buffer;
            try {
                const stat = fs.statSync(fullPath);
                if (!stat.isFile())
                    continue;
                buffer = fs.readFileSync(fullPath);
            }
            catch {
                continue;
            }
            if (buffer.length > 512 * 1024 || !this.isTextBufferForPatch(buffer)) {
                skipped++;
                files.push({ path: file, added: 0, removed: 0, binary: true });
                continue;
            }
            const content = buffer.toString('utf8');
            const lineCount = content.length ? content.split(/\r\n|\r|\n/).length : 0;
            files.push({ path: file, added: lineCount, removed: 0, binary: false });
            patches.push(this.buildUntrackedFilePatch(file, content));
        }
        return {
            files,
            patch: patches.join('\n'),
            warning: skipped > 0 ? `${skipped} 个未跟踪的大文件或二进制文件已列入列表，但无法生成可安全撤销的文本 patch。` : undefined,
        };
    }
    async getWorkspaceChangeSummary(): Promise<TaskChangeSummary | null> {
        try {
            await this.execGit(['rev-parse', '--is-inside-work-tree'], 256 * 1024);
            const trackedPatch = await this.execGit(['diff', '--binary', '--', '.']);
            const numstat = await this.execGit(['diff', '--numstat', '--', '.'], 1024 * 1024);
            const stagedPatch = await this.execGit(['diff', '--cached', '--binary', '--', '.']);
            const stagedNumstat = await this.execGit(['diff', '--cached', '--numstat', '--', '.'], 1024 * 1024);
            const unstagedFiles = this.parseGitNumstat(numstat);
            const stagedFiles = this.parseGitNumstat(stagedNumstat).map(file => ({ ...file, staged: true }));
            let files = this.mergeTaskChangeFiles([...unstagedFiles, ...stagedFiles]);
            const existingPaths = new Set(files.map(file => file.path));
            const untracked = await this.getUntrackedChangeSummary(existingPaths);
            files = this.mergeTaskChangeFiles([...files, ...untracked.files]);
            const patch = [trackedPatch.trimEnd(), stagedPatch.trimEnd(), untracked.patch.trimEnd()]
                .filter(Boolean)
                .join('\n');
            if (files.length === 0)
                return null;
            const hasStaged = stagedFiles.length > 0;
            const warnings = [
                hasStaged ? '检测到暂存区改动；Diff 会展示 staged 内容，但无法安全自动撤销暂存状态，请按需手动处理。' : '',
                untracked.warning || '',
            ].filter(Boolean).join('\n');
            return {
                id: `changes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                files,
                totalAdded: files.reduce((sum, file) => sum + file.added, 0),
                totalRemoved: files.reduce((sum, file) => sum + file.removed, 0),
                patch,
                createdAt: Date.now(),
                canUndo: hasStaged || untracked.warning ? false : undefined,
                warning: warnings || undefined,
            };
        }
        catch {
            return null;
        }
    }
    async undoWorkspaceChanges(patch: string): Promise<{
        ok: boolean;
        error?: string;
    }> {
        try {
            if (!patch || patch.length > 8 * 1024 * 1024) {
                return { ok: false, error: 'No reversible patch is available.' };
            }
            await this.applyGitPatch(['apply', '--check', '-R', '--whitespace=nowarn'], patch);
            await this.applyGitPatch(['apply', '-R', '--whitespace=nowarn'], patch);
            return { ok: true };
        }
        catch (e: any) {
            return { ok: false, error: String(e?.message || e).slice(0, 400) };
        }
    }
    // ── Chat ──
    /**

     * Check if input is repeated (same input sent multiple times in short period).

     */
    private isRepeatedInput(input: string, convId: string): boolean {
        const key = `${convId}:${input.trim().toLowerCase()}`;
        const now = Date.now();
        const prev = this.recentInputs.get(key);
        if (prev && now - prev.lastTime < 60000) { // Within 1 minute
            prev.count++;
            prev.lastTime = now;
            if (prev.count >= 3)
                return true; // 3+ times = repeated
        }
        else {
            this.recentInputs.set(key, { count: 1, lastTime: now });
        }
        // Clean up expired records
        for (const [k, v] of this.recentInputs) {
            if (now - v.lastTime > 300000)
                this.recentInputs.delete(k); // 5 min expiry
        }
        return false;
    }
    async chat(userInput: string, events: AgentEvents, images?: Array<{
        dataUrl: string;
        name: string;
        size: number;
    }>, conversationId?: string, skillPrompt?: string): Promise<string> {
        const convId = conversationId || this.activeId;
        const conv = this.conversations.get(convId);
        if (!conv) {
            events.onDone('No active conversation');
            events.onError('No active conversation');
            return 'No active conversation';
        }
        // ── Input boundary checks ──
        // 1. Empty / whitespace-only input
        if (!userInput || /^\s*$/.test(userInput)) {
            events.onToken('请输入您的问题。');
            events.onDone('请输入您的问题。');
            return '请输入您的问题。';
        }
        // 2. Repeated input detection
        if (this.isRepeatedInput(userInput, convId)) {
            const msg = '您已多次发送相同问题。如果您对之前的回答不满意，请尝试换个方式描述，或指出具体哪里有问题。';
            events.onToken(msg);
            events.onDone(msg);
            return msg;
        }
        // 3. Long input truncation
        let processedInput = userInput;
        if (userInput.length > MiMoAgent.MAX_INPUT_LENGTH) {
            const truncated = userInput.substring(0, MiMoAgent.MAX_INPUT_LENGTH);
            const warning = `\n\n⚠️ 输入过长（${userInput.length} 字符），已截断至 ${MiMoAgent.MAX_INPUT_LENGTH} 字符。如需处理完整内容，请分段发送或将文件路径传给 read_file 工具。`;
            processedInput = truncated + warning;
            events.onReasoning(`[Input truncated: ${userInput.length} → ${MiMoAgent.MAX_INPUT_LENGTH} chars]`);
        }
        // 4. Concurrent send prevention
        if (this.activeChats.has(convId)) {
            events.onToken('上一条消息正在处理中，请等待完成后再发送。');
            events.onDone('上一条消息正在处理中，请等待完成后再发送。');
            return '上一条消息正在处理中，请等待完成后再发送。';
        }
        // Wrap chat execution in activeChats tracking
        const chatPromise = this.doChat(processedInput, conv, events, images, convId, skillPrompt);
        this.activeChats.set(convId, chatPromise);
        try {
            return await chatPromise;
        }
        finally {
            this.activeChats.delete(convId);
        }
    }
    /**

     * Internal chat implementation (called by chat() after input validation).

     */
    private async doChat(userInput: string, conv: ConversationState, events: AgentEvents, images?: Array<{
        dataUrl: string;
        name: string;
        size: number;
    }>, convId?: string, skillPrompt?: string): Promise<string> {
        const effectiveConvId = convId || this.activeId;
        const chatStartedAt = Date.now();
        let endpointId = this.getConversationEndpointId(conv);
        let api = this.getApiForEndpoint(endpointId);
        this.traceEvent(conv, 'chat.start', {
            inputChars: userInput.length,
            hasImages: !!images?.length,
            skill: !!skillPrompt,
            existingMessages: conv.messages.length,
            endpointId,
            model: conv.model,
        });
        const emitSystemNote = (note: string) => {
            events.onStatus(note);
        };
        // Reload system prompt each turn — picks up MIMO.md changes without restart
        this.systemPrompt = buildSystemPrompt(this.config.workspace);
        this.personalizedInstructions = loadInstructions(this.config.workspace);
        // Validate personalized instructions and warn user about issues
        if (this.personalizedInstructions) {
            const validation = validateInstructions(this.personalizedInstructions);
            if (validation.errors.length > 0) {
                events.onReasoning(`[⚠️ 指令问题] ${validation.errors.join(' | ')}`);
            }
            if (validation.warnings.length > 0) {
                events.onReasoning(`[⚠️ 指令警告] ${validation.warnings.join(' | ')}`);
            }
        }
        // Persist skill prompt in conversation state for follow-up turns
        if (skillPrompt) {
            conv.activeSkillPrompt = skillPrompt;
        }
        if (!this.config.apiKey) {
            const errorMsg = 'API key is not configured. Set "mimo.apiKey" in VS Code settings, set MIMO_API_KEY, or add api.api_key to ~/.mimo/settings.json.';
            events.onDone(errorMsg);
            events.onError(errorMsg);
            return errorMsg;
        }
        // Some configured models are not usable for normal text chat on the chat endpoint.
        const activeCaps = this.getModelCapabilities(conv.model);
        if (activeCaps.tts || this.isKnownUnsupportedChatModel(conv.model)) {
            const fallbackModel = this.findChatModel(conv.model, true, endpointId);
            if (!fallbackModel || fallbackModel === conv.model) {
                const msg = `Current model "${conv.model}" cannot be used for chat on this endpoint. Switch to a chat model such as mimo-v2.5-pro.`;
                events.onDone(msg);
                events.onError(msg);
                return msg;
            }
            const oldModel = conv.model;
            conv.model = fallbackModel;
            conv.modelEndpointId = endpointId;
            emitSystemNote(`Model auto-switched: ${oldModel} -> ${fallbackModel} for chat`);
            events.onStatus(`Model auto-switched to ${fallbackModel} for chat`);
            events.onModelSwitched?.(this.encodeModelRoute(endpointId, fallbackModel), 'chat');
            api = this.getApiForEndpoint(endpointId);
            this.saveConversations();
        }
        // Clear any stale stopping state before any model call in this turn.
        this.stoppingConversations.delete(effectiveConvId);
        const abortController = new AbortController();
        this.abortControllers.set(effectiveConvId, abortController);
        const signal = abortController.signal;
        // If the selected model is text-only, analyze newly attached images with a
        // vision fallback and feed the text result back into the selected model.
        let imageTextContext = '';
        if (images && images.length > 0 && !this.getModelCapabilities(conv.model).vision) {
            const visionModel = this.findVisionModel(conv.model, endpointId);
            if (!visionModel) {
                const msg = `Current model "${conv.model}" is not known to support images, and no vision-capable MiMo fallback model is available for image analysis. Add mimo-v2.5 to this endpoint or switch models before sending images.`;
                events.onDone(msg);
                events.onError(msg);
                return msg;
            }
            try {
                events.onStatus(`Analyzing image with ${visionModel}...`);
                imageTextContext = await this.analyzeImagesForTextContext(images, conv, endpointId, signal);
                events.onReasoning(`[Image context] Analyzed ${images.length} image${images.length === 1 ? '' : 's'} with ${visionModel}; continuing with ${conv.model}.`);
            } catch (e: any) {
                const msg = `Image analysis failed before sending to "${conv.model}": ${String(e?.message || e)}`;
                events.onDone(msg);
                events.onError(msg);
                return msg;
            }
        }
        // Adversarial mode: dual-brain execution
        if (conv.mode === 'adversarial') {
            return this.adversarialChat(
                imageTextContext ? this.buildTextOnlyContentFromImages(userInput, imageTextContext) : userInput,
                events,
                imageTextContext ? undefined : images,
                effectiveConvId,
            );
        }
        // Build user message content (with optional images)
        let userContent: string | ContentPart[];
        if (imageTextContext) {
            userContent = this.buildTextOnlyContentFromImages(userInput, imageTextContext);
        }
        else if (images && images.length > 0) {
            userContent = [{ type: 'text', text: userInput }];
            for (const img of images) {
                userContent.push({ type: 'image_url', image_url: { url: img.dataUrl } });
            }
        }
        else {
            userContent = userInput;
        }
        console.log(`[MiMo chat] Starting: convId=${effectiveConvId}, existing messages=${conv.messages.length}`);
        const userMessage: ChatMessage = { role: 'user', content: userContent };
        if (imageTextContext && images?.length) {
            userMessage._uiImages = images.map(image => ({
                dataUrl: image.dataUrl,
                name: image.name,
                size: image.size,
            }));
        }
        conv.messages.push(userMessage);
        // ── Greeting / trivial input detection: shortcuts for all modes ──
        // Run BEFORE persona detection to avoid wasting CPU on trivial inputs
        const _input = userInput.trim();
        const _lower = _input.toLowerCase();
        const PURE_GREETINGS = ['hi', 'hello', 'hey', '你好', '嗨', '哈喽', 'ok', '好的', '嗯', '收到', '谢谢', 'thx', 'thanks'];
        let forceContinuePendingAction = this.hasPendingActionStatement(conv);
        const isTrivial = PURE_GREETINGS.includes(_lower) || // exact greeting match
            _input.length <= 3 || // very short: "?", "？", "hi!", "ok"
            /^[!?！？。，、.\-~～…]+$/.test(_input) || // pure punctuation
            /^[\p{Emoji}\s]+$/u.test(_input); // pure emoji
        if (isTrivial && !forceContinuePendingAction) {
            return this.handleDirectResponse(userInput, conv, events, signal, effectiveConvId);
        }
        // Detect expert persona with conversation-level persistence
        // Strategy: re-detect each turn. If no strong signal, keep the previous persona.
        // Detect persona: always allow specific triggers (debug, review, architecture, refactor)
        // Only skip persisted persona fallback for generic analytical tasks
        const isComplexOrAnalytical = /分析|对比|差距|比较|评估|评价/i.test(userInput);
        let persona = detectPersona(userInput);
        if (persona) {
            // New strong signal → switch persona and persist
            conv.personaId = persona.id;
            events.onReasoning(`[Role: ${persona.icon} ${persona.nameZh}]`);
        }
        else if (!isComplexOrAnalytical && conv.personaId) {
            // No strong signal → fall back to persisted persona from earlier turn
            // (skip if input is complex/analytical — don't distract the model)
            const persisted = getPersona(conv.personaId);
            if (persisted) {
                persona = persisted;
                events.onReasoning(`[Role: ${persisted.icon} ${persisted.nameZh} (continued)]`);
            }
        }
        // ── Intent Router: classify before tool loop (Auto mode only) ──
        // Plan/Polling/Adversarial modes skip routing — user already chose the mode.
        let taskComplexity: 'simple' | 'moderate' | 'complex' = 'moderate';
        let routedIntent: IntentResult | null = null;
        try {
            if (conv.mode === 'auto') {
                events.onStatus('分析意图...');
                const quickIntent = quickClassifyIntent(userInput);
                const intent = quickIntent || await classifyIntent(api, userInput, conv.model, signal);
                routedIntent = intent;
                this.traceEvent(conv, 'router.intent', {
                    category: intent.category,
                    needsTools: intent.needsTools,
                    complexity: intent.complexity || 'moderate',
                    source: intent.source || (quickIntent ? 'heuristic' : 'model'),
                });
                events.onReasoning(`[意图: ${intent.category}] ${intent.needsTools ? '需要工具' : '直接回答'} — ${intent.plan}`);
                if (intent.source === 'heuristic') {
                    events.onReasoning('[Router] Used local fast-path classification');
                }
                // Capture complexity for dynamic round budget
                if (intent.complexity) {
                    taskComplexity = intent.complexity;
                }
                const forceToolEvidence = this.shouldForceToolBackedAnswer(userInput, conv);
                if (forceToolEvidence) {
                    const evidenceSpecific = requiresToolEvidence(userInput);
                    routedIntent = {
                        ...intent,
                        needsTools: true,
                        category: evidenceSpecific ? 'search' : (intent.category === 'question' ? 'debug' : intent.category),
                        plan: evidenceSpecific
                            ? 'Gather tool/source evidence before answering the verification question'
                            : 'Gather workspace/tool evidence before answering',
                        complexity: intent.complexity || (evidenceSpecific ? 'moderate' : 'complex'),
                        suggestedPersona: intent.suggestedPersona || (evidenceSpecific ? 'analyst' : 'debugger'),
                    };
                    taskComplexity = routedIntent.complexity || 'moderate';
                    events.onReasoning(evidenceSpecific
                        ? '[Completion gate] This question asks for verification evidence; continuing with tools before answering.'
                        : '[Completion gate] This question needs workspace/tool evidence; continuing with tools before answering.');
                }
                // Apply router's suggested persona
                // Priority: router's LLM suggestion > keyword detection
                // (router uses full LLM context analysis, keyword is just substring matching)
                const personaIntent = routedIntent || intent;
                if (personaIntent.suggestedPersona) {
                    const suggested = getPersona(personaIntent.suggestedPersona);
                    if (suggested) {
                        if (!persona) {
                            // No keyword match — use router's suggestion
                            persona = suggested;
                            conv.personaId = suggested.id;
                            events.onReasoning(`[Role: ${suggested.icon} ${suggested.nameZh} (suggested)]`);
                        }
                        else if (persona.id !== suggested.id) {
                            // Keyword and router disagree — prefer router (LLM is more accurate)
                            persona = suggested;
                            conv.personaId = suggested.id;
                            events.onReasoning(`[Role: ${suggested.icon} ${suggested.nameZh} (router override)]`);
                        }
                        // If they agree, keep the keyword-detected persona (no change)
                    }
                }
                // If no tools needed: simple text-only response (with persona)
                if (!intent.needsTools && !forceContinuePendingAction && !forceToolEvidence) {
                    return this.handleDirectResponse(userInput, conv, events, signal, effectiveConvId, persona);
                }
                if (!intent.needsTools && forceContinuePendingAction) {
                    taskComplexity = 'moderate';
                    events.onReasoning('[Completion gate] Previous response announced a tool-backed step but did not execute it; continuing with tools.');
                }
            }
        }
        catch (e: any) {
            // Ensure cleanup on classifyIntent or handleDirectResponse exception
            if (this.isStopping(effectiveConvId, signal)) {
                events.onDone('(stopped by user)');
            }
            else {
                const friendlyError = this.friendlyRouteError(e, conv, endpointId);
                events.onDone(friendlyError);
                this.emitTerminalApiError(events, friendlyError, conv, endpointId);
            }
            this.finishChat(effectiveConvId);
            return `(error: ${e.message})`;
        }
        // Max Rounds: 0 means no round budget. Stall and loop guards still protect
        // the extension from repeated no-progress work.
        const COMPLEXITY_ROUNDS = { simple: 10, moderate: 30, complex: 50 };
        const MIN_AUTO_ROUND_BUDGET = 200;
        const MIN_AUTO_STOP_GUARD_ROUND = 200;
        const rawConfiguredMaxRounds = conv.mode === 'infinite'
            ? this.getInfiniteSoftMaxRounds()
            : Math.floor(this.config.maxRounds ?? 0);
        const unlimitedRounds = conv.mode !== 'infinite' && rawConfiguredMaxRounds <= 0;
        const configuredMaxRounds = unlimitedRounds
            ? Number.MAX_SAFE_INTEGER
            : Math.max(conv.mode === 'auto' ? MIN_AUTO_ROUND_BUDGET : 1, rawConfiguredMaxRounds);
        const suggestedRounds = COMPLEXITY_ROUNDS[taskComplexity] || 30;
        const SOFT_MAX_ROUNDS = configuredMaxRounds;
        const HARD_MAX_ROUNDS = conv.mode === 'infinite'
            ? Math.max(SOFT_MAX_ROUNDS + 10, Math.ceil(SOFT_MAX_ROUNDS * this.getInfiniteHardMultiplier()))
            : unlimitedRounds
                ? Number.MAX_SAFE_INTEGER
                : Math.max(SOFT_MAX_ROUNDS + 10, SOFT_MAX_ROUNDS * 3, suggestedRounds * 2);
        const STALL_LIMIT = conv.mode === 'infinite' ? this.getInfiniteStallLimit() : (conv.mode === 'auto' ? 12 : 3);
        const POST_BUDGET_STALL_LIMIT = conv.mode === 'infinite' ? Math.max(2, Math.ceil(STALL_LIMIT / 2)) : STALL_LIMIT;
        if (taskComplexity !== 'moderate') {
            events.onReasoning(unlimitedRounds
                ? `[Complexity: ${taskComplexity}; suggested ${suggestedRounds}, round budget unlimited]`
                : `[Complexity: ${taskComplexity}; suggested ${suggestedRounds}, soft budget ${SOFT_MAX_ROUNDS}, hard cap ${HARD_MAX_ROUNDS} rounds]`);
        }
        else {
            events.onReasoning(unlimitedRounds
                ? `[Round budget: unlimited]`
                : `[Round budget: soft ${SOFT_MAX_ROUNDS}, hard cap ${HARD_MAX_ROUNDS} rounds]`);
        }
        const ROUND_TIMEOUT_MS = this.getRoundTimeoutMs(conv, taskComplexity);
        let reasoningLoopCount = 0; // Track consecutive reasoning loops
        let consecutiveRateRetries = 0;
        let stallRounds = 0;
        let readonlyOnlyRounds = 0;
        let progressRecoveryPrompts = 0;
        let stopReason = '达到硬安全上限';
        let stopRound = HARD_MAX_ROUNDS;
        const memoryToolObservations: ToolObservation[] = [];
        for (let round = 1; round <= HARD_MAX_ROUNDS; round++) {
            if (this.isStopping(effectiveConvId, signal)) {
                events.onDone('(stopped by user)');
                this.finishChat(effectiveConvId);
                return '(stopped by user)';
            }
            const roundStartTime = Date.now();
            this.traceEvent(conv, 'round.start', {
                round,
                hardMaxRounds: HARD_MAX_ROUNDS,
                softMaxRounds: SOFT_MAX_ROUNDS,
                stallRounds,
            });
            events.onRoundStart(round);
            const roundNarration = this.buildRoundNarration(round, taskComplexity, conv, stallRounds, SOFT_MAX_ROUNDS, HARD_MAX_ROUNDS, unlimitedRounds);
            events.onStatus(this.buildRoundStatus(round, conv));
            events.onReasoning(roundNarration);
            let systemContent = persona
                ? buildPersonaPrompt(this.systemPrompt, persona)
                : this.systemPrompt;
            systemContent += `\n\n## Runtime Language Discipline\n${this.languageInstruction(userInput, conv)}`;
            if (routedIntent) {
                systemContent += `\n\n## Routed Message Handling\nCategory: ${routedIntent.category}\nNeeds tools: ${routedIntent.needsTools ? 'yes' : 'no'}\nComplexity: ${routedIntent.complexity || taskComplexity}\nPlan: ${routedIntent.plan || 'Proceed according to the message handling policy.'}`;
                if (routedIntent.complexity === 'complex') {
                    systemContent += `\n\nFor this complex task, first build a systematic execution framework: goal, acceptance criteria, affected modules, execution order, and validation points. Then execute phase by phase and validate key steps. Do not jump into scattered edits.`;
                }
                if (routedIntent.category === 'feedback') {
                    systemContent += `\n\nFeedback handling: acknowledge the reported behavior, decide whether it is expected or a bug, attribute it to Agent/model/API/environment/user operation with evidence, and fix Agent/UI logic when appropriate.`;
                }
                else if (routedIntent.category === 'preference') {
                    systemContent += `\n\nPreference/rule handling: treat the message as an operating rule. If the user asked to save or implement it, update the relevant prompt/router/error/UI/tool code or documentation, then validate.`;
                }
                else if (routedIntent.category === 'experience') {
                    systemContent += `\n\nProduct reliability handling: analyze user-visible symptoms, system facts, trust impact, and engineering fixes. Avoid blaming the foundation model unless evidence points there.`;
                }
                else if (routedIntent.category === 'context') {
                    systemContent += `\n\nSupplemental context handling: merge the new evidence into the current task and update the diagnosis. Do not restart from scratch unless the evidence invalidates prior assumptions.`;
                }
                else if (routedIntent.category === 'acknowledgement') {
                    systemContent += `\n\nAcknowledgement handling: bind this short confirmation to the most recent pending plan, preview, permission, or recovery context before treating it as a new request.`;
                }
                if (requiresToolEvidence(userInput)) {
                    systemContent += `\n\nEvidence verification handling: this user message asks whether a claim was actually verified, sourced, fetched, or tool/API-backed. First inspect recent tool evidence and, when an external source is named, use fetch_url or web_search if available. Final answer must clearly distinguish prior evidence from any new verification performed in this turn. Do not end with only an offer to verify later.`;
                }
                else if (requiresToolBackedAnswer(userInput)) {
                    systemContent += `\n\nTool-backed answer handling: this user message asks about current workspace/product state, root cause, validation, debugging, performance, UI behavior, files, git/diff, or another evidence-dependent topic. Do not answer from memory alone. Use the relevant read/search/git/web/validation tools first, then answer with the evidence and any remaining uncertainty.`;
                }
            }
            systemContent = this.appendMemoryPrompt(systemContent, userInput);
            if (this.isGitPushDeliveryRequest(userInput)) {
                systemContent += `\n\n[Git delivery convergence]

For explicit git commit/push requests, stop as soon as the commit/push delivery is verified. Evidence such as "Everything up-to-date", a clean working tree, "Your branch is up to date with", or a remote log containing the commit is enough to finalize. Do not keep repeating git status/log/diff checks after delivery is verified.`;
            }
            // Inject active skill prompt into system content (not user message)
            if (conv.activeSkillPrompt) {
                systemContent += `\n\n## Active Skill\n${conv.activeSkillPrompt}`;
            }
            if (forceContinuePendingAction) {
                systemContent += `\n\n[Pending action recovery]\nThe previous assistant message announced an inspection/read/list/search step but no tool was executed. Continue that prior task now. Do not answer with another promise to inspect; call the appropriate file/search/directory tool first, then complete the user's requested output.`;
                forceContinuePendingAction = false;
            }
            let toolChoice: string | undefined = 'auto';
            let tools: typeof TOOL_DEFINITIONS | undefined = TOOL_DEFINITIONS;
            // Merge MCP tools with built-in tools
            const mcpTools = this.mcpManager.getAllToolDefinitions();
            if (mcpTools.length > 0) {
                tools = [...(tools || []), ...mcpTools];
            }
            // Plan mode: skip plan for greetings / simple chat — respond directly
            if (conv.mode === 'plan' && !conv.planConfirmed) {
                const _trimmed = userInput.trim().toLowerCase();
                const GREETINGS = ['hi', 'hello', 'hey', '你好', '嗨', '哈喽', 'ok', '好的', '嗯', '收到', '谢谢', 'thx', 'thanks'];
                if (GREETINGS.includes(_trimmed) || userInput.trim().length <= 5) {
                    return this.handleDirectResponse(userInput, conv, events, signal, effectiveConvId, persona);
                }
            }
            if (conv.mode === 'plan' && !conv.planConfirmed) {
                // Plan mode, phase 1: Analyze + output plan, read-only + web search tools
                tools = TOOL_DEFINITIONS.filter(t => ['schedule_tasks', 'update_todos',
                    'read_file', 'search_files', 'glob_files', 'list_directory',
                    'get_file_info', 'git_status', 'git_diff', 'git_log',
                    'web_search', 'fetch_url', 'ask_user'].includes(t.function.name));
                toolChoice = 'auto';
                systemContent += PLAN_MODE_ANALYSIS_GUIDANCE;
            }
            else if (conv.mode === 'plan' && conv.planConfirmed) {
                // Plan mode, phase 2: Execute the plan
                systemContent += PLAN_MODE_EXECUTION_GUIDANCE;
            }
            else if (conv.mode === 'polling') {
                systemContent += `\n\n[Mode: Polling] 轮询模式 — 自主执行，但保持透明。



执行原则：

- 每完成一个逻辑步骤，输出进度（不需要用户确认）

- 文件编辑会显示预览供用户审核

- 遇到需要用户决策的分支点时，使用 ask_user 工具暂停并询问

- 最终输出完整的工作报告（改了什么、为什么、验证结果）`;
            }
            else if (conv.mode === 'infinite') {
                systemContent += `\n\n[Mode: Infinite] 无限模式 — 高预算连续执行与自我校验。



目标：用更多小步工具调用、持续复盘和验证，弥补模型单次判断能力不足。



执行原则：

- 不要套用 Auto 的短流程；复杂任务允许多轮探索、修改、验证和复查。

- 先建立文件认知：阅读入口文件、相关依赖、配置、测试和历史改动，不要只看一个片段就下结论。

- 保持一份隐式任务清单：需求、已读文件、已改文件、验证结果、未完成风险。

- 每轮只做少量具体动作，读到证据后再修改，修改后尽快验证。

- 如果上下文里出现 [Auto Context Summary]，把它当作压缩后的长期记忆，与最近原文共同使用。

- 不要因为一次模型回答看似完整就收尾；收尾前必须自查：

  1. 用户要求是否逐条覆盖；

  2. 关键文件是否读过；

  3. 代码改动是否验证过，或明确说明无法验证的原因；

  4. 是否还有明显 TODO、报错、失败测试或未处理边界。

- 只有满足上述条件后，才输出最终总结。否则继续调用工具推进。`;
            }
            else {
                // Auto mode (default)
                systemContent += `\n\n[Mode: Auto] 自动模式 — 高效执行。



节奏：理解 → 实现 → 验证 → 总结

- 快速理解需求（读 1-3 个关键文件）

- 直接动手实现（不要过度规划）

- 每步验证（改完就测）

- 简洁总结（说了就停）

每个阶段不超过 2 轮工具调用。`;
            }
            if (!this.canPauseForUserDecision(conv)) {
                tools = this.withoutUserPauseTools(tools);
                systemContent += `\n\n[Autonomous decision policy]

Do not ask the user for clarification or confirmation during this run. If a choice is needed, infer intent from the request, repository context, and recent conversation. Choose the safest reversible path that best satisfies the user, state the assumption briefly, continue execution, and verify the result.`;
            }
            // Apply persistent context memory first, then per-call context management.
            await this.ensureContextMemory(conv, taskComplexity, systemContent, events, signal);
            const contextSourceMessages = this.buildRuntimeContextMessages(conv);
            const preStats = getContextStats(contextSourceMessages, conv.model, systemContent.length);
            let managedMessages: ChatMessage[];
            if (this.shouldUseSummarization(contextSourceMessages, conv.model, taskComplexity, systemContent.length)) {
                events.onReasoning(`[上下文：压缩前估算 ${preStats.percent}%，正在摘要压缩...]`);
                try {
                    managedMessages = await summarizeContext(contextSourceMessages, api, conv.model, {}, signal);
                }
                catch (e: any) {
                    events.onReasoning(`[上下文压缩失败：${String(e?.message || e).slice(0, 120)}。改用滑动窗口。]`);
                    managedMessages = manageContext(contextSourceMessages, conv.model);
                }
            }
            else {
                managedMessages = manageContext(contextSourceMessages, conv.model);
            }
            // Safety: if still over budget after compression, force sliding window
            const postStats = getContextStats(managedMessages, conv.model, systemContent.length);
            if (postStats.percent > 88) {
                events.onReasoning(`[上下文：压缩后估算 ${postStats.percent}% 仍偏高，启用滑动窗口...]`);
                managedMessages = manageContext(managedMessages, conv.model);
            }
            const params: Record<string, any> = this.buildChatParams(conv.model, [
                { role: 'system' as const, content: systemContent },
                ...managedMessages,
            ], {}, endpointId);
            // Log context usage
            const stats = getContextStats(managedMessages, conv.model, systemContent.length);
            if (stats.percent > 70) {
                events.onReasoning(`[上下文：当前估算 ${stats.percent}%（约 ${stats.used}/${stats.total} tokens）]`);
            }
            if (tools)
                params.tools = tools;
            if (toolChoice)
                params.tool_choice = toolChoice;
            let content: string;
            let toolCalls: ToolCall[];
            let reasoningContent = '';
            let reasoningBuffer = '';
            let reasoningWasTrimmed = false;
            const MAX_REASONING_CAPTURE_CHARS = 60000;
            let lastDetectionLen = 0; // throttle: only re-check every 300+ chars
            let reasoningLoopDetected = false; // guard: prevent multiple abort triggers
            let loopAbortController: AbortController | null = null;
            try {
                loopAbortController = new AbortController();
                signal.addEventListener('abort', () => loopAbortController?.abort(), { once: true });
                const result = await api.chatCompletionsStream(params, {
                    onToken: (t) => events.onToken(t),
                    onReasoning: (t) => {
                        // Guard: stop processing after loop detection to avoid duplicate triggers
                        if (reasoningLoopDetected)
                            return;
                        reasoningContent += t;
                        if (reasoningContent.length > MAX_REASONING_CAPTURE_CHARS) {
                            reasoningContent = reasoningContent.slice(-MAX_REASONING_CAPTURE_CHARS);
                            reasoningWasTrimmed = true;
                            lastDetectionLen = Math.min(lastDetectionLen, reasoningContent.length);
                        }
                        reasoningBuffer += t;
                        // Reasoning loop detection: throttled to every 200+ chars
                        // Lower threshold catches loops faster before they waste tokens
                        if (reasoningContent.length - lastDetectionLen > 200 && reasoningContent.length > 300) {
                            lastDetectionLen = reasoningContent.length;
                            const loop = this.detectReasoningLoop(reasoningContent);
                            if (loop.detected) {
                                reasoningLoopDetected = true;
                                loopAbortController?.abort();
                                events.onReasoning(`\n\n⚠️ 检测到推理循环（重复 ${loop.count} 次），已自动中断。`);
                                reasoningBuffer = '';
                                return;
                            }
                        }
                        // Only emit reasoning in coarse chunks. Fine-grained updates make
                        // the webview main thread hard to use during long thinking streams.
                        // Turbo mode: flush faster since thinking is disabled, content is minimal.
                        const _effort = this.config.reasoningEffort;
                        const _flushThreshold = _effort === 'turbo' ? 200 : _effort === 'fast' ? 600 : 1_200;
                        if (reasoningBuffer.length > _flushThreshold) {
                            events.onReasoning(reasoningBuffer);
                            reasoningBuffer = '';
                        }
                    },
                }, loopAbortController.signal);
                // Flush remaining reasoning buffer
                if (reasoningBuffer) {
                    events.onReasoning(reasoningBuffer);
                    reasoningBuffer = '';
                }
                content = result.content;
                toolCalls = result.toolCalls;
                if (result.reasoningContent) {
                    if (result.toolCalls.length > 0) {
                        reasoningContent = result.reasoningContent;
                        reasoningWasTrimmed = false;
                    }
                    else {
                        reasoningContent = result.reasoningContent.length > MAX_REASONING_CAPTURE_CHARS
                            ? result.reasoningContent.slice(-MAX_REASONING_CAPTURE_CHARS)
                            : result.reasoningContent;
                        reasoningWasTrimmed = reasoningWasTrimmed || result.reasoningContent.length > MAX_REASONING_CAPTURE_CHARS;
                    }
                }
                // Track token usage (API usage or estimate)
                if (result.usage) {
                    const callRecord = {
                        id: `call_${Date.now()}`,
                        convId: this.activeId,
                        model: conv.model,
                        round,
                        usage: result.usage,
                        timestamp: Date.now(),
                        elapsed: 0,
                    };
                    this.tokenTracker.addCall(callRecord);
                    recordTokenUsage(result.usage);
                    events.onTokenUsage?.(result.usage);
                }
                else {
                    // Fallback: estimate tokens when API doesn't return usage
                    const estTokens = Math.ceil(((content || '').length + reasoningContent.length) / 3);
                    if (estTokens > 0) {
                        events.onTokenUsage?.({ promptTokens: 0, completionTokens: estTokens, totalTokens: estTokens });
                    }
                }
            }
            catch (e: any) {
                // Reasoning loop detected — inject guidance and retry
                if (reasoningLoopDetected) {
                    this.clearInternalStop(effectiveConvId);
                    reasoningLoopCount++;
                    const gitPushDone = this.detectGitPushDeliveryComplete(conv, userInput);
                    if (gitPushDone.done && gitPushDone.summary) {
                        return this.finishWithLocalSummary(conv, userInput, gitPushDone.summary, events, memoryToolObservations, effectiveConvId, 'git_push_delivery.done_after_reasoning_loop', { round, loopCount: reasoningLoopCount, reason: gitPushDone.reason });
                    }
                    // Remove incomplete assistant message if it was pushed (safety check)
                    const lastMsg = conv.messages[conv.messages.length - 1];
                    if (lastMsg?.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                        conv.messages.pop();
                    }
                    // 第一次循环：注入强引导，告诉模型立即执行
                    if (reasoningLoopCount === 1) {
                        conv.messages.push({
                            role: 'system',
                            content: '[紧急指令] 检测到推理循环。立即停止重新规划！基于当前工作区状态，直接输出最终结果或执行一个具体工具调用。不要解释，不要分析，直接行动。',
                        } as any);
                        events.onReasoning(`\n\n[Recovery] Reasoning loop detected once. Injected execute-now guidance.`);
                        round--; // Re-run this round
                        continue;
                    }
                    // 第二次循环：保存工作状态，新建模型调用继续
                    if (reasoningLoopCount === 2) {
                        events.onReasoning(`\n\n[Recovery] Reasoning loop repeated. Switching to a fresh model call.`);
                        // 保存当前已完成的工作摘要
                        const progressSummary = this.buildUserFacingProgressSummary(conv, 'reasoning loop recovery');
                        // 新建一个独立的模型调用来继续任务
                        const continuationResult = await this.continueWithFreshModel(conv, progressSummary, events);
                        if (continuationResult) {
                            const cleanedContinuation = stripInternalHandoffNoise(continuationResult) || this.buildUserFacingProgressSummary(conv, 'recovered from reasoning loop');
                            conv.messages.push({
                                role: 'assistant',
                                content: cleanedContinuation,
                            });
                            events.onToken(cleanedContinuation);
                            events.onDone(cleanedContinuation);
                            this.finishChat(effectiveConvId);
                            return cleanedContinuation;
                        }
                        // 如果新模型调用也失败，输出进度总结
                        events.onReasoning(`\n\n[Recovery] Fresh model call failed. Returning current progress summary.`);
                        const fallback = this.buildUserFacingProgressSummary(conv, 'loop recovery failed');
                        this.learnFromCompletedTurn(userInput, fallback, events, memoryToolObservations);
                        conv.messages.push({ role: 'assistant', content: fallback });
                        this.saveConversations();
                        events.onDone(fallback);
                        this.finishChat(effectiveConvId);
                        return fallback;
                    }
                    // 第三次及以上循环：强制退出
                    events.onReasoning(`\n\n[Recovery] Reasoning loop repeated ${reasoningLoopCount} times. Returning current progress summary.`);
                    const fallback = this.buildUserFacingProgressSummary(conv, 'reasoning loop detected repeatedly');
                    this.learnFromCompletedTurn(userInput, fallback, events, memoryToolObservations);
                    conv.messages.push({ role: 'assistant', content: fallback });
                    this.saveConversations();
                    events.onDone(fallback);
                    this.finishChat(effectiveConvId);
                    return fallback;
                }
                if (this.isStopping(effectiveConvId, signal)) {
                    events.onDone('(stopped by user)');
                    this.finishChat(effectiveConvId);
                    return '(stopped by user)';
                }
                // 429 rate limit — wait and retry (max 3 times per round)
                const errorMessage = String(e?.message || e || '');
                const maxTokensParamInvalid = /API error\s+400|invalid_request_error|field\s+MaxTokens\s+invalid|param["']?\s*:\s*["']?max_tokens|max_tokens/i.test(errorMessage)
                    && /invalid|should be in|must be|range|too large|exceed/i.test(errorMessage)
                    && !/context|too long/i.test(errorMessage);
                if (maxTokensParamInvalid) {
                    const limit = 65536;
                    const hint = this.isMimoRoute(conv, endpointId)
                        ? this.friendlyRouteError(e, conv, endpointId)
                        : `Model/API rejected max_tokens. Current configured max_tokens is ${this.config.maxTokens}; set Generation > Max Tokens to ${limit} or lower, then retry.`;
                    const summary = `${this.buildProgressSummary(conv, 'model generation parameter rejected by provider', {
                        round,
                        maxRounds: HARD_MAX_ROUNDS,
                        softMaxRounds: SOFT_MAX_ROUNDS,
                    })}
${hint}`;
                    this.learnFromCompletedTurn(userInput, summary, events, memoryToolObservations);
                    events.onDone(summary);
                    this.emitTerminalApiError(events, hint, conv, endpointId);
                    const lastMsg = conv.messages[conv.messages.length - 1];
                    if (lastMsg?.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                        conv.messages.pop();
                    }
                    this.finishChat(effectiveConvId);
                    return summary;
                }
                if (e.message?.includes('429')) {
                    consecutiveRateRetries++;
                    if (consecutiveRateRetries > 3) {
                        const summary = this.buildProgressSummary(conv, 'rate limited too many times', {
                            round,
                            maxRounds: HARD_MAX_ROUNDS,
                            softMaxRounds: SOFT_MAX_ROUNDS,
                        });
                        this.learnFromCompletedTurn(userInput, summary, events, memoryToolObservations);
                        events.onDone(summary);
                        this.emitTerminalApiError(events, this.friendlyRouteError(e, conv, endpointId), conv, endpointId);
                        this.finishChat(effectiveConvId);
                        return summary;
                    }
                    const waitSec = Math.min(15, 2 * consecutiveRateRetries + 1);
                    events.onReasoning(`[Rate limited, waiting ${waitSec}s...]`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                    round--; // Repeat this round
                    continue;
                }
                if (/Request timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|unexpected end of data|aborted before complete/i.test(String(e?.message || e))
                    && consecutiveRateRetries < 2
                    && !this.isStopping(effectiveConvId, signal)) {
                    consecutiveRateRetries++;
                    const waitSec = 2 + consecutiveRateRetries * 2;
                    events.onReasoning(`[连接恢复] ${String(e?.message || e).slice(0, 120)}。${waitSec}s 后重试本轮。`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                    round--;
                    continue;
                }
                // Don't retry if user clicked stop
                if (this.isStopping(effectiveConvId, signal)) {
                    events.onDone('(stopped by user)');
                    this.finishChat(effectiveConvId);
                    return '(stopped by user)';
                }
                // Context overflow — try aggressive compression
                if (this.isModelUnsupportedError(e)) {
                    const fallbackRoute = this.findFallbackRouteForChat(conv.model, endpointId);
                    if (fallbackRoute) {
                        const oldModel = conv.model;
                        const oldEndpointId = endpointId;
                        endpointId = fallbackRoute.endpointId;
                        conv.model = fallbackRoute.model;
                        conv.modelEndpointId = endpointId;
                        api = this.getApiForEndpoint(endpointId);
                        this.saveConversations();
                        const routeNote = endpointId && endpointId !== oldEndpointId ? ` via ${endpointId}` : '';
                        events.onReasoning(`[Model fallback] ${oldModel} is not usable for chat on this endpoint. Switched to ${fallbackRoute.model}${routeNote} and retrying.`);
                        events.onStatus(`Model auto-switched to ${fallbackRoute.model} for chat`);
                        events.onModelSwitched?.(this.encodeModelRoute(endpointId, fallbackRoute.model), 'chat');
                        const lastMsg = conv.messages[conv.messages.length - 1];
                        if (lastMsg?.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                            conv.messages.pop();
                        }
                        round--;
                        continue;
                    }
                    const configured = this.getModelList().join(', ');
                    const hint = `Current model: ${conv.model}. Check that this model exists on the configured baseUrl, that the API key has access, and that api.models is configured correctly. Available configured models: ${configured || '(none)'}.`;
                    const friendlyHint = this.isMimoRoute(conv, endpointId)
                        ? `${this.friendlyRouteError(e, conv, endpointId)}\n\n当前配置：model=${conv.model}; baseUrl=${this.getEndpointBaseUrl(endpointId)}; 已配置模型=${configured || '(none)'}`
                        : `Model error: ${hint}`;
                    const summary = `${this.buildProgressSummary(conv, 'model access or compatibility error', {
                        round,
                        maxRounds: HARD_MAX_ROUNDS,
                        softMaxRounds: SOFT_MAX_ROUNDS,
                    })}
${friendlyHint}`;
                    this.learnFromCompletedTurn(userInput, summary, events, memoryToolObservations);
                    events.onDone(summary);
                    this.emitTerminalApiError(events, friendlyHint, conv, endpointId);
                    const lastMsg = conv.messages[conv.messages.length - 1];
                    if (lastMsg?.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                        conv.messages.pop();
                    }
                    this.finishChat(effectiveConvId);
                    return summary;
                }
                if (e.message?.includes('context') || e.message?.includes('too long') || e.message?.includes('max_tokens')) {
                    events.onReasoning(`[Context overflow] Compressing long-term memory and retrying this round...`);
                    if (conv.messages.length > 12) {
                        const compressed = await this.ensureContextMemory(conv, taskComplexity, systemContent, events, signal, true);
                        if (!compressed) {
                            const runtimeMessages = this.buildRuntimeContextMessages(conv);
                            const fallback = manageContext(runtimeMessages, conv.model, { maxMessages: 18, maxToolResultChars: 600 });
                            conv.contextSummary = conv.contextSummary || '[Earlier conversation was compacted after a context overflow.]';
                            conv.contextSummaryMessageCount = Math.max(0, conv.messages.length - fallback.length);
                            conv.contextSummaryUpdatedAt = Date.now();
                            this.saveConversations();
                        }
                        round--; // Retry this round with compressed context
                        continue;
                    }
                }
                // Model access error — suggest switching model
                const friendlyError = this.friendlyRouteError(e, conv, endpointId);
                const summary = `${this.buildProgressSummary(conv, 'task interrupted by API or runtime error', {
                    round,
                    maxRounds: HARD_MAX_ROUNDS,
                    softMaxRounds: SOFT_MAX_ROUNDS,
                })}
${friendlyError}`;
                this.learnFromCompletedTurn(userInput, summary, events, memoryToolObservations);
                events.onDone(summary);
                this.emitTerminalApiError(events, friendlyError, conv, endpointId);
                const lastMsg = conv.messages[conv.messages.length - 1];
                if (lastMsg?.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                    conv.messages.pop();
                }
                this.finishChat(effectiveConvId);
                return summary;
            }
            consecutiveRateRetries = 0;
            const assistantMsg: ChatMessage = { role: 'assistant', content };
            // Some OpenAI-compatible APIs require the original reasoning_content
            // when replaying assistant tool_calls with their tool results.
            if (toolCalls.length > 0) {
                assistantMsg.reasoning_content = reasoningContent || (reasoningWasTrimmed ? '[reasoning trimmed]' : '');
                assistantMsg.tool_calls = this.sanitizeConversationToolCalls(toolCalls);
                // When tool_calls exist, content should be null (not empty string)
                // to match the model's actual response format and avoid API 400 errors.
                if (!content) {
                    assistantMsg.content = null as any;
                }
            }
            else {
                assistantMsg.reasoning_content = reasoningWasTrimmed
                    ? '[Earlier reasoning trimmed for responsiveness]\n'
                    : '';
            }
            conv.messages.push(assistantMsg);
            this.saveConversations();
            if (toolCalls.length === 0) {
                // Fallback: if API returned reasoning but no content, use reasoning as response
                // This handles models that only generate thinking tokens for simple queries
                reasoningLoopCount = 0;
                const finalResponse = content || reasoningContent || '(no response)';
                const completionGate = conv.mode === 'infinite'
                    ? this.shouldContinueInfiniteAfterTextFinal(conv, taskComplexity, finalResponse, round, HARD_MAX_ROUNDS)
                    : this.shouldContinueAutoAfterTextFinal(conv, taskComplexity, finalResponse, round, HARD_MAX_ROUNDS);
                if (completionGate.shouldContinue) {
                    const preservedDraft = this.appendMissingArtifactSummary(conv, finalResponse);
                    const lastAssistant = conv.messages[conv.messages.length - 1];
                    if (lastAssistant?.role === 'assistant') {
                        lastAssistant.content = preservedDraft;
                    }
                    events.onVerificationUpdate?.('继续补充验证与收尾检查中。', preservedDraft);
                    conv.messages.push(this.buildSelfCheckInstruction(conv.mode, completionGate.reason, finalResponse));
                    this.saveConversations();
                    this.traceEvent(conv, 'completion_gate.continue', { round, reason: completionGate.reason });
                    events.onReasoning(`[Completion gate] ${completionGate.reason}; continuing instead of finalizing.`);
                    continue;
                }
                const finalWithArtifacts = this.appendMissingArtifactSummary(conv, finalResponse);
                this.traceEvent(conv, 'chat.done', {
                    round,
                    elapsedMs: Date.now() - chatStartedAt,
                    responseChars: finalWithArtifacts.length,
                });
                const finalOutput = this.maybeSaveLongFinalResponse(finalWithArtifacts, events, userInput);
                if (finalOutput !== finalResponse) {
                    const last = conv.messages[conv.messages.length - 1];
                    if (last?.role === 'assistant') {
                        last.content = finalOutput;
                        this.saveConversations();
                    }
                }
                this.learnFromCompletedTurn(userInput, finalOutput, events, memoryToolObservations);
                events.onDone(finalOutput);
                this.finishChat(effectiveConvId);
                return finalOutput;
            }
            const roundElapsedBeforeTools = Date.now() - roundStartTime;
            if (roundElapsedBeforeTools > ROUND_TIMEOUT_MS) {
                const overMs = roundElapsedBeforeTools - ROUND_TIMEOUT_MS;
                events.onReasoning(`\n\n[Round ${round}] Pre-tool stage exceeded soft timeout by ${Math.ceil(overMs / 1000)}s. Continuing because tool calls are ready.`);
            }
            // ── Parallel tool execution: batch read-only tools ──
            const PARALLEL_TOOLS = new Set([
                'read_file', 'search_files', 'glob_files', 'list_directory',
                'get_file_info', 'git_status', 'git_diff', 'git_log',
                'fetch_url', 'web_search', 'git_worktree_list', 'read_notebook',
            ]);
            const MAX_PARALLEL = 6;
            // Build execution plan: group consecutive parallelizable tools
            interface ToolTask {
                index: number;
                tc: ToolCall;
                args: Record<string, any>;
                parallel: boolean;
            }
            const skippedToolResults = new Map<number, string>();
            const seenReadOnlyCalls = new Map<string, number>();
            const readFileRanges = this.collectReadFileRangesThisTurn(conv);
            const tasks: ToolTask[] = [];
            toolCalls.forEach((tc, i) => {
                let args: Record<string, any> = this.parseToolArgs(tc);
                if (this.mcpManager.isMcpTool(tc.function.name) && /^mcp_mimo_multimodal_/i.test(tc.function.name)) {
                    args = this.prepareBuiltinMultimodalArgs(tc.function.name, args, conv);
                }
                const isParallel = PARALLEL_TOOLS.has(tc.function.name)
                    && !this.mcpManager.isMcpTool(tc.function.name);
                // Note: PARALLEL_TOOLS only contains read-only tools, safe to parallelize even in polling mode.
                // Mutating tools (edit_file, write_file, delete_file) are never in PARALLEL_TOOLS.
                if (isParallel) {
                    if (tc.function.name === 'read_file') {
                        const overlapSkip = this.shouldSkipOverlappingReadFile(args, readFileRanges);
                        if (overlapSkip) {
                            skippedToolResults.set(i, overlapSkip);
                            this.traceEvent(conv, 'tool.skip_overlapping_read_file', {
                                round,
                                path: args.path,
                                offset: args.offset,
                                limit: args.limit,
                            });
                            return;
                        }
                    }
                    const key = this.normalizeToolArgsForLoopGuard(tc.function.name, args);
                    const firstIndex = seenReadOnlyCalls.get(key);
                    if (firstIndex !== undefined) {
                        skippedToolResults.set(i, `Skipped duplicate read-only tool call; same as tool #${firstIndex + 1}.`);
                        return;
                    }
                    const repeatsThisTurn = this.countReadOnlyRepeatsThisTurn(conv, tc.function.name, args);
                    if (repeatsThisTurn >= 1) {
                        const msg = `Skipped repeated read-only tool call; same request already ran ${repeatsThisTurn} time(s) in this user turn. Use the earlier tool result and choose a new action if more evidence is needed.`;
                        skippedToolResults.set(i, msg);
                        this.traceEvent(conv, 'tool.skip_duplicate_readonly', {
                            round,
                            tool: tc.function.name,
                            repeatsThisTurn,
                        });
                        return;
                    }
                    seenReadOnlyCalls.set(key, i);
                }
                tasks.push({ index: i, tc, args, parallel: isParallel });
            });
            // Group into batches
            const batches: ToolTask[][] = [];
            let currentBatch: ToolTask[] = [];
            for (const task of tasks) {
                if (task.parallel) {
                    currentBatch.push(task);
                }
                else {
                    if (currentBatch.length > 0) {
                        batches.push(currentBatch);
                        currentBatch = [];
                    }
                    batches.push([task]);
                }
            }
            if (currentBatch.length > 0)
                batches.push(currentBatch);
            events.onReasoning(this.describeToolPlan(round, tasks, skippedToolResults.size));
            // Execute each tool (shared logic)
            const execToolCall = async (task: ToolTask): Promise<{
                result: string;
                elapsed: number;
            }> => {
                const { tc, args } = task;
                const t0 = Date.now();
                let result: string;
                this.traceEvent(conv, 'tool.start', {
                    round,
                    tool: tc.function.name,
                    argKeys: Object.keys(args || {}),
                });
                if (tc.function.name === 'spawn_subagent') {
                    result = await this.handleSpawnSubAgent(args, events, signal, effectiveConvId);
                }
                else if (tc.function.name === 'ask_user') {
                    result = this.canPauseForUserDecision(conv)
                        ? await this.handleAskUser(args, events, effectiveConvId)
                        : this.buildAutonomousAskUserResult(args, conv.mode);
                }
                else if (tc.function.name === 'edit_file' && events.onEditPreview && conv.mode === 'polling') {
                    result = await this.handleEditPreview(args, events, signal, effectiveConvId);
                }
                else if (tc.function.name === 'write_file' && events.onWritePreview && conv.mode === 'polling') {
                    result = await this.handleWritePreview(args, events, signal, effectiveConvId);
                }
                else if (tc.function.name === 'run_workflow') {
                    result = await this.handleWorkflow(args, events, signal, effectiveConvId);
                }
                else {
                    const preHook = await this.hookManager.runPreHooks(tc.function.name, args, this.config.workspace);
                    if (!preHook.proceed) {
                        result = `Blocked by pre-hook:\n${preHook.output}`;
                    }
                    else {
                        result = this.mcpManager.isMcpTool(tc.function.name)
                            ? await this.mcpManager.callTool(tc.function.name, args)
                            : await executeTool(tc.function.name, args, this.config.workspace, this.config.maxOutputLen, this.config.commandTimeout, this.config.sandbox, conv.mode, this.config.dependencyInstall);
                        const postHook = await this.hookManager.runPostHooks(tc.function.name, args, result, this.config.workspace);
                        if (postHook.output)
                            result += `\n[Hooks] ${postHook.output}`;
                        if (postHook.shouldBlock)
                            result = `Blocked by post-hook:\n${postHook.output}\n${result}`;
                    }
                }
                // Auto-fallback: if fetch_url fails, retry with Bash curl
                if (tc.function.name === 'fetch_url' && result.startsWith('Tool error:') && args.url) {
                    const url = args.url;
                    // Security: validate URL format — only allow safe URL characters
                    const isValidUrl = /^https?:\/\/[^\s'";`$|&(){}!#]+$/i.test(url);
                    if (isValidUrl) {
                        const curlFlags = url.includes('.pdf') || url.includes('.zip') ? '-L -k' : '-s -L -k';
                        const timeout = this.config.commandTimeout || 15;
                        // Escape for double-quoted string: strip ! and ' which can break bash
                        const safeUrl = url.replace(/[!'"]/g, '');
                        events.onReasoning(`[fetch_url failed, trying Bash curl as fallback]`);
                        const fallbackResult = await executeTool('execute_command', { command: `curl ${curlFlags} --max-time ${timeout} "${safeUrl}" 2>&1 | head -200` }, this.config.workspace, this.config.maxOutputLen, this.config.commandTimeout, this.config.sandbox, conv.mode, this.config.dependencyInstall);
                        if (!fallbackResult.startsWith('Tool error:')) {
                            result = fallbackResult;
                        }
                    }
                }
                const elapsed = (Date.now() - t0) / 1000;
                this.traceEvent(conv, 'tool.end', {
                    round,
                    tool: tc.function.name,
                    elapsed,
                    resultChars: result.length,
                    isError: result.startsWith('Safety:') || result.startsWith('Tool error:') || result.startsWith('Unknown tool') || result.startsWith('Blocked by'),
                });
                memoryToolObservations.push({
                    name: tc.function.name,
                    args,
                    result: result.slice(0, 4000),
                    isError: result.startsWith('Safety:') || result.startsWith('Tool error:') || result.startsWith('Unknown tool') || result.startsWith('Blocked by'),
                });
                return { result, elapsed };
            };
            // Execute batches
            const toolResults: string[] = new Array(toolCalls.length);
            const toolElapsedTimes: number[] = new Array(toolCalls.length);
            for (const [index, result] of skippedToolResults) {
                toolResults[index] = result;
                toolElapsedTimes[index] = 0;
            }
            for (const batch of batches) {
                if (this.isStopping(effectiveConvId, signal))
                    break;
                // Round timeout: stop only when the round is clearly stuck.
                const batchElapsed = Date.now() - roundStartTime;
                const batchGrace = conv.mode === 'infinite' ? 45000 : 20000;
                if (batchElapsed > ROUND_TIMEOUT_MS + batchGrace) {
                    events.onReasoning(`\n\nRound ${round} exceeded the tool timeout after ${Math.ceil(batchElapsed / 1000)}s, skipping remaining tools.`);
                    break;
                }
                if (batch.length > 1) {
                    // Parallel batch: fire all start events immediately
                    for (const task of batch) {
                        events.onToolCallStart(task.tc.function.name, task.args);
                    }
                    events.onStatus(`并行执行 ${batch.length} 个只读工具...`);
                    events.onReasoning(`[并行执行] 同时处理 ${batch.length} 个只读动作，用来快速收集证据。`);
                    // Execute with concurrency cap
                    const queue = [...batch];
                    const results: Array<{
                        result: string;
                        elapsed: number;
                    } | null> = new Array(batch.length).fill(null);
                    const runNext = async (pos: number): Promise<void> => {
                        if (this.isStopping(effectiveConvId, signal))
                            return;
                        const task = queue[pos];
                        const res = await execToolCall(task);
                        results[pos] = res;
                    };
                    // Simple concurrency limiter
                    const executeAll = async (): Promise<Array<{
                        result: string;
                        elapsed: number;
                    }>> => {
                        const executing: Promise<void>[] = [];
                        for (let i = 0; i < batch.length; i++) {
                            const p = runNext(i).then(() => {
                                executing.splice(executing.indexOf(p), 1);
                            });
                            executing.push(p);
                            if (executing.length >= MAX_PARALLEL) {
                                await Promise.race(executing);
                            }
                        }
                        await Promise.all(executing);
                        return results as Array<{
                            result: string;
                            elapsed: number;
                        }>;
                    };
                    const settled = await executeAll();
                    // Fire end events and store results in original order
                    for (let j = 0; j < batch.length; j++) {
                        const task = batch[j];
                        const res = settled[j];
                        const isError = res.result.startsWith('Safety:') || res.result.startsWith('Tool error:') || res.result.startsWith('Unknown tool') || res.result.startsWith('Blocked by');
                        events.onToolCallEnd(task.tc.function.name, res.result, isError, res.elapsed);
                        events.onReasoning(this.describeToolOutcome(task.tc.function.name, task.args, res.result, res.elapsed));
                        toolResults[task.index] = res.result;
                        toolElapsedTimes[task.index] = res.elapsed;
                    }
                }
                else {
                    // Sequential: single tool
                    if (this.isStopping(effectiveConvId, signal))
                        break;
                    const task = batch[0];
                    events.onToolCallStart(task.tc.function.name, task.args);
                    events.onStatus(`执行工具：${task.tc.function.name}...`);
                    events.onReasoning(`[执行工具] ${this.describeToolAction(task.tc.function.name, task.args)}。`);
                    const { result, elapsed } = await execToolCall(task);
                    const isError = result.startsWith('Safety:') || result.startsWith('Tool error:') || result.startsWith('Unknown tool') || result.startsWith('Blocked by');
                    events.onToolCallEnd(task.tc.function.name, result, isError, elapsed);
                    events.onReasoning(this.describeToolOutcome(task.tc.function.name, task.args, result, elapsed));
                    toolResults[task.index] = result;
                    toolElapsedTimes[task.index] = elapsed;
                }
            }
            const roundProgress = this.summarizeRoundProgress(toolCalls, toolResults, Date.now() - roundStartTime);
            this.traceEvent(conv, 'round.progress', {
                round,
                madeProgress: roundProgress.madeProgress,
                valuableProgress: roundProgress.valuableProgress,
                errorOnly: roundProgress.errorOnly,
                reason: roundProgress.reason,
                elapsedMs: Date.now() - roundStartTime,
            });
            const overSoftBudget = !unlimitedRounds && round >= SOFT_MAX_ROUNDS;
            const readOnlyAuditTask = this.isReadOnlyAuditRequest(userInput);
            const readonlyOnlyRound = !roundProgress.valuableProgress && (roundProgress.readOnlySuccessCount || 0) > 0;
            if (roundProgress.valuableProgress) {
                readonlyOnlyRounds = 0;
                progressRecoveryPrompts = 0;
            }
            else if (readonlyOnlyRound) {
                readonlyOnlyRounds++;
            }
            else if (!roundProgress.madeProgress) {
                readonlyOnlyRounds = 0;
            }
            const lowValueReadOnlyLoop = !readOnlyAuditTask && readonlyOnlyRounds >= 2;
            const progressKeepsGoing = overSoftBudget
                ? (roundProgress.valuableProgress || (readOnlyAuditTask && roundProgress.madeProgress))
                : roundProgress.madeProgress;
            stallRounds = progressKeepsGoing ? 0 : stallRounds + 1;
            let shouldStopAfterSaving = false;
            let shouldRetryWithProgressRecovery = false;
            let progressRecoveryInstruction: ChatMessage | null = null;
            if (overSoftBudget || stallRounds > 0) {
                const loopHint = lowValueReadOnlyLoop
                    ? `；连续 ${readonlyOnlyRounds} 轮只有只读探索，准备切换策略`
                    : '';
                events.onReasoning(`[进展检查] ${roundProgress.reason}${loopHint}；停滞 ${stallRounds}/${overSoftBudget ? POST_BUDGET_STALL_LIMIT : STALL_LIMIT}`);
            }
            else {
                events.onReasoning(`[进展检查] ${roundProgress.reason}；本轮仍有有效推进。`);
            }
            if (lowValueReadOnlyLoop && progressRecoveryPrompts < 2 && !overSoftBudget) {
                progressRecoveryPrompts++;
                shouldRetryWithProgressRecovery = true;
                const recoveryReason = `连续 ${readonlyOnlyRounds} 轮只读探索，没有检测到修改、验证或明确交付`;
                progressRecoveryInstruction = this.buildProgressRecoveryInstruction(recoveryReason, roundProgress, readonlyOnlyRounds, stallRounds);
                this.traceEvent(conv, 'progress_guard.redirect', {
                    round,
                    reason: recoveryReason,
                    readonlyOnlyRounds,
                    stallRounds,
                    recoveryPrompts: progressRecoveryPrompts,
                });
                events.onReasoning(`[进展守卫] ${recoveryReason}。我会要求模型停止泛泛检查，改为具体修改、验证或总结。`);
            }
            if (overSoftBudget && progressKeepsGoing) {
                events.onReasoning(readOnlyAuditTask && !roundProgress.valuableProgress
                    ? `[软轮次预算已达到] 这是只读审计任务，仍检测到新的只读证据，继续执行。`
                    : `[软轮次预算已达到] 仍检测到具体进展，继续执行。`);
            }
            const stopGuardAllowed = conv.mode !== 'auto' || round >= MIN_AUTO_STOP_GUARD_ROUND;
            if (stopGuardAllowed && stallRounds >= (overSoftBudget ? POST_BUDGET_STALL_LIMIT : STALL_LIMIT)) {
                stopReason = overSoftBudget
                    ? '达到软轮次预算，且未检测到进一步进展'
                    : '达到软轮次预算前已连续停滞';
                stopRound = round;
                this.traceEvent(conv, 'stop_guard', { round, reason: stopReason, stallRounds });
                events.onReasoning(`[停止保护] ${stopReason}。`);
                shouldStopAfterSaving = true;
            }
            if (round === HARD_MAX_ROUNDS) {
                stopReason = '达到硬安全上限';
                stopRound = round;
                this.traceEvent(conv, 'stop_guard', { round, reason: stopReason, stallRounds });
                shouldStopAfterSaving = true;
            }
            // Push all results in original order (with replay metadata)
            events.onRoundEnd(round);
            for (let i = 0; i < toolCalls.length; i++) {
                conv.messages.push({
                    role: 'tool',
                    tool_call_id: toolCalls[i].id,
                    content: toolResults[i] || '(aborted)',
                    _toolName: toolCalls[i].function.name,
                    _toolElapsed: toolElapsedTimes[i] || 0,
                });
            }
            if (shouldRetryWithProgressRecovery && progressRecoveryInstruction && !shouldStopAfterSaving) {
                conv.messages.push(progressRecoveryInstruction);
            }
            this.saveConversations();
            reasoningLoopCount = 0;
            const gitPushDone = this.detectGitPushDeliveryComplete(conv, userInput);
            if (gitPushDone.done && gitPushDone.summary) {
                return this.finishWithLocalSummary(conv, userInput, gitPushDone.summary, events, memoryToolObservations, effectiveConvId, 'git_push_delivery.done', { round, reason: gitPushDone.reason });
            }
            if (shouldRetryWithProgressRecovery && progressRecoveryInstruction && !shouldStopAfterSaving) {
                continue;
            }
            if (shouldStopAfterSaving) {
                break;
            }
        }
        // Stop guards reached — produce a usable handoff instead of a bare stop.
        const progressSummary = this.buildProgressSummary(conv, stopReason, {
            round: stopRound,
            maxRounds: HARD_MAX_ROUNDS,
            softMaxRounds: SOFT_MAX_ROUNDS,
        });
        const finalSummary = await this.finalizeWithFreshModel(conv, progressSummary, events, signal);
        const summaryWithArtifacts = this.appendMissingArtifactSummary(conv, finalSummary || progressSummary);
        const summary = this.maybeSaveLongFinalResponse(summaryWithArtifacts, events, userInput);
        conv.messages.push({ role: 'assistant', content: summary });
        this.saveConversations();
        this.traceEvent(conv, 'chat.handoff', {
            reason: stopReason,
            round: stopRound,
            elapsedMs: Date.now() - chatStartedAt,
            summaryChars: summary.length,
        });
        events.onToken(summary);
        events.onDone(summary);
        events.onStopGuard?.({ round: stopRound, reason: stopReason, summary });
        if (!this.isSubstantialFinalReport(summary)) {
            events.onStatus(`Stop guard paused at round ${stopRound}. Progress was saved; send a follow-up message to continue.`);
        }
        this.finishChat(effectiveConvId);
        return summary;
    }
    // ── Input Preprocessing ──
    /**

     * Preprocess user input: fix typos, clarify intent, generate structured prompt.

     * Uses a lightweight call to the model with a preprocessing system prompt.

     */
    async preprocessInput(rawInput: string): Promise<string> {
        // Skip preprocessing for very short or slash commands
        if (rawInput.length < 5 || rawInput.startsWith('/'))
            return rawInput;
        const preprocessPrompt = `You are a prompt optimizer. The user's input may contain typos, unclear logic, or incomplete instructions.

Your job: rewrite it into a clear, structured, actionable prompt for a coding assistant.



Rules:

1. Fix typos and grammar (保持原始语言，不要翻译)

2. If the intent is ambiguous, rewrite with the MOST LIKELY interpretation

3. If a technical term is misspelled, correct it (e.g., "reacr" → "React")

4. If the request is vague ("fix this"), add the most likely specifics based on context

5. If the request contains multiple steps, structure them clearly

6. If the request references something not specified, add a placeholder like "[请指定具体文件]"

7. NEVER change the user's intent — only clarify it

8. If the input is already clear and well-structured, return it unchanged

9. Output ONLY the optimized prompt, nothing else



User input:

${rawInput}`;
        try {
            const result = await this.api.chatCompletionsStream({
                model: this.config.model,
                messages: [
                    { role: 'system' as const, content: preprocessPrompt },
                    { role: 'user' as const, content: rawInput },
                ],
                max_tokens: 500,
                temperature: 0.3,
            }, {});
            const optimized = result.content.trim();
            // Only use if it's meaningfully different (can be shorter if more concise)
            if (optimized && optimized.length > rawInput.length * 0.5 && optimized !== rawInput) {
                return optimized;
            }
            return rawInput;
        }
        catch {
            return rawInput; // Fallback to original on error
        }
    }
    // ── Adversarial Mode: 疯狂程序猿 vs 超级产品经理 ──
    private static readonly PERSONAS = {
        programmer: {
            id: 'programmer' as const,
            name: '疯狂程序猿',
            icon: '🐵',
            color: '#FF6900',
            systemPrompt: `你是疯狂程序猿 (CrazyCoder)，一个技术狂人。全程使用中文。



## 🚀 你的超级能力

- 闪电般理解代码：读 1-2 个文件就能抓住项目核心

- 代码直觉：看一眼就知道哪里该改，改完就对

- 精准打击：每次 edit_file 都命中要害，不浪费一个调用



## ⚡ 工作节奏

探索 → 写代码 → 说话 → 写代码 → 总结



1. 【少量探索】最多读 3-5 个关键文件

2. 【动手写代码】用 edit_file / write_file 修改文件

3. 【输出文字总结】告诉产品经理你做了什么



如果你连续调用了 5 次以上工具还没有输出文字，你就在犯错。



## 🎯 你的风格

- 直接、略带戏剧性："这代码...它冒犯了我。"

- 🐵 emoji 用在关键观点上

- 中英混用（像真正的中国程序员）

- 写完代码后用一句话说清楚改了什么、为什么这么改



## ⚠️ 禁区（踩到就翻车）

- 反复 list_directory / search_files（你有代码直觉，不需要）

- 读同一个文件多次（一次读完，读懂就干）

- 只读文件不写代码（你是程序员，不是审计员）`,
        },
        pm: {
            id: 'pm' as const,
            name: '超级产品经理',
            icon: '🦊',
            color: '#2196F3',
            systemPrompt: `你是超级产品经理 (SuperPM)，用户体验至上。全程使用中文。



## 🦊 你的审查视角

- 你通过 USER 的眼睛看代码，不关心实现细节

- 你只检查关键问题：功能是否正确、边界情况、用户体验

- 不要逐行审查代码风格 —— 那不是你的职责

- 先看整体是否合理，再看细节是否有问题



## 📋 输出格式（必须严格遵守）

你的回复必须按以下结构输出：



1. **判决**（第一行，必须是以下之一）：

   - VERDICT: APPROVED（代码没问题）

   - VERDICT: REJECTED（有问题需要修复）



2. **亮点**（先说好的，再挑毛病）：

   - 👍 [做得好的地方]



3. **问题列表**（仅当 REJECTED 时，每个问题一行）：

   - ISSUE: [问题描述] — 指出具体的文件和行号



4. **改进建议**（可选）：

   - SUGGESTION: [建议内容]



5. **用户视角反馈**（1-2 句，用通俗语言说明用户会遇到什么）



示例（通过）：

VERDICT: APPROVED

👍 表单验证逻辑完整，错误提示友好

功能实现正确，用户体验良好。



示例（不通过）：

VERDICT: REJECTED

👍 组件结构清晰，命名规范

ISSUE: src/utils.ts:15 — 未处理 null 值，会导致崩溃

ISSUE: 边界情况：输入为空数组时返回错误结果

SUGGESTION: 添加空值检查和边界测试

🦊 用户会遇到：表单提交后突然白屏，没有任何提示



## 风格

- 🦊 emoji 标记关键反馈

- 温暖但直接："这个功能很棒！但是..."

- 每个问题 1-2 句话，不要写长篇大论

- 先肯定再批评，让人愿意接受你的反馈`,
        },
    };
    /** Multi-dimensional review prompts for parallel sub-agent review */
    private static readonly REVIEW_DIMENSIONS: Record<string, {
        label: string;
        icon: string;
        prompt: string;
    }> = {
        security: {
            label: '安全审查',
            icon: '🔒',
            prompt: `你是安全审查专家。专注检查以下安全问题：

- 输入验证和注入风险（XSS, SQL injection, 命令注入, 路径遍历）

- 认证/授权漏洞（权限检查缺失、token 泄露）

- 敏感数据暴露（日志打印敏感信息、硬编码密钥）

- 依赖安全问题（已知漏洞的库）

- 不安全的文件操作（未校验路径、未处理权限）



对每个发现的问题，严格按以下格式输出：

ISSUE: [severity:critical/high/medium/low] [文件路径:行号] [问题描述]



如果没有发现问题，输出：NO_ISSUES`,
        },
        performance: {
            label: '性能审查',
            icon: '⚡',
            prompt: `你是性能审查专家。专注检查以下性能问题：

- 不必要的循环/重复计算（可以在循环外计算的放到循环内）

- 内存泄漏风险（事件监听器未移除、闭包持有大对象）

- 大数据量下的 N+1 问题（循环中发请求/查询）

- 异步操作未正确处理（未 await、Promise 链断裂）

- 不必要的同步阻塞（同步读大文件、同步 HTTP）

- 缺少缓存（重复计算相同结果）



对每个发现的问题，严格按以下格式输出：

ISSUE: [severity:critical/high/medium/low] [文件路径:行号] [问题描述]



如果没有发现问题，输出：NO_ISSUES`,
        },
        ux: {
            label: '用户体验审查',
            icon: '👤',
            prompt: `你是用户体验审查专家。专注检查以下体验问题：

- 错误处理和用户提示是否友好（技术错误暴露给用户？）

- 边界情况下的用户反馈（空输入、超长输入、特殊字符）

- 操作流程是否符合用户直觉（确认步骤、撤销能力）

- 加载/等待状态的处理（有没有 loading 提示？）

- 可访问性问题（颜色对比度、键盘操作、屏幕阅读器）



对每个发现的问题，严格按以下格式输出：

ISSUE: [severity:critical/high/medium/low] [文件路径:行号] [问题描述]



如果没有发现问题，输出：NO_ISSUES`,
        },
    };
    /**

     * Adversarial mode — multi-dimensional code review with iterative improvement.

     *

     * ## 适用场景（产出物可被审查的任务）

     * - ✅ 写代码 / 实现功能：代码可审查，安全/性能/UX 多维度评审

     * - ✅ 修 Bug：可验证是否修复，有明确的对错标准

     * - ✅ 重构代码：结构变化可审查，性能可对比

     * - ✅ 写文档 / 文献综述：文本质量可评审，逻辑可检验

     * - ✅ 整理文件 / 项目结构：可审查但收益一般，单 agent 可能更高效

     *

     * ## 不适用场景（产出物无法被审查的任务）

     * - ❌ 操控软件 / 浏览器自动化：没有产出物可以审查，是连续动作流

     * - ❌ 简单问答 / 闲聊：审查 overhead 完全浪费

     * - ❌ 实时交互 / 调试：多轮审查太慢，打断交互节奏

     * - ❌ 需要外部状态的任务：审查 agent 无法感知外部状态变化

     *

     * ## 核心流程

     * Phase 0: 探索 → Phase 1: 编码 → Phase 1.5: 验证 → Phase 2: 多维并行审查 + PM 汇总 → 收敛判定

     */
    async adversarialChat(userInput: string, events: AgentEvents, images?: Array<{
        dataUrl: string;
        name: string;
        size: number;
    }>, convId?: string): Promise<string> {
        const conv = this.conversations.get(convId || this.activeId);
        if (!conv)
            return 'No active conversation';
        const effectiveConvId = convId || this.activeId;
        const endpointId = this.getConversationEndpointId(conv);
        const api = this.getApiForEndpoint(endpointId);
        // ── 适用性检测：不适合的任务自动降级为 Auto 模式 ──
        try {
            const suitability = await checkAdversarialSuitability(api, userInput, conv.model);
            if (!suitability.suitable) {
                // 降级提示
                events.onReasoning(`[🎭→⚡ 降级] 识别为「${suitability.category}」— ${suitability.reason}，对决模式不适合此任务，自动切换为 Auto 模式`);
                // 临时切换为 auto 模式，直接委托 doChat，避免 chat() 的并发保护误判当前会话正在运行。
                const originalMode = conv.mode;
                conv.mode = 'auto';
                try {
                    return await this.doChat(userInput, conv, events, images, effectiveConvId);
                }
                finally {
                    // 恢复对决模式（不影响后续对话的模式选择）
                    conv.mode = originalMode;
                }
            }
        }
        catch {
            // 检测失败，继续用对决模式（安全降级）
        }
        // Clear any stale stopping state from a previous run
        if (effectiveConvId)
            this.stoppingConversations.delete(effectiveConvId);
        // Create AbortController for adversarial mode (chat() creates it for normal mode,
        // but adversarialChat is called before that point)
        const abortController = new AbortController();
        this.abortControllers.set(effectiveConvId, abortController);
        const signal = abortController.signal;
        const MAX_ITERATIONS = this.config.adversarial.maxIterations;
        const coder = MiMoAgent.PERSONAS.programmer;
        const pm = MiMoAgent.PERSONAS.pm;
        // Save user message to conversation
        let userContent: string | ContentPart[];
        if (images && images.length > 0) {
            userContent = [{ type: 'text', text: userInput }];
            for (const img of images) {
                userContent.push({ type: 'image_url', image_url: { url: img.dataUrl } });
            }
        }
        else {
            userContent = userInput;
        }
        conv.messages.push({ role: 'user', content: userContent });
        // Announce adversarial mode start
        const reviewDims = this.config.adversarial.reviewDimensions;
        events.onReasoning([
            `[🎭 对决模式] ${coder.icon} ${coder.name} vs ${pm.icon} ${pm.name} | 审查维度: ${reviewDims.join(', ')}`,
            `[适用] 写代码 ✅ 修Bug ✅ 重构 ✅ 写文档 ✅ | 操控软件 ❌ 简单问答 ❌`,
        ].join('\n'));
        // ── Phase 0: 探索阶段 — 收集代码上下文 ──
        let codeContext = '';
        try {
            events.onStatus('🔍 收集代码上下文...');
            const exploreResult = await runSubAgent({
                type: 'explore',
                task: `分析以下任务涉及的代码文件、依赖关系和项目结构。找到相关的源文件、配置文件、测试文件。\n\n任务：${userInput}\n\n请输出：\n1. 相关文件列表（路径+简要说明）\n2. 关键代码结构（类/函数/模块关系）\n3. 需要特别注意的边界情况`,
                maxRounds: 5,
            }, api, this.config.workspace, this.mcpManager, {
                maxTokens: this.config.maxTokens,
                temperature: this.config.temperature,
                topP: this.config.topP,
                maxOutputLen: this.config.maxOutputLen,
                commandTimeout: this.config.commandTimeout,
                sandbox: this.config.sandbox,
                enableThinking: this.config.enableThinking,
            }, { onStatus: (s) => events.onStatus(`[探索] ${s}`) }, signal);
            codeContext = exploreResult.output;
            events.onReasoning(`[探索完成] 收集了 ${exploreResult.toolCalls} 个工具调用的上下文 (${(exploreResult.elapsed / 1000).toFixed(1)}s)`);
        }
        catch (e: any) {
            events.onReasoning(`[探索失败] ${e.message}，继续执行...`);
        }
        let lastCoderResult = '';
        const reviewHistory: string[] = [];
        const coderMessages: ChatMessage[] = []; // Persistent across iterations
        const rounds: Array<{
            iteration: number;
            verdict: string;
            issueCount: number;
            elapsed: number;
        }> = [];
        const allIssues: TrackedIssue[] = [];
        const startTime = Date.now();
        let exitReason: 'completed' | 'stopped' | 'error' | 'max_iterations' = 'max_iterations';
        let issueCounter = 0;
        let lastDiffSnapshot = '';
        for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
            if (this.isStopping(convId || this.activeId, signal)) {
                exitReason = 'stopped';
                events.onDone('(stopped by user)');
                this.finishChat(convId);
                return '(stopped by user)';
            }
            // ── Phase 1: 疯狂程序猿 编码 ──
            events.onStatus(`${coder.icon} ${coder.name} 正在编码... (第 ${iteration} 轮)`);
            const coderContext = iteration === 1
                ? userInput
                : `请根据产品经理的反馈修复所有问题。不要重复读取已经读过的文件，直接修复问题。`;
            try {
                const coderResult = await this.runAdversarialPersona(conv, coder, coderContext, events, iteration, 'speak', iteration > 1 ? reviewHistory[reviewHistory.length - 1] : undefined, convId, iteration > 1 ? coderMessages : undefined);
                lastCoderResult = coderResult.response;
                // Update coderMessages with the full accumulated history
                coderMessages.length = 0;
                coderMessages.push(...coderResult.messages);
            }
            catch (e: any) {
                events.onError(`${coder.name} error: ${e.message}`);
                exitReason = 'error';
                break;
            }
            try {
                lastDiffSnapshot = await executeTool('git_diff', {}, this.config.workspace, this.config.maxOutputLen, this.config.commandTimeout, this.config.sandbox, conv.mode, this.config.dependencyInstall);
                if (lastDiffSnapshot.startsWith('Tool error:')) {
                    lastDiffSnapshot = '';
                }
            }
            catch {
                lastDiffSnapshot = '';
            }
            if (this.isStopping(convId || this.activeId, signal))
                break;
            // ── Phase 1.5: 验证阶段 — 确认上轮严重问题已修复 ──
            if (iteration > 1 && this.config.adversarial.enableVerification) {
                const criticalIssues = allIssues.filter(i => !i.resolved && (i.severity === 'critical' || i.severity === 'high'));
                if (criticalIssues.length > 0) {
                    events.onStatus(`🔍 验证修复... (${criticalIssues.length} 个严重问题)`);
                    try {
                        const verifyResult = await runSubAgent({
                            type: 'explore',
                            task: `验证以下问题是否已被修复。读取相关文件，检查代码是否已正确修改。\n\n待验证的问题：\n${criticalIssues.map(i => `- ${i.id} ${i.file}:${i.line || '?'} [${i.severity}] ${i.description}`).join('\n')}\n\n对每个问题，输出：\n- FIXED: [问题ID] [简要说明如何确认已修复]\n或\n- NOT_FIXED: [问题ID] [为什么认为未修复]`,
                            maxRounds: 3,
                        }, api, this.config.workspace, this.mcpManager, {
                            maxTokens: this.config.maxTokens,
                            temperature: this.config.temperature,
                            topP: this.config.topP,
                            maxOutputLen: this.config.maxOutputLen,
                            commandTimeout: this.config.commandTimeout,
                            sandbox: this.config.sandbox,
                            enableThinking: this.config.enableThinking,
                            dependencyInstall: this.config.dependencyInstall,
                        }, { onStatus: (s) => events.onStatus(`[验证] ${s}`) }, signal);
                        // Update issue status based on verification
                        const fixedPattern = /FIXED:\s*\[?(issue-\d+)\]?/gi;
                        let fixMatch: RegExpExecArray | null;
                        while ((fixMatch = fixedPattern.exec(verifyResult.output)) !== null) {
                            const issue = allIssues.find(i => i.id === fixMatch![1]);
                            if (issue) {
                                issue.resolved = true;
                                issue.resolvedRound = iteration;
                            }
                        }
                        const fixedCount = criticalIssues.filter(i => i.resolved).length;
                        events.onReasoning(`[验证完成] ${fixedCount}/${criticalIssues.length} 个严重问题已确认修复`);
                    }
                    catch (e: any) {
                        events.onReasoning(`[验证失败] ${e.message}，继续审查...`);
                    }
                }
            }
            // ── Phase 2: 多维并行审查 + PM 汇总 ──
            events.onStatus(`🔍 多维审查中... (第 ${iteration} 轮)`);
            // 2a. Run parallel review sub-agents for each dimension
            const codeSnippet = lastCoderResult.substring(0, 8000);
            const contextSnippet = codeContext ? `\n\n项目上下文：\n${codeContext.substring(0, 4000)}` : '';
            const subAgentConfig = {
                maxTokens: this.config.maxTokens,
                temperature: this.config.temperature,
                topP: this.config.topP,
                maxOutputLen: this.config.maxOutputLen,
                commandTimeout: this.config.commandTimeout,
                sandbox: this.config.sandbox,
                enableThinking: this.config.enableThinking,
            };
            const dimensionResults: Array<{
                dim: string;
                label: string;
                icon: string;
                output: string;
            }> = [];
            const reviewPromises = reviewDims.map(async (dim) => {
                const dimDef = MiMoAgent.REVIEW_DIMENSIONS[dim];
                if (!dimDef)
                    return null;
                try {
                    const result = await runSubAgent({
                        type: 'explore',
                        task: `${dimDef.prompt}\n\n---\n原始需求：${userInput}\n\n${coder.name}的实现：\n${codeSnippet}${contextSnippet}`,
                        maxRounds: 3,
                    }, api, this.config.workspace, this.mcpManager, subAgentConfig, { onStatus: (s) => events.onStatus(`[${dimDef.icon} ${dimDef.label}] ${s}`) }, signal);
                    return { dim, label: dimDef.label, icon: dimDef.icon, output: result.output };
                }
                catch (e: any) {
                    events.onReasoning(`[${dimDef.icon} ${dimDef.label}] 审查失败: ${e.message}`);
                    return null;
                }
            });
            const reviewResults = (await Promise.all(reviewPromises)).filter(Boolean) as typeof dimensionResults;
            dimensionResults.push(...reviewResults);
            // Extract structured issues from each dimension
            for (const dr of dimensionResults) {
                const extracted = this.extractIssues(dr.output, dr.dim, iteration, issueCounter);
                allIssues.push(...extracted.issues);
                issueCounter = extracted.nextId;
            }
            // 2b. PM synthesizes all dimension results
            events.onStatus(`${pm.icon} ${pm.name} 综合审查... (第 ${iteration} 轮)`);
            const dimensionSummary = dimensionResults.length > 0
                ? dimensionResults.map(dr => `### ${dr.icon} ${dr.label}\n${dr.output}`).join('\n\n')
                : '(多维审查未返回结果)';
            let pmReview = '';
            try {
                const pmResult = await this.runAdversarialPersona(conv, pm, `你是最终审查者，综合多个专业审查维度的结果做出最终判断。\n\n以下是各维度的审查结果：\n\n${dimensionSummary}\n\n---\n原始需求：${userInput}\n\n${coder.name}的实现摘要：\n${codeSnippet}\n\n当前 git diff 摘要：\n${lastDiffSnapshot ? lastDiffSnapshot.substring(0, 6000) : '(no diff available)'}\n\n必须按下面格式输出，不能省略 VERDICT：\nVERDICT: APPROVED 或 REJECTED\nISSUE: [severity:critical/high/medium/low] [file:line] [问题描述]\nSUGGESTION: [可选改进建议]\n\n判决规则：只要存在 critical/high 问题，或多维审查中有明确未解决问题，必须 REJECTED。只有确认需求完成、没有阻塞问题、且修改可验证时才 APPROVED。`, events, iteration, 'review', undefined, convId);
                pmReview = pmResult.response;
            }
            catch (e: any) {
                events.onError(`${pm.name} error: ${e.message}`);
                exitReason = 'error';
                break;
            }
            reviewHistory.push(pmReview);
            // Check verdict (structured parsing)
            const verdict = this.parseVerdict(pmReview);
            const pmExtracted = this.extractIssues(pmReview, 'pm', iteration, issueCounter);
            allIssues.push(...pmExtracted.issues);
            issueCounter = pmExtracted.nextId;
            let approved = verdict.approved;
            if (verdict.verdictFound) {
                for (const issue of allIssues) {
                    if (!issue.resolved && issue.file === '(review)' && issue.description.includes('structured VERDICT')) {
                        issue.resolved = true;
                        issue.resolvedRound = iteration;
                    }
                }
            }
            const openSevereIssues = allIssues.filter(i => !i.resolved && (i.severity === 'critical' || i.severity === 'high'));
            if (approved && openSevereIssues.length > 0) {
                events.onReasoning(`[第 ${iteration} 轮] PM 给出通过，但仍有 ${openSevereIssues.length} 个严重问题未验证，继续迭代`);
                approved = false;
            }
            if (approved && pmExtracted.issues.some(i => !i.resolved)) {
                events.onReasoning(`[Round ${iteration}] PM returned APPROVED but also listed unresolved ISSUE entries. Continuing repair.`);
                approved = false;
            }
            if (!verdict.verdictFound) {
                events.onReasoning(`[第 ${iteration} 轮] ⚠️ ${pm.icon} 未输出标准判决格式，转为继续迭代`);
                approved = false;
                allIssues.push({
                    id: `issue-${++issueCounter}`,
                    severity: 'high',
                    file: '(review)',
                    description: 'PM review did not produce a structured VERDICT. Continue with stricter verification and finalization.',
                    dimension: 'pm',
                    round: iteration,
                    resolved: false,
                });
            }
            // Track round data for quality report
            const roundIssueCount = allIssues.filter(i => i.round === iteration).length;
            rounds.push({
                iteration,
                verdict: approved ? 'APPROVED' : 'REJECTED',
                issueCount: roundIssueCount,
                elapsed: Date.now() - startTime,
            });
            if (approved) {
                // PM approved — emit final verdict
                const verdictSummary = verdict.suggestions.length > 0
                    ? `\n\n💡 改进建议：\n${verdict.suggestions.map(s => `- ${s}`).join('\n')}`
                    : '';
                events.onAdversarialTurn?.(pm.id, pm.name, pm.icon, 'verdict', `✅ **通过！** 经过 ${iteration} 轮对决，代码质量达标。${verdictSummary}\n\n${pmReview}`, iteration);
                this.emitAdversarialReport(rounds, allIssues, events);
                conv.messages.push({ role: 'assistant', content: lastCoderResult, reasoning_content: '' });
                this.saveConversations();
                events.onStatus(`[🎭 对决结束] ${pm.icon} ${pm.name} 通过 ✅ (${iteration} 轮)`);
                events.onDone(lastCoderResult);
                this.finishChat(convId);
                return lastCoderResult;
            }
            // ── 智能收敛判定 ──
            const convergence = this.shouldConverge(allIssues, rounds, iteration, MAX_ITERATIONS);
            if (convergence.converge) {
                const unresolved = allIssues.filter(i => !i.resolved);
                const criticalUnresolved = unresolved.filter(i => i.severity === 'critical' || i.severity === 'high');
                const remainingIssues = criticalUnresolved.length > 0
                    ? `\n\n🔴 未解决的严重问题：\n${criticalUnresolved.map(i => `- [${i.severity}] ${i.file}:${i.line || '?'} — ${i.description}`).join('\n')}`
                    : unresolved.length > 0
                        ? `\n\n残留低优先级问题：\n${unresolved.map(i => `- [${i.severity}] ${i.description}`).join('\n')}`
                        : '';
                events.onAdversarialTurn?.(pm.id, pm.name, pm.icon, 'verdict', `⚠️ **放行** — ${convergence.reason}。${remainingIssues}\n\n${pmReview}`, iteration);
                this.emitAdversarialReport(rounds, allIssues, events);
                conv.messages.push({ role: 'assistant', content: lastCoderResult, reasoning_content: '' });
                this.saveConversations();
                events.onStatus(`[🎭 对决结束] ⚠️ ${convergence.reason} (${iteration} 轮)`);
                events.onDone(lastCoderResult);
                this.finishChat(convId);
                return lastCoderResult;
            }
            // Feed structured issues back to coder for next iteration
            const roundIssues = allIssues.filter(i => i.round === iteration);
            const unresolvedIssues = allIssues.filter(i => !i.resolved);
            const feedbackForCoder = this.buildAdversarialFeedback(unresolvedIssues.length > 0 ? unresolvedIssues : roundIssues, pmReview, lastDiffSnapshot);
            reviewHistory[reviewHistory.length - 1] = feedbackForCoder;
            const issueSummary = roundIssues.length > 0
                ? `${pm.icon} 发现 ${roundIssues.length} 个问题（${roundIssues.filter(i => i.severity === 'critical' || i.severity === 'high').length} 个严重），${coder.icon} 需要修复...`
                : `${pm.icon} 发现问题，${coder.icon} 需要修复...`;
            events.onReasoning(`[第 ${iteration} 轮] ${issueSummary}`);
        }
        // Loop ended — emit quality report
        this.emitAdversarialReport(rounds, allIssues, events);
        conv.messages.push({ role: 'assistant', content: lastCoderResult, reasoning_content: '' });
        this.saveConversations();
        const endMsg = exitReason === 'error'
            ? `[🎭 对决结束] 执行出错 (${rounds.length} 轮)`
            : `[🎭 对决结束] 达到最大轮次 (${MAX_ITERATIONS})`;
        events.onStatus(endMsg);
        const doneMsg = this.buildAdversarialFinalSummary(exitReason, lastCoderResult, allIssues, rounds, MAX_ITERATIONS);
        events.onDone(doneMsg);
        this.finishChat(convId);
        return doneMsg;
    }
    /**

     * Run a single adversarial persona (coder or PM) with independent message history.

     * Streams output through adversarial-specific events for visual dialogue.

     * @param existingMessages - If provided, append to this array instead of creating new one (for cross-round context).

     */
    private async runAdversarialPersona(conv: ConversationState, persona: {
        id: 'programmer' | 'pm';
        name: string;
        icon: string;
        color: string;
        systemPrompt: string;
    }, task: string, events: AgentEvents, iteration: number, phase: 'speak' | 'review', previousFeedback?: string, convId?: string, existingMessages?: ChatMessage[]): Promise<{
        response: string;
        messages: ChatMessage[];
    }> {
        const signal = this.abortControllers.get(convId || this.activeId)?.signal;
        const endpointId = this.getConversationEndpointId(conv);
        const api = this.getApiForEndpoint(endpointId);
        // Copy existing messages so manageContext compression doesn't corrupt the persistent history
        const messages: ChatMessage[] = existingMessages ? [...existingMessages] : [];
        if (existingMessages) {
            // Accumulating mode: inject PM feedback into the user message so coder sees specific issues
            const taskContent = previousFeedback
                ? `${task}\n\n[产品经理的反馈 — 上一轮]\n${previousFeedback}`
                : task;
            messages.push({ role: 'user', content: taskContent });
        }
        else {
            // Fresh history: add feedback context if any
            if (previousFeedback) {
                messages.push({ role: 'system', content: `[上一轮反馈]\n${previousFeedback}` });
            }
            messages.push({ role: 'user', content: task });
        }
        let fullResponse = '';
        // Tool budget: configurable rounds of tools, then FORCE text output (no tools)
        // This prevents the model from exploring forever without producing results.
        const TOOL_BUDGET = this.config.adversarial.toolBudget;
        for (let toolRound = 0; toolRound < 100; toolRound++) {
            if (this.isStopping(convId || this.activeId, signal))
                break;
            const forceText = toolRound >= TOOL_BUDGET;
            // When forcing text: inject instruction and remove tools
            if (forceText && toolRound === TOOL_BUDGET) {
                messages.push({
                    role: 'user',
                    content: '[系统提示] 你的工具调用配额已用完。现在必须立即输出文字回复，总结你做了什么、改了哪些文件、结果如何。不要再调用任何工具。',
                });
                events.onReasoning(`[第 ${TOOL_BUDGET} 轮] 🐵 工具配额用完，强制输出结果...`);
            }
            // Context management: compress when approaching limits
            const managed = manageContext(messages, conv.model);
            // Replace original array contents with managed result so compression persists
            messages.length = 0;
            messages.push(...managed);
            // Build adversarial system prompt: persona + workspace + personalized instructions
            let advSystemContent = persona.systemPrompt
                + `\n\nWorkspace: ${this.config.workspace}\nCurrent iteration: ${iteration}`;
            advSystemContent += phase === 'review'
                ? `\n\n## Review Contract\nYou are a strict reviewer. Use tools to inspect files when needed, but do not modify files. Your final response MUST include:\nVERDICT: APPROVED or REJECTED\nISSUE: [severity:critical/high/medium/low] [file:line] [description]\nSUGGESTION: [optional]\nApprove only when the requested outcome is implemented and no blocking issue remains.`
                : `\n\n## Builder Contract\nPrefer direct fixes over broad re-analysis. When feedback is provided, fix listed issues first. If a narrow edit fails repeatedly because of encoding or brittle context, re-read the full file and rebuild the smallest coherent section or the whole small file, then validate. Final response must include changed files and verification result.`;
            if (this.personalizedInstructions) {
                advSystemContent += `\n\n## Project/User Instructions\nFollow these unless they conflict with higher-priority safety, tool, or system requirements.\n${this.personalizedInstructions}`;
            }
            const params: Record<string, any> = this.buildChatParams(conv.model, [
                { role: 'system' as const, content: advSystemContent },
                ...managed,
            ], {}, endpointId);
            // After tool budget exhausted: NO tools, force text-only response
            if (forceText) {
                params.tools = undefined;
                params.tool_choice = undefined;
            }
            else if (phase === 'review') {
                // PM: strictly read-only tools (no execute_command — reviewer must not modify state)
                params.tools = TOOL_DEFINITIONS.filter(t => ['read_file', 'search_files', 'glob_files', 'list_directory',
                    'get_file_info', 'git_status', 'git_diff', 'git_log'].includes(t.function.name));
                params.tool_choice = 'auto';
            }
            else {
                // Coder: all tools, freely use them
                params.tools = this.withoutUserPauseTools(TOOL_DEFINITIONS);
                params.tool_choice = 'auto';
            }
            // Stream with persona-specific events
            let roundText = '';
            let reasoningText = '';
            const result = await api.chatCompletionsStream(params, {
                onToken: (t) => {
                    roundText += t;
                    events.onAdversarialTurn?.(persona.id, persona.name, persona.icon, phase, t, iteration);
                },
                onReasoning: (t) => {
                    reasoningText += t;
                },
            }, signal);
            if (result.reasoningContent)
                reasoningText = result.reasoningContent;
            if (result.toolCalls.length === 0) {
                // Model produced text without tools — this is the natural final response
                fullResponse = result.content || roundText;
                break;
            }
            // Has tool calls — execute them and continue the loop
            // Execute tool calls
            const assistantMsg: ChatMessage = {
                role: 'assistant', content: result.content || null as any,
                tool_calls: this.sanitizeConversationToolCalls(result.toolCalls), reasoning_content: reasoningText || '',
            };
            messages.push(assistantMsg);
            // Collect tool call summaries for narration
            const toolSummaries: string[] = [];
            for (const tc of result.toolCalls) {
                // Check stop signal before each tool execution
                if (this.isStopping(convId || this.activeId, signal))
                    break;
                let args: Record<string, any> = this.parseToolArgs(tc);
                if (this.mcpManager.isMcpTool(tc.function.name) && /^mcp_mimo_multimodal_/i.test(tc.function.name)) {
                    args = this.prepareBuiltinMultimodalArgs(tc.function.name, args, conv);
                }
                events.onAdversarialToolStart?.(persona.id, tc.function.name, args);
                const t0 = Date.now();
                const toolResult = this.mcpManager.isMcpTool(tc.function.name)
                    ? await this.mcpManager.callTool(tc.function.name, args)
                    : await executeTool(tc.function.name, args, this.config.workspace, this.config.maxOutputLen, this.config.commandTimeout, this.config.sandbox, conv.mode, this.config.dependencyInstall);
                const toolElapsed = (Date.now() - t0) / 1000;
                const isError = toolResult.startsWith('Safety:') || toolResult.startsWith('Tool error:');
                events.onAdversarialToolEnd?.(persona.id, tc.function.name, toolResult, isError, toolElapsed);
                events.onToolCallEnd(tc.function.name, toolResult, isError, toolElapsed);
                messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
                // Generate human-readable summary for narration
                toolSummaries.push(this.summarizeToolCall(tc.function.name, args, isError));
            }
            // Emit narration text so user can see what the persona is doing
            if (toolSummaries.length > 0) {
                const narration = toolSummaries.length === 1
                    ? toolSummaries[0]
                    : `${toolSummaries[0]} 等 ${toolSummaries.length} 项操作`;
                // Small delay to let tool cards render first
                await new Promise(r => setTimeout(r, 50));
                events.onAdversarialTurn?.(persona.id, persona.name, persona.icon, phase, `\n\n> ${narration}\n\n`, iteration);
            }
            fullResponse = result.content || roundText;
        }
        // Append assistant response to messages for context accumulation
        messages.push({ role: 'assistant', content: fullResponse, reasoning_content: '' });
        return { response: fullResponse, messages };
    }
    /**

     * Handle direct responses — no tools needed (greetings, questions, explanations).

     */
    private async handleDirectResponse(userInput: string, conv: ConversationState, events: AgentEvents, signal?: AbortSignal, convId?: string, persona?: ReturnType<typeof detectPersona>): Promise<string> {
        events.onStatus('正在思考...');
        const endpointId = this.getConversationEndpointId(conv);
        const api = this.getApiForEndpoint(endpointId);
        // Include persona in system prompt if detected
        let systemContent = persona
            ? buildPersonaPrompt(this.systemPrompt, persona)
            : this.systemPrompt;
        // Inject active skill prompt
        if (conv.activeSkillPrompt) {
            systemContent += `\n\n## Active Skill\n${conv.activeSkillPrompt}`;
        }
        // Include conversation history so the model can reference past messages.
        await this.ensureContextMemory(conv, 'simple', systemContent, events, signal);
        const managedMessages = manageContext(this.buildRuntimeContextMessages(conv), conv.model);
        const directOptions: Record<string, any> = {
            max_tokens: Math.min(this.config.maxTokens || 8192, this.getReasoningProfile().directMaxTokens),
            temperature: 0.3,
            _applyReasoningMultiplier: false,
        };
        if (this.shouldSendThinkingControl(conv.model, endpointId)) {
            directOptions.extra_body = { thinking: { type: 'disabled' } };
        }
        const params: Record<string, any> = this.buildChatParams(conv.model, [
            { role: 'system' as const, content: systemContent },
            ...managedMessages,
        ], directOptions, endpointId);
        let content = '';
        const result = await api.chatCompletionsStream(params, {
            onToken: (t) => {
                content += t;
                events.onToken(t);
            },
            onReasoning: (t) => events.onReasoning(t),
        }, signal);
        if (result.usage)
            recordTokenUsage(result.usage);
        // Save assistant response (user message already pushed by chat())
        conv.messages.push({ role: 'assistant', content: content || result.content, reasoning_content: '' });
        this.saveConversations();
        const response = content || result.content || '(no response)';
        events.onDone(response);
        this.finishChat(convId);
        return response;
    }
    private summarizeToolCall(name: string, args: Record<string, any>, isError: boolean): string {
        const failTag = isError ? ' ❌' : '';
        switch (name) {
            case 'read_file': return `📄 读取了 ${args.path || '文件'}${failTag}`;
            case 'write_file': return `✏️ 写入了 ${args.path || '文件'}${failTag}`;
            case 'edit_file': return `✏️ 编辑了 ${args.path || '文件'}${failTag}`;
            case 'list_directory': return `📁 浏览了 ${args.path || '目录'}${failTag}`;
            case 'search_files': return `🔍 搜索了 "${args.pattern || ''}"${failTag}`;
            case 'execute_command': return `⚡ 执行了命令${failTag}`;
            case 'glob_files': return `📂 匹配了 ${args.pattern || ''}${failTag}`;
            case 'git_status': return `🌿 查看了 git 状态${failTag}`;
            case 'git_diff': return `🌿 查看了 git diff${failTag}`;
            case 'git_log': return `🌿 查看了提交历史${failTag}`;
            case 'git_commit': return `🌿 提交了代码${failTag}`;
            case 'web_search': return `🌐 搜索了 "${args.query || ''}"${failTag}`;
            case 'fetch_url': return `🌐 获取了网页内容${failTag}`;
            default: return `🔧 调用了 ${name}${failTag}`;
        }
    }
    /**

     * Emit an enhanced quality report summarizing the adversarial session.

     * Includes issue tracking stats, severity distribution, and dimension breakdown.

     */
    private emitAdversarialReport(rounds: Array<{
        iteration: number;
        verdict: string;
        issueCount: number;
        elapsed: number;
    }>, allIssues: TrackedIssue[], events: AgentEvents): void {
        if (rounds.length === 0)
            return;
        const totalElapsed = rounds[rounds.length - 1].elapsed;
        const issueCounts = rounds.map(r => r.issueCount);
        const finalVerdict = rounds[rounds.length - 1].verdict;
        const totalIssues = allIssues.length;
        const resolvedIssues = allIssues.filter(i => i.resolved).length;
        const bySeverity = {
            critical: allIssues.filter(i => i.severity === 'critical').length,
            high: allIssues.filter(i => i.severity === 'high').length,
            medium: allIssues.filter(i => i.severity === 'medium').length,
            low: allIssues.filter(i => i.severity === 'low').length,
        };
        // Group by dimension
        const byDimension = new Map<string, number>();
        for (const issue of allIssues) {
            byDimension.set(issue.dimension, (byDimension.get(issue.dimension) || 0) + 1);
        }
        const dimensionBreakdown = Array.from(byDimension.entries())
            .map(([dim, count]) => `${dim}:${count}`)
            .join(' | ');
        const report = [
            `📊 **对决质量报告**`,
            `━━━━━━━━━━━━━━━━━━`,
            `总轮次: ${rounds.length}`,
            `问题变化: ${issueCounts.join(' → ')}`,
            `问题统计: ${totalIssues} 个发现, ${resolvedIssues} 个已解决${totalIssues > 0 ? ` (${(resolvedIssues / totalIssues * 100).toFixed(0)}%)` : ''}`,
            `严重度分布: 🔴${bySeverity.critical} 🟡${bySeverity.high} 🔵${bySeverity.medium} ⚪${bySeverity.low}`,
            dimensionBreakdown ? `维度分布: ${dimensionBreakdown}` : '',
            `最终判决: ${finalVerdict === 'APPROVED' ? '✅ 通过' : '⚠️ 未完全通过'}`,
            `总耗时: ${(totalElapsed / 1000).toFixed(1)}s`,
        ].filter(Boolean).join('\n');
        events.onReasoning(report);
    }
    /**

     * Extract structured issues from a review sub-agent's output.

     * Parses ISSUE: [severity:critical/high/medium/low] [file:line] [description] format.

     */
    private extractIssues(reviewText: string, dimension: string, round: number, startId: number): {
        issues: TrackedIssue[];
        nextId: number;
    } {
        const issues: TrackedIssue[] = [];
        let nextId = startId;
        // Match: ISSUE: [severity:critical/high/medium/low] [file:line] [description]
        // Also matches: ISSUE: [critical] [file] [description] (without severity: prefix)
        const issueRegex = /ISSUE:\s*\[(?:severity:)?(critical|high|medium|low)\]\s*\[([^\]:]+?)(?::(\d+))?\]\s*(.+)/gi;
        let match;
        while ((match = issueRegex.exec(reviewText)) !== null) {
            issues.push({
                id: `issue-${++nextId}`,
                severity: match[1].toLowerCase() as TrackedIssue['severity'],
                file: match[2].trim(),
                line: match[3] ? parseInt(match[3]) : undefined,
                description: match[4].trim(),
                dimension,
                round,
                resolved: false,
            });
        }
        // Fallback: try simpler ISSUE: format without brackets
        if (issues.length === 0) {
            const simpleRegex = /ISSUE:\s*(.+)/gi;
            while ((match = simpleRegex.exec(reviewText)) !== null) {
                const desc = match[1].trim();
                if (desc.toLowerCase() === 'no_issues')
                    continue;
                issues.push({
                    id: `issue-${++nextId}`,
                    severity: 'medium', // Default severity when not specified
                    file: '(unknown)',
                    description: desc,
                    dimension,
                    round,
                    resolved: false,
                });
            }
        }
        return { issues, nextId };
    }
    /**

     * Smart convergence detection based on issue severity and resolution rate.

     * Replaces the old Jaccard similarity approach.

     */
    private shouldConverge(allIssues: TrackedIssue[], rounds: Array<{
        iteration: number;
        verdict: string;
        issueCount: number;
        elapsed: number;
    }>, currentRound: number, maxIterations: number): {
        converge: boolean;
        reason: string;
    } {
        const unresolved = allIssues.filter(i => !i.resolved);
        const criticalUnresolved = unresolved.filter(i => i.severity === 'critical' || i.severity === 'high');
        // 1. Only converge when every tracked issue is resolved.
        // The caller already handles explicit PM approval; this path is for ending stalled loops.
        if (unresolved.length === 0 && rounds.length > 0) {
            return { converge: true, reason: '所有跟踪问题已解决' };
        }
        // 2. Max iterations reached
        if (currentRound >= maxIterations) {
            return { converge: true, reason: `达到最大迭代轮次 (${maxIterations})` };
        }
        return { converge: false, reason: '' };
    }
    /**

     * Parse structured verdict from PM review.

     * Supports both structured (VERDICT: APPROVED/REJECTED) and legacy (✅/❌) formats.

     */
    private parseVerdict(review: string): {
        approved: boolean;
        issues: string[];
        suggestions: string[];
        verdictFound: boolean;
    } {
        // Try structured format first
        const verdictMatch = review.match(/VERDICT:\s*(APPROVED|REJECTED)/i);
        if (verdictMatch) {
            const approved = verdictMatch[1].toUpperCase() === 'APPROVED';
            const issues = (review.match(/ISSUE:\s*(.+)/gi) || [])
                .map(m => m.replace(/ISSUE:\s*/i, '').trim());
            const suggestions = (review.match(/SUGGESTION:\s*(.+)/gi) || [])
                .map(m => m.replace(/SUGGESTION:\s*/i, '').trim());
            return { approved, issues, suggestions, verdictFound: true };
        }
        // Fallback: legacy format (✅/❌ emoji)
        const trimmed = review.trim();
        const hasApproval = /^✅/.test(trimmed) || /✅\s*通过/.test(trimmed);
        const hasRejection = /^❌/.test(trimmed) || /❌\s*不通过/.test(trimmed);
        if (hasApproval || hasRejection) {
            return {
                approved: hasApproval && !hasRejection,
                issues: [],
                suggestions: [],
                verdictFound: true,
            };
        }
        // No verdict pattern found — PM failed to produce a proper verdict
        return { approved: false, issues: [], suggestions: [], verdictFound: false };
    }
    private buildAdversarialFeedback(issues: TrackedIssue[], pmReview: string, diffSnapshot: string): string {
        const unresolved = issues
            .filter(i => !i.resolved)
            .filter((issue, idx, arr) => {
            const key = `${issue.severity}|${issue.file}|${issue.description.toLowerCase().replace(/\s+/g, ' ').trim()}`;
            return arr.findIndex(other => `${other.severity}|${other.file}|${other.description.toLowerCase().replace(/\s+/g, ' ').trim()}` === key) === idx;
        })
            .sort((a, b) => {
            const rank = { critical: 0, high: 1, medium: 2, low: 3 };
            return rank[a.severity] - rank[b.severity];
        });
        const issueBlock = unresolved.length > 0
            ? unresolved.map(i => `- ${i.id} [${i.severity}] ${i.file}${i.line ? `:${i.line}` : ''}: ${i.description}`).join('\n')
            : '- No structured issues were extracted. Re-read the PM review and verify the diff.';
        return [
            'Adversarial repair brief:',
            '',
            'Fix these items first, in order. Do not restart broad exploration unless a file is missing.',
            issueBlock,
            '',
            'PM review:',
            pmReview.substring(0, 5000),
            '',
            'Current git diff snapshot:',
            diffSnapshot ? diffSnapshot.substring(0, 5000) : '(no diff available)',
            '',
            'Required next response:',
            '- Apply concrete fixes with tools when needed.',
            '- Run or describe the smallest useful verification.',
            '- Finish with changed files and verification result.',
        ].join('\n');
    }
    private buildAdversarialFinalSummary(exitReason: 'completed' | 'stopped' | 'error' | 'max_iterations', lastCoderResult: string, allIssues: TrackedIssue[], rounds: Array<{
        iteration: number;
        verdict: string;
        issueCount: number;
        elapsed: number;
    }>, maxIterations: number): string {
        const unresolved = allIssues
            .filter(i => !i.resolved)
            .sort((a, b) => {
            const rank = { critical: 0, high: 1, medium: 2, low: 3 };
            return rank[a.severity] - rank[b.severity];
        });
        const issueText = unresolved.length > 0
            ? unresolved.slice(0, 10).map(i => `- [${i.severity}] ${i.file}${i.line ? `:${i.line}` : ''}: ${i.description}`).join('\n')
            : '- None tracked';
        const status = exitReason === 'error'
            ? 'adversarial mode stopped because one persona failed'
            : `adversarial mode reached the maximum ${maxIterations} iterations`;
        return [
            `Task status: ${status}`,
            `Rounds completed: ${rounds.length}`,
            '',
            'Unresolved issues:',
            issueText,
            '',
            'Latest implementation result:',
            lastCoderResult || '(no implementation result was produced)',
            '',
            'Next action:',
            unresolved.length > 0
                ? 'Continue from the unresolved issue list above, starting with critical/high items, then run the smallest relevant verification.'
                : 'Run the relevant project verification once more and finalize.',
        ].join('\n');
    }
    /**

     * Check if two reviews raise similar core issues (convergence detection).

     * Improved: handles camelCase, file paths, short technical terms, and numbers.

     */
    private reviewsAreSimilar(a: string, b: string): boolean {
        const extractKeywords = (text: string): Set<string> => {
            const lower = text.toLowerCase();
            const words = lower.match(/[一-鿿]{2,}|[a-z][a-z0-9]{2,}|\d+\.\d+|[a-z]:\\[^\s]+|\/[a-z][^\s]+/g) || [];
            // Also split camelCase: getUserName → get, user, name
            const expanded: string[] = [];
            for (const w of words) {
                expanded.push(w);
                const camelParts = w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
                if (camelParts.length > 1)
                    expanded.push(...camelParts);
            }
            // Filter out common stop words
            const stops = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'not', 'but', 'have', 'has', 'can', 'will']);
            return new Set(expanded.filter(w => !stops.has(w)));
        };
        const kwA = extractKeywords(a);
        const kwB = extractKeywords(b);
        if (kwA.size === 0 || kwB.size === 0)
            return false;
        let intersection = 0;
        for (const w of kwA) {
            if (kwB.has(w))
                intersection++;
        }
        const union = kwA.size + kwB.size - intersection;
        return (intersection / union) > 0.4; // Slightly lower threshold for better recall
    }
    /**

     * Get the last assistant message content from conversation.

     */
    private getLastAssistantContent(conv: ConversationState): string {
        for (let i = conv.messages.length - 1; i >= 0; i--) {
            const msg = conv.messages[i];
            if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content) {
                return msg.content;
            }
        }
        return '';
    }
    private extractMessageText(content: string | ContentPart[] | null | undefined): string {
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .filter((part) => part.type === 'text')
                .map((part) => part.text || '')
                .join(' ')
                .trim();
        }
        return '';
    }
    private prefersChinese(userInput: string, conv?: ConversationState): boolean {
        const samples = [
            userInput || '',
            ...((conv?.messages || [])
                .filter(m => m.role === 'user')
                .slice(-3)
                .map(m => this.extractMessageText(m.content))),
        ].join('\n');
        return /[\u4e00-\u9fff]/.test(samples);
    }
    private languageInstruction(userInput: string, conv?: ConversationState): string {
        return this.prefersChinese(userInput, conv)
            ? 'Language requirement: the user is using Chinese. Keep all user-visible progress, intermediate prose, recovery messages, and final answers in Chinese. Do not switch to English after tool calls unless quoting source text or code.'
            : 'Language requirement: use the same language as the user for user-visible progress and final answers.';
    }
    private clearInternalStop(convId: string): void {
        this.stoppingConversations.delete(convId);
    }
    /**

     * Continue task with a fresh model call when reasoning loop is detected.

     * This is like "switching to a new dish" — the conversation continues,

     * but we start a new model call with clear instructions.

     */
    private async continueWithFreshModel(conv: ConversationState, progressSummary: string, events: AgentEvents): Promise<string | null> {
        try {
            const endpointId = this.getConversationEndpointId(conv);
            const api = this.getApiForEndpoint(endpointId);
            const useChinese = this.prefersChinese('', conv);
            const recoveryPrompt = useChinese
                ? `[恢复模式] 上一次模型调用陷入了推理循环。你是同一会话中的一次全新模型调用。

停止继续思考。不要重新规划。不要解释内部推理。基于当前进展立即行动。



${progressSummary}



必须遵守：

1. 如果工作已经足够完成，直接输出面向用户的最终中文总结。

2. 如果工作尚未完成，输出简洁中文交接：已完成什么、改动/检查了哪些文件、验证状态、下一步具体命令或动作。

3. 不要重复之前的分析。标题使用“恢复：”或“总结：”，不要使用英文 RECOVERY/SUMMARY。`
                : `[RECOVERY MODE] The previous model call got stuck in a reasoning loop. You are a fresh model call in the same conversation.

Stop thinking. Do not plan again. Do not explain internal reasoning. Act immediately from the current progress.



${progressSummary}



Required behavior:

1. If enough work is already done, output a final user-facing summary now.

2. If work is incomplete, output a concise recovery handoff: completed work, changed files, validation status, exact next command/action.

3. Do not repeat prior analysis. Start the answer with "RECOVERY:" or "SUMMARY:".

4. Do not introduce unrelated configuration guidance such as API keys, provider setup, base URLs, endpoint switching, or settings files unless the progress summary explicitly shows a real configuration/authentication failure in this turn.`;
            // Build a fresh message list with clear instructions
            const freshMessages: ChatMessage[] = [
                {
                    role: 'system',
                    content: recoveryPrompt,
                },
                // Include the original user request
                ...conv.messages.filter(m => m.role === 'user').slice(0, 1),
                // Include recent tool results for context
                ...conv.messages.filter(m => m.role === 'tool').slice(-5),
            ];
            // Make a fresh API call without tools to force direct output
            const params = {
                model: conv.model,
                messages: freshMessages,
                tools: undefined, // No tools — force text output
                stream: false,
                max_tokens: 2000,
            };
            events.onReasoning(useChinese ? `\n\n[恢复] 正在切换到新的模型调用。` : `\n\n[Recovery] Starting a fresh model call...`);
            const content = await api.chatCompletion(params);
            if (content && content.length > 10) {
                return content;
            }
            return null;
        }
        catch (e: any) {
            events.onReasoning(`\n\n[Recovery] Fresh model call failed: ${e.message}`);
            return null;
        }
    }
    /**

     * Ask a fresh model call to produce a useful handoff instead of ending with

     * only "max rounds reached". This preserves session continuity without

     * pretending the task is complete.

     */
    private async finalizeWithFreshModel(conv: ConversationState, progressSummary: string, events: AgentEvents, signal?: AbortSignal): Promise<string | null> {
        try {
            const endpointId = this.getConversationEndpointId(conv);
            const api = this.getApiForEndpoint(endpointId);
            const useChinese = this.prefersChinese('', conv);
            const recentMessages = conv.messages
                .filter(m => m.role === 'assistant' || m.role === 'tool')
                .slice(-8);
            const handoffPrompt = useChinese
                ? `[交接模式] 代理在给出干净最终答案前达到了工具轮次预算。

停止继续思考。不要调用工具。不要继续实现。现在输出一段有用的中文用户交接。



${progressSummary}



输出要求：

- 如果任务看起来基本完成，以“总结：”开头；否则以“恢复：”开头。

- 说明已经完成了什么。

- 说明可能改动或检查过的文件。

- 说明已知验证状态。

- 给出恢复任务的下一步具体动作。

- 保持简洁，不要道歉。`
                : `[HANDOFF MODE] The agent reached its tool-round budget before a clean final answer.

Stop thinking. Do not call tools. Do not continue implementation. Produce a useful user-facing handoff now.



${progressSummary}



Output format:

- Start with "SUMMARY:" if the task appears mostly complete, otherwise "RECOVERY:".

- Mention what was completed.

- Mention files likely changed or inspected.

- Mention validation status if known.

- Give the next concrete step to resume.

- Keep it concise and do not apologize.

- Do not introduce unrelated configuration guidance such as API keys, provider setup, base URLs, endpoint switching, or settings files unless the progress summary explicitly shows a real configuration/authentication failure in this turn.`;
            const messages: ChatMessage[] = [
                {
                    role: 'system',
                    content: handoffPrompt,
                },
                ...conv.messages.filter(m => m.role === 'user').slice(0, 1),
                ...recentMessages,
            ];
            events.onReasoning(useChinese ? `\n\n[交接] 正在生成最终进度摘要。` : `\n\n[Handoff] Generating final recovery summary...`);
            const content = await api.chatCompletion({
                model: conv.model,
                messages,
                stream: false,
                max_tokens: Math.min(2000, this.config.maxTokens || 2000),
                temperature: Math.min(this.config.temperature ?? 0.7, 0.4),
            }, signal);
            return content && content.trim().length > 10 ? content.trim() : null;
        }
        catch (e: any) {
            events.onReasoning(`\n\n[Handoff] Summary generation failed: ${e.message}`);
            return null;
        }
    }
    private buildProgressSummary(conv: ConversationState, reason: string, options: {
        maxRounds?: number;
        softMaxRounds?: number;
        round?: number;
        includeLastAssistant?: boolean;
    } = {}): string {
        const goal = (() => {
            for (let i = conv.messages.length - 1; i >= 0; i--) {
                const msg = conv.messages[i];
                if (msg.role === 'user') {
                    const text = this.extractMessageText(msg.content);
                    if (text)
                        return text;
                }
            }
            return 'unknown task';
        })();
        const toolMessages = conv.messages.filter((msg) => msg.role === 'tool');
        const changedFiles = new Set<string>();
        for (const msg of toolMessages) {
            const toolName = msg._toolName || '';
            if ((toolName === 'edit_file' || toolName === 'write_file') && typeof msg.content === 'string') {
                const match = msg.content.match(/([A-Za-z]:\\[^\r\n]+|\/[^\r\n]+)/);
                if (match)
                    changedFiles.add(match[1].trim());
            }
        }
        const latestAssistant = options.includeLastAssistant === false ? '' : this.getLastAssistantContent(conv);
        const lines = [
            `Task status: ${reason}`,
            `Goal: ${goal.slice(0, 240)}`,
            `Completed tool calls: ${toolMessages.length}`,
        ];
        if (typeof options.round === 'number' && typeof options.maxRounds === 'number') {
            const unlimited = this.isUnlimitedRoundLimit(options.maxRounds);
            lines.push(unlimited
                ? `Progress: round ${options.round} (unlimited budget)`
                : `Progress: round ${options.round} of ${options.maxRounds}`);
            if (typeof options.softMaxRounds === 'number') {
                lines.push(this.isUnlimitedRoundLimit(options.softMaxRounds)
                    ? 'Soft budget: unlimited'
                    : `Soft budget: ${options.softMaxRounds} rounds`);
            }
        }
        if (changedFiles.size > 0) {
            lines.push(`Changed files: ${Array.from(changedFiles).slice(0, 8).join(', ')}`);
        }
        if (latestAssistant) {
            lines.push(`Latest model output: ${latestAssistant.slice(0, 400)}`);
        }
        else if (toolMessages.length > 0) {
            const recentTools = toolMessages
                .slice(-3)
                .map((msg) => `${msg._toolName || 'tool'} -> ${this.extractMessageText(msg.content).slice(0, 160)}`)
                .join(' | ');
            lines.push(`Recent tool results: ${recentTools}`);
        }
        lines.push('Next action: continue from the latest changed files or ask the model to verify and finalize.');
        return lines.join('\n');
    }
    private buildUserFacingProgressSummary(conv: ConversationState, reason: string): string {
        const goal = (() => {
            for (let i = conv.messages.length - 1; i >= 0; i--) {
                const msg = conv.messages[i];
                if (msg.role === 'user') {
                    const text = this.extractMessageText(msg.content);
                    if (text)
                        return text;
                }
            }
            return 'unknown task';
        })();
        const toolMessages = conv.messages.filter((msg) => msg.role === 'tool');
        const changedFiles = new Set<string>();
        for (const msg of toolMessages) {
            const toolName = msg._toolName || '';
            if ((toolName === 'edit_file' || toolName === 'write_file') && typeof msg.content === 'string') {
                const match = msg.content.match(/([A-Za-z]:\\[^\r\n]+|\/[^\r\n]+)/);
                if (match)
                    changedFiles.add(match[1].trim());
            }
        }
        const validationSeen = this.hasRecentValidation(conv);
        return buildUserFacingHandoff(reason, goal, toolMessages.length, Array.from(changedFiles), validationSeen);
    }
    async chatWithSkill(skillName: string, userInput: string, events: AgentEvents, conversationId?: string): Promise<string> {
        const skill = this.skills.get(skillName);
        if (!skill) {
            events.onDone(`Skill '${skillName}' not found`);
            events.onError(`Skill '${skillName}' not found`);
            return `Skill '${skillName}' not found`;
        }
        // Render skill template → inject into system prompt (not user message)
        // This saves context tokens and gives skill instructions more authority
        const rendered = renderSkill(skill, userInput, this.config.workspace);
        return this.chat(userInput, events, undefined, conversationId, rendered);
    }
    // ── Sub-Agent ──
    /**

     * Handle a spawn_subagent tool call within the main agent loop.

     * Returns the sub-agent's output as a string to be fed back as tool result.

     */
    private async handleSpawnSubAgent(args: Record<string, any>, events: AgentEvents, signal?: AbortSignal, convId?: string): Promise<string> {
        const subType = args.type || 'general';
        const task = args.task;
        if (!task)
            return 'Error: spawn_subagent requires a "task" argument';
        const conv = this.conversations.get(convId || this.activeId);
        const model = args.model || conv?.model || this.config.model;
        const endpointId = this.getConversationEndpointId(conv);
        const api = this.getApiForEndpoint(endpointId);
        events.onReasoning(`[Sub-agent] Spawning ${subType} agent: "${task.substring(0, 80)}..."`);
        const subEvents: SubAgentEvents = {
            onStatus: (s) => events.onStatus(`[Sub-agent] ${s}`),
            onToolCallStart: (name, a) => events.onToolCallStart(`[sub] ${name}`, a),
            onToolCallEnd: (name, result, isError, elapsed) => events.onToolCallEnd(`[sub] ${name}`, result, isError, elapsed),
        };
        const result = await runSubAgent({
            type: subType as any,
            task,
            model,
            maxRounds: subType === 'explore' ? 5 : 10,
            worktree: args.worktree,
        }, api, args.worktree || this.config.workspace, this.mcpManager, {
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
            topP: this.config.topP,
            maxOutputLen: this.config.maxOutputLen,
            commandTimeout: this.config.commandTimeout,
            sandbox: this.config.sandbox,
            enableThinking: this.config.enableThinking,
            dependencyInstall: this.config.dependencyInstall,
        }, subEvents, signal);
        events.onReasoning(`[Sub-agent] Done: ${result.rounds} rounds, ${result.toolCalls} tool calls, ${(result.elapsed / 1000).toFixed(1)}s`);
        return result.output;
    }
    // ── TTS / Voice (stubs for future implementation) ──
    /**

     * Generate speech audio from text using the TTS model.

     * TODO: implement when MiMo TTS API is available

     */
    async ttsGenerate(text: string, options?: {
        voice?: string;
        speed?: number;
    }): Promise<{
        audioBase64: string;
        format: string;
    } | null> {
        // Stub: will call MiMo TTS API when available
        console.log('[MiMo] TTS generate (stub):', text.substring(0, 50));
        return null;
    }
    /**

     * Edit/process audio with AI instructions.

     * TODO: implement when MiMo audio API is available

     */
    async audioEdit(audioData: string, instruction: string): Promise<{
        audioBase64: string;
        format: string;
    } | null> {
        // Stub: will call MiMo audio editing API when available
        console.log('[MiMo] Audio edit (stub):', instruction.substring(0, 50));
        return null;
    }
    /**

     * Public API: spawn a sub-agent directly (outside the tool loop).

     * Useful for programmatic use or future UI integration.

     */
    async spawnSubAgent(options: SubAgentOptions, events: SubAgentEvents = {}, signal?: AbortSignal): Promise<SubAgentResult> {
        const endpointId = this.config.activeRoute?.endpoint_id || this.config.activeProviderProfile || '';
        const api = this.getApiForEndpoint(endpointId);
        return runSubAgent(options, api, options.worktree || this.config.workspace, this.mcpManager, {
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
            topP: this.config.topP,
            maxOutputLen: this.config.maxOutputLen,
            commandTimeout: this.config.commandTimeout,
            sandbox: this.config.sandbox,
            enableThinking: this.config.enableThinking,
            dependencyInstall: this.config.dependencyInstall,
        }, events, signal);
    }
}
