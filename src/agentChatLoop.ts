import { ChatMessage, ContentPart, ToolCall } from './api';
import { AgentEvents, ConversationState, CompletionGateDecision, RoundProgress } from './agentTypes';
import { TOOL_DEFINITIONS, executeTool } from './tools';
import { buildSystemPrompt, loadInstructions, validateInstructions } from './prompt';
import { manageContext, getContextStats, summarizeContext, recordTokenUsage } from './context';
import { classifyIntent, checkAdversarialSuitability, quickClassifyIntent, requiresToolBackedAnswer, requiresToolEvidence } from './router';
import { detectPersona, buildPersonaPrompt, getPersona } from './personas';
import { ToolObservation } from './memory';
import { getFriendlyError } from './agentErrors';
import { stripInternalHandoffNoise } from './handoff';
import { PLAN_MODE_ANALYSIS_GUIDANCE, PLAN_MODE_EXECUTION_GUIDANCE } from './planMode';

export async function doChatImpl(
    this: any,
    userInput: string,
    conv: ConversationState,
    events: AgentEvents,
    images?: Array<{dataUrl: string; name: string; size: number}>,
    convId?: string,
    skillPrompt?: string
): Promise<string> {
        const effectiveConvId = convId || this.activeId;
        const chatStartedAt = Date.now();
        const endpointId = this.getConversationEndpointId(conv);
        const api = this.getApiForEndpoint(endpointId);
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
            this.saveConversations();
        }

        // If the selected model is text-only, analyze newly attached images with a
        // vision fallback and feed the text result back into the selected model.
        this.stoppingConversations.delete(effectiveConvId);
        const abortController = new AbortController();
        this.abortControllers.set(effectiveConvId, abortController);
        const signal = abortController.signal;
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
        } else if (images && images.length > 0) {
            userContent = [{ type: 'text', text: userInput }];
            for (const img of images) {
                userContent.push({ type: 'image_url', image_url: { url: img.dataUrl } });
            }
        } else {
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
        const isTrivial =
            PURE_GREETINGS.includes(_lower) ||                          // exact greeting match
            _input.length <= 3 ||                                       // very short: "?", "？", "hi!", "ok"
            /^[!?！？。，、.\-~～…]+$/.test(_input) ||                  // pure punctuation
            /^[\p{Emoji}\s]+$/u.test(_input);                           // pure emoji
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
        } else if (!isComplexOrAnalytical && conv.personaId) {
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
        try {
            if (conv.mode === 'auto') {
                events.onStatus('分析意图...');
                const quickIntent = quickClassifyIntent(userInput);
                const intent = quickIntent || await classifyIntent(api, userInput, conv.model, signal);
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
                const forceToolEvidence = requiresToolBackedAnswer(userInput)
                    && (requiresToolEvidence(userInput)
                        ? !this.hasRecentEvidenceTool?.(conv, userInput)
                        : !this.hasRecentTool?.(conv, [
                            'read_file', 'search_files', 'glob_files', 'list_directory',
                            'get_file_info', 'git_status', 'git_diff', 'git_log',
                            'fetch_url', 'web_search', 'execute_command',
                        ], 80));
                if (forceToolEvidence) {
                    taskComplexity = intent.complexity || 'moderate';
                    events.onReasoning('[Completion gate] This question asks for verification evidence; continuing with tools before answering.');
                }

                // Apply router's suggested persona
                // Priority: router's LLM suggestion > keyword detection
                // (router uses full LLM context analysis, keyword is just substring matching)
                if (intent.suggestedPersona) {
                    const suggested = getPersona(intent.suggestedPersona);
                    if (suggested) {
                        if (!persona) {
                            // No keyword match — use router's suggestion
                            persona = suggested;
                            conv.personaId = suggested.id;
                            events.onReasoning(`[Role: ${suggested.icon} ${suggested.nameZh} (suggested)]`);
                        } else if (persona.id !== suggested.id) {
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
        } catch (e: any) {
            // Ensure cleanup on classifyIntent or handleDirectResponse exception
            if (this.isStopping(effectiveConvId, signal)) {
                events.onDone('(stopped by user)');
            } else {
                events.onDone(`Error: ${e.message}`);
                events.onError(e.message);
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
        } else {
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
            const roundNarration = this.buildRoundNarration(
                round,
                taskComplexity,
                conv,
                stallRounds,
                SOFT_MAX_ROUNDS,
                HARD_MAX_ROUNDS,
                unlimitedRounds,
            );
            events.onStatus(this.buildRoundStatus(round, conv));
            events.onReasoning(roundNarration);

            let systemContent = persona
                ? buildPersonaPrompt(this.systemPrompt, persona)
                : this.systemPrompt;
            systemContent += `\n\n## Runtime Language Discipline\n${this.languageInstruction(userInput, conv)}`;
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
                tools = TOOL_DEFINITIONS.filter(t =>
                    ['schedule_tasks', 'update_todos',
                     'read_file', 'search_files', 'glob_files', 'list_directory',
                     'get_file_info', 'git_status', 'git_diff', 'git_log',
                     'web_search', 'fetch_url', 'ask_user'].includes(t.function.name)
                );
                toolChoice = 'auto';
                systemContent += PLAN_MODE_ANALYSIS_GUIDANCE;
            } else if (conv.mode === 'plan' && conv.planConfirmed) {
                // Plan mode, phase 2: Execute the plan
                systemContent += PLAN_MODE_EXECUTION_GUIDANCE;
            } else if (conv.mode === 'polling') {
                systemContent += `\n\n[Mode: Polling] 轮询模式 — 自主执行，但保持透明。

执行原则：
- 每完成一个逻辑步骤，输出进度（不需要用户确认）
- 文件编辑会显示预览供用户审核
- 遇到需要用户决策的分支点时，使用 ask_user 工具暂停并询问
- 最终输出完整的工作报告（改了什么、为什么、验证结果）`;
            } else if (conv.mode === 'infinite') {
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
            } else {
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
                } catch (e: any) {
                    events.onReasoning(`[上下文压缩失败：${String(e?.message || e).slice(0, 120)}。改用滑动窗口。]`);
                    managedMessages = manageContext(contextSourceMessages, conv.model);
                }
            } else {
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
            if (tools) params.tools = tools;
            if (toolChoice) params.tool_choice = toolChoice;

            let content: string;
            let toolCalls: ToolCall[];
            let reasoningContent = '';
            let reasoningBuffer = '';
            let reasoningWasTrimmed = false;
            const MAX_REASONING_CAPTURE_CHARS = 60_000;
            let lastDetectionLen = 0; // throttle: only re-check every 300+ chars
            let reasoningLoopDetected = false; // guard: prevent multiple abort triggers
            let loopAbortController: AbortController | null = null;
            try {
                loopAbortController = new AbortController();
                signal.addEventListener('abort', () => loopAbortController?.abort(), { once: true });
                const result = await api.chatCompletionsStream(params, {
                    onToken: (t: string) => events.onToken(t),
                    onReasoning: (t: string) => {
                        // Guard: stop processing after loop detection to avoid duplicate triggers
                        if (reasoningLoopDetected) return;

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
                } else {
                    // Fallback: estimate tokens when API doesn't return usage
                    const estTokens = Math.ceil(((content || '').length + reasoningContent.length) / 3);
                    if (estTokens > 0) {
                        events.onTokenUsage?.({ promptTokens: 0, completionTokens: estTokens, totalTokens: estTokens });
                    }
                }
            } catch (e: any) {
                // Reasoning loop detected — inject guidance and retry
                if (reasoningLoopDetected) {
                    this.clearInternalStop(effectiveConvId);
                    reasoningLoopCount++;

                    const gitPushDone = this.detectGitPushDeliveryComplete(conv, userInput);
                    if (gitPushDone.done && gitPushDone.summary) {
                        return this.finishWithLocalSummary(
                            conv,
                            userInput,
                            gitPushDone.summary,
                            events,
                            memoryToolObservations,
                            effectiveConvId,
                            'git_push_delivery.done_after_reasoning_loop',
                            { round, loopCount: reasoningLoopCount, reason: gitPushDone.reason },
                        );
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
                        const continuationResult = await this.continueWithFreshModel(
                            conv,
                            progressSummary,
                            events,
                        );

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
                    const hint = `Model/API rejected max_tokens. Current configured max_tokens is ${this.config.maxTokens}; set Generation > Max Tokens to ${limit} or lower, then retry.`;
                    const summary = `${this.buildProgressSummary(conv, 'model generation parameter rejected by provider', {
                        round,
                        maxRounds: HARD_MAX_ROUNDS,
                        softMaxRounds: SOFT_MAX_ROUNDS,
                    })}
${hint}`;
                    this.learnFromCompletedTurn(userInput, summary, events, memoryToolObservations);
                    events.onDone(summary);
                    events.onError(hint);
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
                        events.onError('Rate limited');
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
                    const fallbackModel = this.findChatModel(conv.model, true, endpointId);
                    if (fallbackModel) {
                        const oldModel = conv.model;
                        conv.model = fallbackModel;
                        conv.modelEndpointId = endpointId;
                        this.saveConversations();
                        events.onReasoning(`[Model fallback] ${oldModel} is not usable for chat on this endpoint. Switched to ${fallbackModel} and retrying.`);
                        events.onStatus(`Model auto-switched to ${fallbackModel} for chat`);
                        events.onModelSwitched?.(this.encodeModelRoute(endpointId, fallbackModel), 'chat');
                        const lastMsg = conv.messages[conv.messages.length - 1];
                        if (lastMsg?.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                            conv.messages.pop();
                        }
                        round--;
                        continue;
                    }
                    const configured = this.getModelList().join(', ');
                    const hint = `Current model: ${conv.model}. Check that this model exists on the configured baseUrl, that the API key has access, and that api.models is configured correctly. Available configured models: ${configured || '(none)'}.`;
                    const summary = `${this.buildProgressSummary(conv, 'model access or compatibility error', {
                        round,
                        maxRounds: HARD_MAX_ROUNDS,
                        softMaxRounds: SOFT_MAX_ROUNDS,
                    })}
Model error: ${hint}`;
                    this.learnFromCompletedTurn(userInput, summary, events, memoryToolObservations);
                    events.onDone(summary);
                    events.onError(`Model error: ${hint}`);
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
                const friendlyError = getFriendlyError(e);
                const summary = `${this.buildProgressSummary(conv, 'task interrupted by API or runtime error', {
                    round,
                    maxRounds: HARD_MAX_ROUNDS,
                    softMaxRounds: SOFT_MAX_ROUNDS,
                })}
${friendlyError}`;
                this.learnFromCompletedTurn(userInput, summary, events, memoryToolObservations);
                events.onDone(summary);
                events.onError(e.message);
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
                assistantMsg.tool_calls = toolCalls;
                // When tool_calls exist, content should be null (not empty string)
                // to match the model's actual response format and avoid API 400 errors.
                if (!content) {
                    assistantMsg.content = null as any;
                }
            } else {
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
                    ? this.shouldContinueInfiniteAfterTextFinal(
                    conv,
                    taskComplexity,
                    finalResponse,
                    round,
                    HARD_MAX_ROUNDS,
                    )
                    : this.shouldContinueAutoAfterTextFinal(
                        conv,
                        taskComplexity,
                        finalResponse,
                        round,
                        HARD_MAX_ROUNDS,
                    );
                if (completionGate.shouldContinue) {
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
                const finalOutput = this.maybeSaveLongFinalResponse(finalWithArtifacts, events);
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
            interface ToolTask { index: number; tc: ToolCall; args: Record<string, any>; parallel: boolean; }
            const skippedToolResults = new Map<number, string>();
            const seenReadOnlyCalls = new Map<string, number>();
            const readFileRanges = this.collectReadFileRangesThisTurn(conv);
            const tasks: ToolTask[] = [];
            toolCalls.forEach((tc, i) => {
                let args: Record<string, any> = {};
                try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
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
                } else {
                    if (currentBatch.length > 0) { batches.push(currentBatch); currentBatch = []; }
                    batches.push([task]);
                }
            }
            if (currentBatch.length > 0) batches.push(currentBatch);
            events.onReasoning(this.describeToolPlan(round, tasks, skippedToolResults.size));

            // Execute each tool (shared logic)
            const execToolCall = async (task: ToolTask): Promise<{ result: string; elapsed: number }> => {
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
                } else if (tc.function.name === 'ask_user') {
                    result = this.canPauseForUserDecision(conv)
                        ? await this.handleAskUser(args, events)
                        : this.buildAutonomousAskUserResult(args, conv.mode);
                } else if (tc.function.name === 'edit_file' && events.onEditPreview && conv.mode === 'polling') {
                    result = await this.handleEditPreview(args, events);
                } else if (tc.function.name === 'write_file' && events.onWritePreview && conv.mode === 'polling') {
                    result = await this.handleWritePreview(args, events);
                } else if (tc.function.name === 'run_workflow') {
                    result = await this.handleWorkflow(args, events, signal, effectiveConvId);
                } else {
                    const preHook = await this.hookManager.runPreHooks(tc.function.name, args, this.config.workspace);
                    if (!preHook.proceed) {
                        result = `Blocked by pre-hook:\n${preHook.output}`;
                    } else {
                        result = this.mcpManager.isMcpTool(tc.function.name)
                            ? await this.mcpManager.callTool(tc.function.name, args)
                            : await executeTool(
                                tc.function.name, args, this.config.workspace,
                                this.config.maxOutputLen, this.config.commandTimeout,
                                this.config.sandbox, conv.mode, this.config.dependencyInstall,
                            );
                        const postHook = await this.hookManager.runPostHooks(tc.function.name, args, result, this.config.workspace);
                        if (postHook.output) result += `\n[Hooks] ${postHook.output}`;
                        if (postHook.shouldBlock) result = `Blocked by post-hook:\n${postHook.output}\n${result}`;
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
                        const fallbackResult = await executeTool(
                            'execute_command',
                            { command: `curl ${curlFlags} --max-time ${timeout} "${safeUrl}" 2>&1 | head -200` },
                            this.config.workspace,
                            this.config.maxOutputLen,
                            this.config.commandTimeout,
                            this.config.sandbox,
                            conv.mode,
                            this.config.dependencyInstall,
                        );
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
                if (this.isStopping(effectiveConvId, signal)) break;

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
                    const results: Array<{ result: string; elapsed: number } | null> = new Array(batch.length).fill(null);

                    const runNext = async (pos: number): Promise<void> => {
                        if (this.isStopping(effectiveConvId, signal)) return;
                        const task = queue[pos];
                        const res = await execToolCall(task);
                        results[pos] = res;
                    };

                    // Simple concurrency limiter
                    const executeAll = async (): Promise<Array<{ result: string; elapsed: number }>> => {
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
                        return results as Array<{ result: string; elapsed: number }>;
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
                } else {
                    // Sequential: single tool
                    if (this.isStopping(effectiveConvId, signal)) break;
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
            } else if (readonlyOnlyRound) {
                readonlyOnlyRounds++;
            } else if (!roundProgress.madeProgress) {
                readonlyOnlyRounds = 0;
            }
            const lowValueReadOnlyLoop = !readOnlyAuditTask && readonlyOnlyRounds >= 3;
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
            } else {
                events.onReasoning(`[进展检查] ${roundProgress.reason}；本轮仍有有效推进。`);
            }

            if (lowValueReadOnlyLoop && progressRecoveryPrompts < 2 && !overSoftBudget && !readOnlyAuditTask) {
                progressRecoveryPrompts++;
                shouldRetryWithProgressRecovery = true;
                const recoveryReason = `连续 ${readonlyOnlyRounds} 轮只读探索，没有检测到修改、验证或明确交付`;
                progressRecoveryInstruction = this.buildProgressRecoveryInstruction(
                    recoveryReason,
                    roundProgress,
                    readonlyOnlyRounds,
                    stallRounds,
                );
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
                return this.finishWithLocalSummary(
                    conv,
                    userInput,
                    gitPushDone.summary,
                    events,
                    memoryToolObservations,
                    effectiveConvId,
                    'git_push_delivery.done',
                    { round, reason: gitPushDone.reason },
                );
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
        const summary = this.maybeSaveLongFinalResponse(summaryWithArtifacts, events);
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
