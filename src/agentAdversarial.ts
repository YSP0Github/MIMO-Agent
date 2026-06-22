import { AgentEvents, ConversationState, TrackedIssue } from './agentTypes';
import { ChatMessage, ContentPart } from './api';
import { TOOL_DEFINITIONS, executeTool } from './tools';
import { runSubAgent } from './subagent';
import { manageContext, recordTokenUsage } from './context';
import { detectPersona, buildPersonaPrompt } from './personas';
import { checkAdversarialSuitability } from './router';

export async function adversarialChatImpl(
    this: any,
    userInput: string,
    events: AgentEvents,
    images?: Array<{dataUrl: string; name: string; size: number}>,
    convId?: string
): Promise<string> {
        const conv = this.conversations.get(convId || this.activeId);
        if (!conv) return 'No active conversation';

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
                } finally {
                    // 恢复对决模式（不影响后续对话的模式选择）
                    conv.mode = originalMode;
                }
            }
        } catch {
            // 检测失败，继续用对决模式（安全降级）
        }

        // Clear any stale stopping state from a previous run
        if (effectiveConvId) this.stoppingConversations.delete(effectiveConvId);

        // Create AbortController for adversarial mode (chat() creates it for normal mode,
        // but adversarialChat is called before that point)
        const abortController = new AbortController();
        this.abortControllers.set(effectiveConvId, abortController);
        const signal = abortController.signal;
        const MAX_ITERATIONS = this.config.adversarial.maxIterations;
        const coder = this.constructor.PERSONAS.programmer;
        const pm = this.constructor.PERSONAS.pm;

        // Save user message to conversation
        let userContent: string | ContentPart[];
        if (images && images.length > 0) {
            userContent = [{ type: 'text', text: userInput }];
            for (const img of images) {
                userContent.push({ type: 'image_url', image_url: { url: img.dataUrl } });
            }
        } else {
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
            const exploreResult = await runSubAgent(
                {
                    type: 'explore',
                    task: `分析以下任务涉及的代码文件、依赖关系和项目结构。找到相关的源文件、配置文件、测试文件。\n\n任务：${userInput}\n\n请输出：\n1. 相关文件列表（路径+简要说明）\n2. 关键代码结构（类/函数/模块关系）\n3. 需要特别注意的边界情况`,
                    maxRounds: 5,
                },
                api, this.config.workspace, this.mcpManager,
                {
                    maxTokens: this.config.maxTokens,
                    temperature: this.config.temperature,
                    topP: this.config.topP,
                    maxOutputLen: this.config.maxOutputLen,
                    commandTimeout: this.config.commandTimeout,
                    sandbox: this.config.sandbox,
                    enableThinking: this.config.enableThinking,
                },
                { onStatus: (s: string) => events.onStatus(`[探索] ${s}`) },
                signal,
            );
            codeContext = exploreResult.output;
            events.onReasoning(`[探索完成] 收集了 ${exploreResult.toolCalls} 个工具调用的上下文 (${(exploreResult.elapsed / 1000).toFixed(1)}s)`);
        } catch (e: any) {
            events.onReasoning(`[探索失败] ${e.message}，继续执行...`);
        }

        let lastCoderResult = '';
        const reviewHistory: string[] = [];
        const coderMessages: ChatMessage[] = []; // Persistent across iterations
        const rounds: Array<{ iteration: number; verdict: string; issueCount: number; elapsed: number }> = [];
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
                const coderResult = await this.runAdversarialPersona(
                    conv, coder, coderContext, events, iteration, 'speak',
                    iteration > 1 ? reviewHistory[reviewHistory.length - 1] : undefined,
                    convId,
                    iteration > 1 ? coderMessages : undefined, // Accumulate context after first round
                );
                lastCoderResult = coderResult.response;
                // Update coderMessages with the full accumulated history
                coderMessages.length = 0;
                coderMessages.push(...coderResult.messages);
            } catch (e: any) {
                events.onError(`${coder.name} error: ${e.message}`);
                exitReason = 'error';
                break;
            }

            try {
                lastDiffSnapshot = await executeTool(
                    'git_diff',
                    {},
                    this.config.workspace,
                    this.config.maxOutputLen,
                    this.config.commandTimeout,
                    this.config.sandbox,
                    conv.mode,
                    this.config.dependencyInstall,
                );
                if (lastDiffSnapshot.startsWith('Tool error:')) {
                    lastDiffSnapshot = '';
                }
            } catch {
                lastDiffSnapshot = '';
            }

            if (this.isStopping(convId || this.activeId, signal)) break;

            // ── Phase 1.5: 验证阶段 — 确认上轮严重问题已修复 ──
            if (iteration > 1 && this.config.adversarial.enableVerification) {
                const criticalIssues = allIssues.filter(
                    i => !i.resolved && (i.severity === 'critical' || i.severity === 'high')
                );
                if (criticalIssues.length > 0) {
                    events.onStatus(`🔍 验证修复... (${criticalIssues.length} 个严重问题)`);
                    try {
                        const verifyResult = await runSubAgent(
                            {
                                type: 'explore',
                                task: `验证以下问题是否已被修复。读取相关文件，检查代码是否已正确修改。\n\n待验证的问题：\n${criticalIssues.map((i: TrackedIssue) => `- ${i.id} ${i.file}:${i.line || '?'} [${i.severity}] ${i.description}`).join('\n')}\n\n对每个问题，输出：\n- FIXED: [问题ID] [简要说明如何确认已修复]\n或\n- NOT_FIXED: [问题ID] [为什么认为未修复]`,
                                maxRounds: 3,
                            },
                            api, this.config.workspace, this.mcpManager,
                            {
                                maxTokens: this.config.maxTokens,
                                temperature: this.config.temperature,
                                topP: this.config.topP,
                                maxOutputLen: this.config.maxOutputLen,
                                commandTimeout: this.config.commandTimeout,
                                sandbox: this.config.sandbox,
                                enableThinking: this.config.enableThinking,
                                dependencyInstall: this.config.dependencyInstall,
                            },
                            { onStatus: (s: string) => events.onStatus(`[验证] ${s}`) },
                            signal,
                        );

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
                        const fixedCount = criticalIssues.filter((i: TrackedIssue) => i.resolved).length;
                        events.onReasoning(`[验证完成] ${fixedCount}/${criticalIssues.length} 个严重问题已确认修复`);
                    } catch (e: any) {
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

            const dimensionResults: Array<{ dim: string; label: string; icon: string; output: string }> = [];
            const reviewPromises = reviewDims.map(async (dim: string) => {
                const dimDef = this.constructor.REVIEW_DIMENSIONS[dim];
                if (!dimDef) return null;
                try {
                    const result = await runSubAgent(
                        {
                            type: 'explore',
                            task: `${dimDef.prompt}\n\n---\n原始需求：${userInput}\n\n${coder.name}的实现：\n${codeSnippet}${contextSnippet}`,
                            maxRounds: 3,
                        },
                        api, this.config.workspace, this.mcpManager, subAgentConfig,
                        { onStatus: (s: string) => events.onStatus(`[${dimDef.icon} ${dimDef.label}] ${s}`) },
                        signal,
                    );
                    return { dim, label: dimDef.label, icon: dimDef.icon, output: result.output };
                } catch (e: any) {
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
                ? dimensionResults.map(dr =>
                    `### ${dr.icon} ${dr.label}\n${dr.output}`
                ).join('\n\n')
                : '(多维审查未返回结果)';

            let pmReview = '';
            try {
                const pmResult = await this.runAdversarialPersona(
                    conv, pm,
                    `你是最终审查者，综合多个专业审查维度的结果做出最终判断。\n\n以下是各维度的审查结果：\n\n${dimensionSummary}\n\n---\n原始需求：${userInput}\n\n${coder.name}的实现摘要：\n${codeSnippet}\n\n当前 git diff 摘要：\n${lastDiffSnapshot ? lastDiffSnapshot.substring(0, 6000) : '(no diff available)'}\n\n必须按下面格式输出，不能省略 VERDICT：\nVERDICT: APPROVED 或 REJECTED\nISSUE: [severity:critical/high/medium/low] [file:line] [问题描述]\nSUGGESTION: [可选改进建议]\n\n判决规则：只要存在 critical/high 问题，或多维审查中有明确未解决问题，必须 REJECTED。只有确认需求完成、没有阻塞问题、且修改可验证时才 APPROVED。`,
                    events, iteration, 'review',
                    undefined, convId,
                );
                pmReview = pmResult.response;
            } catch (e: any) {
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
            const openSevereIssues = allIssues.filter(
                i => !i.resolved && (i.severity === 'critical' || i.severity === 'high')
            );
            if (approved && openSevereIssues.length > 0) {
                events.onReasoning(`[第 ${iteration} 轮] PM 给出通过，但仍有 ${openSevereIssues.length} 个严重问题未验证，继续迭代`);
                approved = false;
            }

            if (approved && pmExtracted.issues.some((i: TrackedIssue) => !i.resolved)) {
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
            const roundIssueCount = allIssues.filter((i: TrackedIssue) => i.round === iteration).length;
            rounds.push({
                iteration,
                verdict: approved ? 'APPROVED' : 'REJECTED',
                issueCount: roundIssueCount,
                elapsed: Date.now() - startTime,
            });

            if (approved) {
                // PM approved — emit final verdict
                const verdictSummary = verdict.suggestions.length > 0
                    ? `\n\n💡 改进建议：\n${verdict.suggestions.map((s: string) => `- ${s}`).join('\n')}`
                    : '';
                events.onAdversarialTurn?.(pm.id, pm.name, pm.icon, 'verdict',
                    `✅ **通过！** 经过 ${iteration} 轮对决，代码质量达标。${verdictSummary}\n\n${pmReview}`, iteration);

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
                const unresolved = allIssues.filter((i: TrackedIssue) => !i.resolved);
                const criticalUnresolved = unresolved.filter((i: TrackedIssue) => i.severity === 'critical' || i.severity === 'high');
                const remainingIssues = criticalUnresolved.length > 0
                    ? `\n\n🔴 未解决的严重问题：\n${criticalUnresolved.map((i: TrackedIssue) => `- [${i.severity}] ${i.file}:${i.line || '?'} — ${i.description}`).join('\n')}`
                    : unresolved.length > 0
                        ? `\n\n残留低优先级问题：\n${unresolved.map((i: TrackedIssue) => `- [${i.severity}] ${i.description}`).join('\n')}`
                        : '';
                events.onAdversarialTurn?.(pm.id, pm.name, pm.icon, 'verdict',
                    `⚠️ **放行** — ${convergence.reason}。${remainingIssues}\n\n${pmReview}`, iteration);

                this.emitAdversarialReport(rounds, allIssues, events);
                conv.messages.push({ role: 'assistant', content: lastCoderResult, reasoning_content: '' });
                this.saveConversations();

                events.onStatus(`[🎭 对决结束] ⚠️ ${convergence.reason} (${iteration} 轮)`);
                events.onDone(lastCoderResult);
                this.finishChat(convId);
                return lastCoderResult;
            }

            // Feed structured issues back to coder for next iteration
            const roundIssues = allIssues.filter((i: TrackedIssue) => i.round === iteration);
            const unresolvedIssues = allIssues.filter((i: TrackedIssue) => !i.resolved);
            const feedbackForCoder = this.buildAdversarialFeedback(
                unresolvedIssues.length > 0 ? unresolvedIssues : roundIssues,
                pmReview,
                lastDiffSnapshot,
            );
            reviewHistory[reviewHistory.length - 1] = feedbackForCoder;
            const issueSummary = roundIssues.length > 0
                ? `${pm.icon} 发现 ${roundIssues.length} 个问题（${roundIssues.filter((i: TrackedIssue) => i.severity === 'critical' || i.severity === 'high').length} 个严重），${coder.icon} 需要修复...`
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
        const doneMsg = this.buildAdversarialFinalSummary(
            exitReason,
            lastCoderResult,
            allIssues,
            rounds,
            MAX_ITERATIONS,
        );
        events.onDone(doneMsg);
        this.finishChat(convId);
        return doneMsg;
}

export async function runAdversarialPersonaImpl(
    this: any,
    conv: ConversationState,
    persona: { id: 'programmer' | 'pm'; name: string; icon: string; color: string; systemPrompt: string },
    task: string,
    events: AgentEvents,
    iteration: number,
    phase: 'speak' | 'review',
    previousFeedback?: string,
    convId?: string,
    existingMessages?: ChatMessage[]
): Promise<{ response: string; messages: ChatMessage[] }> {
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
        } else {
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
            if (this.isStopping(convId || this.activeId, signal)) break;

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
            } else if (phase === 'review') {
                // PM: strictly read-only tools (no execute_command — reviewer must not modify state)
                params.tools = TOOL_DEFINITIONS.filter((t: any) =>
                    ['read_file', 'search_files', 'glob_files', 'list_directory',
                     'get_file_info', 'git_status', 'git_diff', 'git_log'].includes(t.function.name)
                );
                params.tool_choice = 'auto';
            } else {
                // Coder: all tools, freely use them
                params.tools = this.withoutUserPauseTools(TOOL_DEFINITIONS);
                params.tool_choice = 'auto';
            }

            // Stream with persona-specific events
            let roundText = '';
            let reasoningText = '';
            const result = await api.chatCompletionsStream(params, {
                onToken: (t: string) => {
                    roundText += t;
                    events.onAdversarialTurn?.(persona.id, persona.name, persona.icon, phase, t, iteration);
                },
                onReasoning: (t: string) => {
                    reasoningText += t;
                },
            }, signal);

            if (result.reasoningContent) reasoningText = result.reasoningContent;

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
                if (this.isStopping(convId || this.activeId, signal)) break;

                let args: Record<string, any> = {};
                try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
                if (this.mcpManager.isMcpTool(tc.function.name) && /^mcp_mimo_multimodal_/i.test(tc.function.name)) {
                    args = this.prepareBuiltinMultimodalArgs(tc.function.name, args, conv);
                }

                events.onAdversarialToolStart?.(persona.id, tc.function.name, args);
                const t0 = Date.now();

                const toolResult = this.mcpManager.isMcpTool(tc.function.name)
                    ? await this.mcpManager.callTool(tc.function.name, args)
                    : await executeTool(
                        tc.function.name, args, this.config.workspace,
                        this.config.maxOutputLen, this.config.commandTimeout,
                        this.config.sandbox, conv.mode, this.config.dependencyInstall,
                    );

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
