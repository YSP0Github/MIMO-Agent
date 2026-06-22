/**
 * MiMo Agent Webview 閳?Entry Point
 *
 * Initializes all components and registers the message handler
 * that dispatches host messages to the store and event bus.
 */

import { store } from './core/store';
import { bus } from './core/bus';
import { vscode } from './core/vscode';
import { Header } from './components/header';
import { Messages } from './components/messages';
import { InputArea } from './components/input';
import { Panels } from './components/panels';
import { CommandPalette } from './components/commandPalette';
import { ImageUpload } from './components/imageUpload';
import { CompletionSound } from './components/completionSound';
import { setLang, getWelcomePair, t, getLangToggleText } from './core/i18n';

let activeReplayId = 0;

type QueuedWebviewMessage = Record<string, any> & { type: string };

class RenderQueue {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private frame = 0;
    private reasoningBuffer = '';
    private streamDeltaBuffer = '';
    private latestStreamText: string | undefined;
    private latestStreamHtml: string | undefined;
    private latestStreamLightweight = false;
    private latestStatus: string | undefined;
    private latestTokenUsage: any;
    private pending: QueuedWebviewMessage[] = [];

    enqueue(msg: QueuedWebviewMessage): void {
        switch (msg.type) {
            case 'reasoning':
                this.reasoningBuffer += msg.token || '';
                break;
            case 'streamText':
                this.latestStreamText = msg.text || '';
                break;
            case 'streamDelta':
                this.streamDeltaBuffer += msg.delta || '';
                break;
            case 'streamHtml':
                this.latestStreamHtml = msg.html || '';
                this.latestStreamLightweight = !!msg.lightweight;
                break;
            case 'assistantUpdate':
            case 'verificationUpdate':
            case 'finalAnswer':
                this.latestStreamHtml = undefined;
                this.pending.push(msg);
                break;
            case 'status':
                this.latestStatus = msg.text || '';
                break;
            case 'tokenUsage':
                this.latestTokenUsage = msg.usage;
                break;
            case 'workflowTaskStart':
            case 'workflowTaskEnd':
            case 'workflowPhaseStart':
            case 'workflowPhaseEnd':
            case 'workflowStart':
            case 'workflowEnd':
            case 'toolCallStart':
            case 'toolCallEnd':
                this.pending.push(msg);
                break;
            default:
                this.flush();
                this.dispatch(msg);
                return;
        }
        this.schedule();
    }

    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (this.frame) {
            cancelAnimationFrame(this.frame);
            this.frame = 0;
        }

        const reasoning = this.reasoningBuffer;
        const streamDelta = this.streamDeltaBuffer;
        const streamText = this.latestStreamText;
        const streamHtml = this.latestStreamHtml;
        const streamLightweight = this.latestStreamLightweight;
        const status = this.latestStatus;
        const tokenUsage = this.latestTokenUsage;
        const events = this.pending.splice(0);
        this.reasoningBuffer = '';
        this.streamDeltaBuffer = '';
        this.latestStreamText = undefined;
        this.latestStreamHtml = undefined;
        this.latestStreamLightweight = false;
        this.latestStatus = undefined;
        this.latestTokenUsage = undefined;

        if (reasoning) bus.emit('reasoning', reasoning);
        if (streamDelta) bus.emit('streamDelta', streamDelta);
        if (streamText !== undefined) bus.emit('streamText', streamText);
        if (streamHtml !== undefined) bus.emit('streamHtml', streamHtml, streamLightweight);
        for (const evt of events) this.dispatch(evt);
        if (status !== undefined) {
            store.set('statusText', status);
            const el = document.getElementById('status-text');
            if (el) el.textContent = status;
        }
        if (tokenUsage !== undefined) {
            bus.emit('tokenUsage', tokenUsage);
        }
        bus.emit('renderFlush');
    }

    private schedule(): void {
        if (this.timer || this.frame) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.flush();
            });
        }, 280);
    }

    private dispatch(msg: QueuedWebviewMessage): void {
        switch (msg.type) {
            case 'userMessage': bus.emit('userMessage', msg.text, msg.images); break;
            case 'streamText': bus.emit('streamText', msg.text || ''); break;
            case 'streamDelta': bus.emit('streamDelta', msg.delta || ''); break;
            case 'streamHtml': bus.emit('streamHtml', msg.html, !!msg.lightweight); break;
            case 'assistantUpdate': bus.emit('assistantUpdate', msg.html); break;
            case 'verificationUpdate': bus.emit('verificationUpdate', msg.html); break;
            case 'finalAnswer': bus.emit('finalAnswer', msg.html); break;
            case 'reasoning': bus.emit('reasoning', msg.token); break;
            case 'toolCallStart': bus.emit('toolCallStart', msg.name, msg.args); break;
            case 'toolCallEnd': bus.emit('toolCallEnd', msg.name, msg.result, msg.isError, msg.elapsed, msg.gitDiff); break;
            case 'roundStart': bus.emit('roundStart', msg.round); break;
            case 'done': bus.emit('done', msg.response, msg.elapsedSec); break;
            case 'error': bus.emit('error', msg.error); break;
            case 'system': bus.emit('system', msg.text); break;
            case 'systemI18n': bus.emit('system', t(msg.key)); break;
            case 'clearMessages': bus.emit('clearMessages'); break;
            case 'busy': bus.emit('busy'); break;
            case 'idle': bus.emit('idle'); break;
            case 'workflowStart': bus.emit('workflowStart', msg.totalPhases, msg.totalTasks); break;
            case 'workflowPhaseStart': bus.emit('workflowPhaseStart', msg.phaseIndex, msg.title, msg.mode, msg.taskCount); break;
            case 'workflowTaskStart': bus.emit('workflowTaskStart', msg.phaseIndex, msg.taskIndex, msg.label); break;
            case 'workflowTaskEnd': bus.emit('workflowTaskEnd', msg.phaseIndex, msg.taskIndex, msg.result); break;
            case 'workflowPhaseEnd': bus.emit('workflowPhaseEnd', msg.phaseIndex, msg.result); break;
            case 'workflowEnd': bus.emit('workflowEnd', msg.result); break;
            case 'fileSearchResults': bus.emit('fileSearchResults', msg.results, msg); break;
            default:
                bus.emit(msg.type, msg);
        }
    }
}

const renderQueue = new RenderQueue();

// 閳光偓閳光偓 Initialize welcome text 閳光偓閳光偓
function initWelcome(): void {
    const desc = document.querySelector('.welcome-desc');
    const hint = document.querySelector('.welcome-hint');
    if (!desc || !hint) return;
    if (desc.textContent) return; // Already populated
    const seed = String(Date.now()) + Math.random();
    const pair = getWelcomePair(seed);
    desc.innerHTML = pair.desc;
    hint.innerHTML = pair.hint;
}

// 閳光偓閳光偓 Initialize components 閳光偓閳光偓

function init(): void {
    console.log('[MiMo] initializing components...');

    Header.mount();
    Messages.mount();
    InputArea.mount();
    Panels.mount();
    CommandPalette.mount();
    ImageUpload.mount();
    CompletionSound.mount();
    // 等待扩展端发送语言设置，不要在这里强制设置
    const langBtn = document.getElementById('btn-lang');
    if (langBtn) langBtn.textContent = getLangToggleText();

    // 閳光偓閳光偓 Initialize welcome text with random variant 閳光偓閳光偓
    initWelcome();

    // 閳光偓閳光偓 Register message handler from extension host 閳光偓閳光偓

    window.addEventListener('message', (e: MessageEvent) => {
        const msg = e.data;
        if (!msg || !msg.type) return;

        switch (msg.type) {
            // 閳光偓閳光偓 Tab management 閳光偓閳光偓
            case 'tabList':
                store.set('tabs', msg.tabs);
                store.set('activeTabId', msg.activeId);
                vscode.setWindowState({
                    kind: 'mimo-chat',
                    convIds: Array.isArray(msg.tabs) ? msg.tabs.map((tab: any) => tab.id).filter(Boolean) : [],
                    activeConvId: msg.activeId || '',
                });
                bus.emit('tabList', msg.tabs, msg.activeId);
                break;

            case 'chatCreated':
                // No-op for now
                break;

            // 閳光偓閳光偓 Messages 閳光偓閳光偓
            case 'userMessage':
                renderQueue.enqueue(msg);
                break;

            case 'streamText':
            case 'streamDelta':
                renderQueue.enqueue(msg);
                break;

            case 'streamHtml':
                renderQueue.enqueue(msg);
                break;

            case 'assistantUpdate':
                renderQueue.enqueue(msg);
                break;

            case 'verificationUpdate':
                renderQueue.enqueue(msg);
                break;

            case 'finalAnswer':
                renderQueue.enqueue(msg);
                break;

            case 'streamSegmentEnd':
                renderQueue.flush();
                bus.emit('streamSegmentEnd');
                break;

            case 'reasoning':
                renderQueue.enqueue(msg);
                break;

            case 'toolCallStart':
                renderQueue.enqueue(msg);
                break;

            case 'toolCallEnd':
                renderQueue.enqueue(msg);
                break;

            case 'roundStart':
                renderQueue.enqueue(msg);
                break;

            case 'done':
                renderQueue.flush();
                bus.emit('liveDone');
                bus.emit('done', msg.response, msg.elapsedSec);
                break;

            case 'error':
                renderQueue.flush();
                bus.emit('error', msg.error);
                break;

            case 'system':
                renderQueue.enqueue(msg);
                break;

            case 'systemI18n':
                renderQueue.enqueue(msg);
                break;

            case 'clearMessages':
                renderQueue.flush();
                bus.emit('clearMessages');
                break;

            case 'historyReplayStart':
                activeReplayId = msg.replayId || activeReplayId + 1;
                break;

            case 'historyRender':
                if (msg.replayId && msg.replayId !== activeReplayId) break;
                bus.emit('historyRender', msg.turns || []);
                break;

            case 'fileOpenResult':
                bus.emit('fileOpenResult', msg);
                break;

            case 'fileSearchResults':
                bus.emit('fileSearchResults', msg.results || [], msg);
                break;

            case 'replayBatch':
                if (msg.replayId && msg.replayId !== activeReplayId) break;
                // Three-phase replay for correct ordering:
                // Phase 1: Process lightweight events (tool cards, markers, reasoning) 閳?chunked with yields
                // Phase 2: Process heavy streamHtml events (pre-rendered markdown) 閳?one per frame
                // Phase 3: Fire 'done' events 閳?AFTER all streamHtml, so streamingMsg is intact
                if (msg.events && Array.isArray(msg.events)) {
                    const lightEvents: any[] = [];
                    let latestHeavyEvent: any | undefined;
                    const doneEvents: any[] = [];
                    for (const evt of msg.events) {
                        if (evt.type === 'streamHtml') {
                            latestHeavyEvent = evt;
                        } else if (evt.type === 'done') {
                            doneEvents.push(evt);
                        } else {
                            lightEvents.push(evt);
                        }
                    }

                    // Phase 1: Lightweight events 閳?chunked to avoid blocking UI
                    // Process 15 events per frame (each triggers DOM manipulation)
                    const CHUNK_SIZE = 15;
                    let lightIdx = 0;
                    const processLightChunk = () => {
                        if (msg.replayId && msg.replayId !== activeReplayId) return;
                        const end = Math.min(lightIdx + CHUNK_SIZE, lightEvents.length);
                        for (let i = lightIdx; i < end; i++) {
                            renderQueue.enqueue(lightEvents[i]);
                        }
                        renderQueue.flush();
                        lightIdx = end;
                        if (lightIdx < lightEvents.length) {
                            requestAnimationFrame(processLightChunk);
                        } else {
                            // Phase 1 done 閳?start Phase 2
                            processHeavyPhase2();
                        }
                    };

                    // Phase 2: Heavy streamHtml events 閳?one per frame
                    const processHeavyPhase2 = () => {
                        if (msg.replayId && msg.replayId !== activeReplayId) return;
                        if (latestHeavyEvent) {
                            renderQueue.enqueue(latestHeavyEvent);
                            renderQueue.flush();
                        }
                        fireDone();
                    };

                    // Phase 3: Fire done events
                    const fireDone = () => {
                        if (msg.replayId && msg.replayId !== activeReplayId) return;
                        renderQueue.flush();
                        for (const evt of doneEvents) {
                            bus.emit('done', evt.response, evt.elapsedSec);
                        }
                    };

                    if (lightEvents.length > 0) {
                        requestAnimationFrame(processLightChunk);
                    } else {
                        processHeavyPhase2();
                    }
                }
                break;

            // 閳光偓閳光偓 Status 閳光偓閳光偓
            case 'busy':
                bus.emit('busy');
                break;

            case 'idle':
                bus.emit('idle');
                break;

            case 'status':
                renderQueue.enqueue(msg);
                break;

            // 閳光偓閳光偓 Model 閳光偓閳光偓
            case 'modelList':
                store.set('models', msg.models || []);
                store.set('currentModel', msg.current);
                bus.emit('modelList', msg.models || [], msg.current);
                break;

            case 'modelCaps':
                store.set('modelCaps', msg.caps || { vision: false, tts: false, description: '' });
                bus.emit('modelCaps', msg.caps || {});
                break;

            case 'welcomeUpdate':
                bus.emit('welcomeUpdate', msg.desc, msg.hint);
                break;

            case 'restoreMode':
                store.set('currentMode', msg.mode);
                bus.emit('restoreMode', msg.mode, msg.label);
                break;

            case 'modelSwitched':
                // Auto-switched model for chat or image support.
                store.set('currentModel', msg.model);
                bus.emit('modelList', store.get('models'), msg.model);
                {
                    const option = (store.get('models') as any[]).find(item =>
                        typeof item === 'object' && item && item.value === msg.model
                    );
                    const label = option?.label || msg.model;
                    bus.emit('system', `${t('model.switched')} ${label} ${t(msg.reason === 'image' ? 'model.image.support' : 'model.chat.support')}`);
                }
                break;

            // 閳光偓閳光偓 History 閳光偓閳光偓
            case 'historyList':
                store.set('historyItems', msg.items || []);
                bus.emit('historyList', msg.items || []);
                break;

            case 'restoreInputHistory':
                store.set('inputHistory', Array.isArray(msg.items)
                    ? msg.items.slice(0, 50).map((item: any) => ({
                        text: typeof item === 'string' ? item : String(item?.text || ''),
                        images: Array.isArray(item?.images) ? item.images.slice(0, 12) : null,
                    }))
                    : []);
                store.set('historyIdx', -1);
                break;

            case 'exportResult':
                bus.emit('exportResult', msg.format, msg.content, msg.title);
                break;

            // 閳光偓閳光偓 Settings 閳光偓閳光偓
            case 'settingsData':
                store.set('settingsData', msg.settings || {});
                bus.emit('settingsData', msg.settings || {});
                break;

            // 閳光偓閳光偓 Skills 閳光偓閳光偓
            case 'skillList':
                bus.emit('skillList', msg.skills || []);
                break;

            // 閳光偓閳光偓 Token Usage 閳光偓閳光偓
            case 'tokenUsage':
                bus.emit('tokenUsage', msg.usage);
                break;

            case 'conversationUsage':
                bus.emit('conversationUsage', msg.usage);
                break;

            case 'contextUsage':
                bus.emit('contextUsage', msg.usage);
                break;

            // 閳光偓閳光偓 Edit Preview 閳光偓閳光偓
            case 'editPreview':
                bus.emit('editPreview', msg.previewId, msg.path, msg.oldText, msg.newText, msg.matchCount, msg.lineStart, msg.lineEnd);
                break;

            case 'writePreview':
                bus.emit('writePreview', msg.previewId, msg.filePath, msg.content, msg.isCreate, msg.oldText);
                break;

            case 'askUser':
                bus.emit('askUser', msg.previewId, msg.question, msg.options);
                break;

            case 'stopGuard':
                bus.emit('stopGuard', msg);
                break;

            case 'taskChanges':
                bus.emit('taskChanges', msg.summary);
                break;

            case 'taskChangesUndoResult':
                bus.emit('taskChangesUndoResult', msg);
                break;

            case 'taskChangesRefresh':
                bus.emit('taskChangesRefresh', msg.summary);
                break;

            // 閳光偓閳光偓 Workflow 閳光偓閳光偓
            case 'workflowStart':
                renderQueue.enqueue(msg);
                break;
            case 'workflowPhaseStart':
                renderQueue.enqueue(msg);
                break;
            case 'workflowTaskStart':
                renderQueue.enqueue(msg);
                break;
            case 'workflowTaskEnd':
                renderQueue.enqueue(msg);
                break;
            case 'workflowPhaseEnd':
                renderQueue.enqueue(msg);
                break;
            case 'workflowEnd':
                renderQueue.enqueue(msg);
                break;

            // 閳光偓閳光偓 Adversarial Mode 閳光偓閳光偓
            case 'adversarialTurn':
                bus.emit('adversarialTurn', msg.persona, msg.name, msg.icon, msg.phase, msg.content, msg.iteration);
                break;
            case 'adversarialToolStart':
                bus.emit('adversarialToolStart', msg.persona, msg.toolName, msg.args);
                break;
            case 'adversarialToolEnd':
                bus.emit('adversarialToolEnd', msg.persona, msg.toolName, msg.result, msg.isError, msg.elapsed);
                break;

            // 閳光偓閳光偓 Message Queue 閳光偓閳光偓
            case 'messageQueued':
                bus.emit('messageQueued', msg.text, msg.queueLength);
                break;
            case 'queueProcessed':
                bus.emit('queueProcessed', msg.remaining);
                break;
            case 'clearQueue':
                bus.emit('clearQueue');
                break;

            // 閳光偓閳光偓 Plan Mode 閳光偓閳光偓
            case 'planReady':
                bus.emit('planReady', msg.planContent, msg.planPath);
                break;
            case 'convTitle':
                bus.emit('convTitle', msg.title, msg.convId);
                break;

            case 'setLang':
                setLang(msg.lang);
                // Update lang toggle button text
                const langBtn = document.getElementById('btn-lang');
                if (langBtn) langBtn.textContent = getLangToggleText();
                bus.emit('langChanged');
                break;
            case 'modeSwitched': {
                const key = `mode.${msg.mode}.desc`;
                bus.emit('system', t(key));
                break;
            }
            case 'voiceResult':
                // Stop recording animation
                const voiceBtn2 = document.getElementById('voice-btn');
                if (voiceBtn2) {
                    voiceBtn2.classList.remove('recording');
                    voiceBtn2.title = 'Voice input';
                }
                store.set('isRecording', false);
                // Fill input with transcribed text
                if (msg.text && !msg.error) {
                    const inputEl = document.getElementById('input') as HTMLTextAreaElement;
                    if (inputEl) {
                        inputEl.value = msg.text;
                        inputEl.style.height = 'auto';
                        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
                    }
                } else if (msg.error) {
                    bus.emit('system', `Voice error: ${msg.error}`);
                }
                break;
        }
    });

    // 閳光偓閳光偓 Signal ready to extension host 閳光偓閳光偓
    console.log('[MiMo] sending ready...');
    vscode.ready();
}

// 閳光偓閳光偓 Bootstrap with error handling 閳光偓閳光偓

try {
    init();
} catch (err: any) {
    console.error('[MiMo] init error:', err);
    const el = document.getElementById('messages');
    if (el) {
        const div = document.createElement('div');
        div.className = 'msg msg-system';
        div.textContent = `Init error: ${String(err.message)}`;
        el.appendChild(div);
    }
}
