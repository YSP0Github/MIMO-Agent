/**
 * Input component - textarea, send button, mode selector, model select.
 */
import { store, ImageData, InputHistoryItem } from '../core/store';
import { bus } from '../core/bus';
import { vscode } from '../core/vscode';
import { t } from '../core/i18n';

interface AttachedFileRef {
    name: string;
    relativePath: string;
    fullPath: string;
    marker: string;
}

interface FilePickerEntry {
    name: string;
    relativePath: string;
    fullPath: string;
    kind?: 'file' | 'directory';
    depth?: number;
    parent?: string;
}

interface FileTrigger {
    start: number;
    end: number;
    query: string;
}

function sendButtonIcon(kind: 'send' | 'stop'): string {
    if (kind === 'stop') {
        return '<svg class="send-icon send-icon-stop" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
    }
    return '<svg class="send-icon send-icon-plane" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 12 19.5 5.5 13 20 10.6 13.4 4.5 12Z"/><path d="M10.6 13.4 19.5 5.5"/></svg>';
}

export const InputArea = {
    mount(): void {
        const input = document.getElementById('input') as HTMLTextAreaElement;
        const sendBtn = document.getElementById('send') as HTMLButtonElement;
        const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
        const modelTrigger = document.getElementById('model-picker-trigger') as HTMLButtonElement | null;
        const modelPopup = document.getElementById('model-picker-popup') as HTMLElement | null;
        const modelLabel = document.getElementById('model-picker-label') as HTMLElement | null;
        const voiceBtn = document.getElementById('voice-btn') as HTMLButtonElement;
        const reasoningBtn = document.getElementById('reasoning-effort-btn') as HTMLButtonElement;

        if (voiceBtn) {
            voiceBtn.addEventListener('click', () => {
                if (store.get('isRecording')) {
                    store.set('isRecording', false);
                    voiceBtn.classList.remove('recording');
                    voiceBtn.title = t('voice.input.title');
                    vscode.voiceStop();
                } else {
                    store.set('isRecording', true);
                    voiceBtn.classList.add('recording');
                    voiceBtn.title = t('voice.input.title');
                    vscode.voiceInput();
                }
            });
        }

        sendBtn.addEventListener('click', () => {
            const inputEl = document.getElementById('input') as HTMLTextAreaElement;
            const hasText = inputEl && inputEl.value.trim().length > 0;
            if (store.get('isBusy') && !hasText) {
                vscode.stop();
            } else {
                this.doSend();
            }
        });

        let draftText = '';
        let draftImages: ImageData[] = [];

        input.addEventListener('keydown', (e) => {
            if (this._handleFileSearchKeydown(e, input)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                if (document.getElementById('cmd-palette')?.classList.contains('show')) return;
                e.preventDefault();
                this.doSend();
                return;
            }
            if (e.key === 'ArrowUp' && !e.shiftKey && !e.isComposing) {
                const history = store.get('inputHistory');
                let idx = store.get('historyIdx');

                const lines = input.value.substring(0, input.selectionStart).split('\n');
                const atFirstLine = lines.length <= 1;
                const atLineStart = lines[lines.length - 1].length === 0 || input.selectionStart === 0;

                if (idx === -1 && history.length > 0) {
                    if (!atFirstLine || !atLineStart) return;
                    e.preventDefault();
                    draftText = input.value;
                    draftImages = store.get('images').slice();
                    idx = 0;
                    store.set('historyIdx', idx);
                    this.applyHistoryEntry(input, history[idx]);
                } else if (idx >= 0 && idx < history.length - 1) {
                    if (!atFirstLine || !atLineStart) return;
                    e.preventDefault();
                    idx++;
                    store.set('historyIdx', idx);
                    this.applyHistoryEntry(input, history[idx]);
                }
                return;
            }

            if (e.key === 'ArrowDown' && !e.shiftKey && !e.isComposing) {
                const history = store.get('inputHistory');
                let idx = store.get('historyIdx');

                if (idx >= 0) {
                    const lines = input.value.substring(input.selectionStart).split('\n');
                    const atLastLine = lines.length <= 1;
                    const atLineEnd = input.selectionStart >= input.value.length;
                    if (!atLastLine || !atLineEnd) return;

                    e.preventDefault();
                    idx--;
                    store.set('historyIdx', idx);
                    if (idx >= 0) {
                        this.applyHistoryEntry(input, history[idx]);
                    } else {
                        input.value = draftText;
                        draftText = '';
                        store.set('images', draftImages.slice());
                        draftImages = [];
                        bus.emit('imagesChanged');
                    }
                    this.autoResize(input);
                    input.setSelectionRange(input.value.length, input.value.length);
                }
                return;
            }
        });

        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            this._syncInputRender(input);
            this._syncAttachedFilesFromText(input.value);
            this._updateHashFileSearch(input);
            bus.emit('inputChanged', input.value);
            if (store.get('isBusy')) this.updateSendButton();
        });
        const modeTrigger = document.getElementById('mode-trigger')!;
        const modePopup = document.getElementById('mode-popup')!;
        const modeLabel = document.getElementById('mode-label')!;
        const getModeLabel = (mode: string): string => t(mode);

        input.placeholder = t('paste.hint');

        modeTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const shouldOpen = !modePopup.classList.contains('show');
            this._closeInputPopovers('mode');
            modePopup.classList.toggle('show', shouldOpen);
        });

        modePopup.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.addEventListener('click', (e) => {
            if (!modePopup.classList.contains('show')) return;
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (modePopup.contains(target) || modeTrigger.contains(target)) return;
            modePopup.classList.remove('show');
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this._closeInputPopovers();
            }
        });

        const modeOptions = modePopup.querySelectorAll('.mode-option');
        for (let i = 0; i < modeOptions.length; i++) {
            modeOptions[i].addEventListener('click', (e) => {
                e.stopPropagation();
                const mode = (e.currentTarget as HTMLElement).getAttribute('data-mode') as string;
                store.set('currentMode', mode as any);
                for (let j = 0; j < modeOptions.length; j++) modeOptions[j].classList.remove('active');
                (e.currentTarget as HTMLElement).classList.add('active');
                modeLabel.textContent = getModeLabel(mode);
                modePopup.classList.remove('show');
                document.getElementById('input-wrapper')!.className = `mode-${mode}`;
                this.syncBodyUiClasses();
                vscode.setMode(mode);
            });
        }

        modelSelect.addEventListener('change', () => {
            vscode.setModel(modelSelect.value);
        });

        if (modelTrigger && modelPopup) {
            modelTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const shouldOpen = !modelPopup.classList.contains('show');
                this._closeInputPopovers('model');
                modelPopup.classList.toggle('show', shouldOpen);
                // 动态定位弹窗，避免在窄屏时被遮挡
                if (modelPopup.classList.contains('show')) {
                    this.alignModelPopup(modelPopup, modelTrigger);
                }
            });
            modelPopup.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = (e.target as HTMLElement | null)?.closest?.('[data-model-value]') as HTMLElement | null;
                if (!item) return;
                const value = item.getAttribute('data-model-value') || '';
                if (!value) return;
                modelSelect.value = value;
                modelPopup.querySelectorAll('.model-picker-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                if (modelLabel) modelLabel.textContent = item.getAttribute('data-model-label') || value;
                modelPopup.classList.remove('show');
                vscode.setModel(value);
            });
            document.addEventListener('click', (e) => {
                if (!modelPopup.classList.contains('show')) return;
                const target = e.target as HTMLElement | null;
                if (!target) return;
                if (modelPopup.contains(target) || modelTrigger.contains(target)) return;
                modelPopup.classList.remove('show');
            });
        }

        if (reasoningBtn) {
            reasoningBtn.addEventListener('click', () => {
                this._closeInputPopovers();
                const current = store.get('reasoningEffort');
                const order = ['turbo', 'fast', 'balanced', 'deep', 'max'] as const;
                const idx = order.indexOf(current as any);
                const next = order[((idx >= 0 ? idx : 2) + 1) % order.length];
                store.set('reasoningEffort', next);
                this.updateReasoningButton();
                this.syncBodyUiClasses();
                vscode.setReasoningEffort(next);
            });
        }

        bus.on('modelList', (models: Array<string | { value: string; label?: string; model?: string; endpointId?: string; endpointName?: string }>, current: string) => {
            modelSelect.innerHTML = '';
            const seen = new Set<string>();
            const flatOptions: Array<{ value: string; label: string; model?: string; endpointId?: string; endpointName?: string }> = [];
            const decodeRoute = (value: string): { endpointId: string; model: string } => {
                const text = String(value || '');
                const idx = text.indexOf('::');
                if (idx <= 0) return { endpointId: '', model: text };
                return { endpointId: text.slice(0, idx), model: text.slice(idx + 2) };
            };
            const cleanLabel = (option: { value: string; label?: string; model?: string; endpointName?: string }): string => {
                const decoded = decodeRoute(option.value);
                return option.model || decoded.model || option.label || option.value;
            };

            for (const item of models) {
                const value = typeof item === 'string' ? item : item?.value;
                if (!value) continue;
                const decoded = decodeRoute(value);
                const model = typeof item === 'string' ? decoded.model || value : (item?.model || decoded.model || value);
                const endpointId = typeof item === 'string' ? decoded.endpointId : (item?.endpointId || decoded.endpointId);
                const endpointName = typeof item === 'string' ? '' : item?.endpointName;
                const key = `${endpointId || ''}::${model}`;
                if (seen.has(key)) continue;
                seen.add(key);
                flatOptions.push({
                    value,
                    label: cleanLabel({ value, label: typeof item === 'string' ? value : item?.label, model, endpointName }),
                    model,
                    endpointId,
                    endpointName,
                });
            }

            const resolvedCurrent = flatOptions.find(option => option.value === current)?.value
                || flatOptions.find(option => option.model === current)?.value
                || current;
            const routed = flatOptions.filter(option => option.endpointId || option.endpointName);
            if (routed.length > 0) {
                const groups = new Map<string, { label: string; options: typeof flatOptions }>();
                for (const option of flatOptions) {
                    const key = option.endpointId || option.endpointName || '';
                    if (!groups.has(key)) {
                        groups.set(key, { label: option.endpointName || option.endpointId || t('model.label'), options: [] });
                    }
                    groups.get(key)!.options.push(option);
                }
                for (const group of groups.values()) {
                    const optgroup = document.createElement('optgroup');
                    optgroup.label = group.label;
                    for (const option of group.options) {
                        const opt = document.createElement('option');
                        opt.value = option.value;
                        opt.textContent = option.model || option.label || option.value;
                        if (option.value === resolvedCurrent) opt.selected = true;
                        optgroup.appendChild(opt);
                    }
                    modelSelect.appendChild(optgroup);
                }
            } else {
                for (const option of flatOptions) {
                    const opt = document.createElement('option');
                    opt.value = option.value;
                    opt.textContent = option.label || option.value;
                    if (option.value === resolvedCurrent) opt.selected = true;
                    modelSelect.appendChild(opt);
                }
            }
            const currentRoute = decodeRoute(resolvedCurrent || '');
            const currentKey = `${currentRoute.endpointId || ''}::${currentRoute.model || resolvedCurrent || ''}`;
            if (resolvedCurrent && !seen.has(currentKey)) {
                const opt = document.createElement('option');
                opt.value = resolvedCurrent;
                opt.textContent = `${currentRoute.model || resolvedCurrent} (current)`;
                opt.selected = true;
                modelSelect.appendChild(opt);
                flatOptions.push({
                    value: resolvedCurrent,
                    label: `${currentRoute.model || resolvedCurrent} (current)`,
                    model: currentRoute.model || resolvedCurrent,
                    endpointId: currentRoute.endpointId,
                    endpointName: '',
                });
            }
            store.set('models', flatOptions);
            store.set('currentModel', resolvedCurrent || modelSelect.value || '');
            this.renderModelPicker(flatOptions, resolvedCurrent || modelSelect.value || '');
        });

        bus.on('settingsData', (settings: Record<string, any>) => {
            const effort = this.normalizeReasoningEffort(settings.reasoning_effort, settings.enable_thinking);
            store.set('reasoningEffort', effort);
            this.updateReasoningButton();
            this.syncBodyUiClasses();
        });
        bus.on('langChanged', () => {
            this.updateReasoningButton();
            this.renderModelPicker(
                store.get('models') as Array<{ value: string; label: string; model?: string; endpointId?: string; endpointName?: string }>,
                store.get('currentModel'),
            );
        });

        // Initialize file reference feature
        this._initFileSearch();

        if (voiceBtn) {
            voiceBtn.style.display = 'none';
            store.set('voiceEnabled', false);
        }

        bus.on('restoreMode', (mode: string) => {
            const label = document.getElementById('mode-label');
            if (label) {
                label.textContent = t(mode);
                label.setAttribute('data-i18n', mode);
            }
            document.getElementById('input-wrapper')!.className = `mode-${mode}`;
            this.syncBodyUiClasses();
            const opts = document.querySelectorAll('.mode-option');
            for (let i = 0; i < opts.length; i++) {
                opts[i].classList.remove('active');
                if ((opts[i] as HTMLElement).getAttribute('data-mode') === mode) {
                    opts[i].classList.add('active');
                }
            }
        });

        bus.on('busy', () => this.setBusy(true));
        bus.on('idle', () => {
            this.setBusy(false);
            if (store.get('skipNextQueueAutoSend')) {
                store.set('skipNextQueueAutoSend', false);
                return;
            }
            const queued = store.get('queuedMsgs');
            if (queued.length > 0) {
                const next = queued[0];
                const remaining = queued.slice(1);
                store.set('queuedMsgs', remaining);
                bus.emit('queueProcessed', remaining.length);
                vscode.send(next.text, next.images);
            }
        });
        bus.on('clearQueue', () => {
            store.set('queuedMsgs', []);
        });
        bus.on('editQueuedMessage', (text: string, images: any[] | null) => {
            input.value = text || '';
            this.autoResize(input);
            this._syncInputRender(input);
            store.set('images', images || []);
            bus.emit('imagesChanged');
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            this.updateSendButton();
        });
        input.addEventListener('mousemove', (e) => this._updateFileReferenceHover(input, e));
        input.addEventListener('mouseleave', () => this._hideFileReferenceHover());
        input.addEventListener('scroll', () => {
            this._syncInputRender(input);
            this._hideFileReferenceHover();
        });
        input.addEventListener('blur', () => this._hideFileReferenceHover());
        this.updateReasoningButton();
        this.updateSendButton();
        vscode.getSettings();
    },

    normalizeReasoningEffort(value: unknown, enableThinking?: unknown): 'turbo' | 'fast' | 'balanced' | 'deep' | 'max' {
        if (value === 'turbo' || value === 'fast' || value === 'balanced' || value === 'deep' || value === 'max') return value;
        if (value === 'off' || value === 'low') return 'fast';
        if (value === 'auto' || value === 'medium') return 'balanced';
        if (value === 'high') return 'deep';
        return enableThinking ? 'deep' : 'balanced';
    },

    escapeHtml(value: string): string {
        return String(value || '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch] || ch));
    },

    modelBadges(model: string): string[] {
        const text = String(model || '').toLowerCase();
        const badges: string[] = [];
        if (/tts|voice|speech|audio/.test(text)) badges.push(t('badge.tts'));
        if (/asr|transcribe|whisper/.test(text)) badges.push(t('badge.asr'));
        if (/vision|vl|omni|image/.test(text)) badges.push(t('badge.vision'));
        if (/flash|lite|mini/.test(text)) badges.push(t('badge.fast'));
        return badges.slice(0, 2);
    },

    renderModelPicker(options: Array<{ value: string; label: string; model?: string; endpointId?: string; endpointName?: string }>, current: string): void {
        const popup = document.getElementById('model-picker-popup') as HTMLElement | null;
        const label = document.getElementById('model-picker-label') as HTMLElement | null;
        if (!popup || !label) return;
        const currentOption = options.find(option => option.value === current) || options[0];
        label.textContent = currentOption?.model || currentOption?.label || current || 'Model';

        const groups = new Map<string, { label: string; options: typeof options }>();
        for (const option of options) {
            const key = option.endpointId || option.endpointName || 'default';
            if (!groups.has(key)) {
                groups.set(key, {
                    label: option.endpointName || option.endpointId || t('model.label'),
                    options: [],
                });
            }
            groups.get(key)!.options.push(option);
        }

        const html: string[] = [];
        for (const group of groups.values()) {
            html.push(`<div class="model-picker-group"><div class="model-picker-group-title">${this.escapeHtml(group.label)}</div>`);
            for (const option of group.options) {
                const model = option.model || option.label || option.value;
                const active = option.value === current ? ' active' : '';
                const badges = this.modelBadges(model)
                    .map(badge => `<span class="model-picker-badge">${this.escapeHtml(badge)}</span>`)
                    .join('');
                html.push(
                    `<button class="model-picker-item${active}" type="button" data-model-value="${this.escapeHtml(option.value)}" data-model-label="${this.escapeHtml(model)}">` +
                    `<span class="model-picker-dot"></span>` +
                    `<span class="model-picker-main"><span class="model-picker-name">${this.escapeHtml(model)}</span></span>` +
                    `<span class="model-picker-badges">${badges}</span>` +
                    `</button>`,
                );
            }
            html.push('</div>');
        }
        popup.innerHTML = html.join('');
    },

    updateReasoningButton(): void {
        const btn = document.getElementById('reasoning-effort-btn') as HTMLButtonElement | null;
        if (!btn) return;
        const effort = store.get('reasoningEffort');
        const labels: Record<string, string> = {
            turbo: t('reasoning.turbo'),
            fast: t('reasoning.fast'),
            balanced: t('reasoning.balanced'),
            deep: t('reasoning.deep'),
            max: t('reasoning.max'),
        };
        const titles: Record<string, string> = {
            turbo: t('reasoning.turbo.tip'),
            fast: t('reasoning.fast.tip'),
            balanced: t('reasoning.balanced.tip'),
            deep: t('reasoning.deep.tip'),
            max: t('reasoning.max.tip'),
        };
        btn.textContent = labels[effort];
        btn.setAttribute('aria-label', `${t('reasoning.prefix')}: ${labels[effort]}`);
        btn.setAttribute('data-effort', effort);
        btn.title = titles[effort];
        this.syncBodyUiClasses();
    },

    _closeInputPopovers(except: 'mode' | 'model' | 'file' | 'command' | null = null): void {
        if (except !== 'mode') document.getElementById('mode-popup')?.classList.remove('show');
        if (except !== 'model') document.getElementById('model-picker-popup')?.classList.remove('show');
        if (except !== 'command') document.getElementById('cmd-palette')?.classList.remove('show');
        if (except !== 'file') this._closeFileSearch();
    },

    syncBodyUiClasses(): void {
        const mode = store.get('currentMode') || 'auto';
        const effort = store.get('reasoningEffort');
        document.body.classList.remove('mode-auto', 'mode-polling', 'mode-plan', 'mode-adversarial', 'ui-minimal');
        document.body.classList.add(`mode-${mode}`);
        document.body.classList.toggle('ui-minimal', effort === 'turbo');
    },

    doSend(): void {
        const input = document.getElementById('input') as HTMLTextAreaElement;
        const text = input.value.trim();
        const images = store.get('images');
        const hasFiles = this._attachedFiles.length > 0;
        if (!text && images.length === 0 && !hasFiles) return;

        const resolvedText = this._resolveFileMarkers(text);

        // Close file search if open
        this._closeInputPopovers();
        // Clear file tags
        this._attachedFiles = [];
        this._renderFileTags();

        const imgs = images.slice();
        this.saveToHistory(text, imgs);
        input.value = '';
        input.style.height = 'auto';
        this._syncInputRender(input);
        store.set('historyIdx', -1);
        store.set('images', []);
        bus.emit('clearImages');

        if (text.charAt(0) === '/') {
            const sp = text.indexOf(' ');
            const cmd = sp > 0 ? text.substring(1, sp) : text.substring(1);
            const rest = sp > 0 ? text.substring(sp + 1) : '';
            if (cmd === 'clear') {
                bus.emit('clearMessages');
                vscode.clear();
                return;
            }
            vscode.skill(cmd, rest);
            return;
        }

        if (store.get('isBusy')) {
            const queued = store.get('queuedMsgs');
            store.set('queuedMsgs', [...queued, { text: resolvedText, images: imgs.length > 0 ? imgs : null }]);
            bus.emit('messageQueued', text, queued.length + 1);
            this.updateSendButton();
            return;
        }

        vscode.send(resolvedText, imgs.length > 0 ? imgs : null);
    },

    applyHistoryEntry(input: HTMLTextAreaElement, entry: InputHistoryItem): void {
        input.value = entry.text || '';
        this._syncInputRender(input);
        store.set('images', (entry.images || []).slice());
        bus.emit('imagesChanged');
        this.autoResize(input);
        input.setSelectionRange(input.value.length, input.value.length);
    },

    sameHistoryImages(a: ImageData[] | null | undefined, b: ImageData[] | null | undefined): boolean {
        const left = a || [];
        const right = b || [];
        if (left.length !== right.length) return false;
        return left.every((img, index) =>
            img?.dataUrl === right[index]?.dataUrl &&
            img?.name === right[index]?.name &&
            img?.size === right[index]?.size
        );
    },

    saveToHistory(text: string, images: ImageData[] = []): void {
        if (!text && images.length === 0) return;
        const history = store.get('inputHistory');
        const nextEntry: InputHistoryItem = {
            text,
            images: images.length > 0 ? images.slice() : null,
        };
        const first = history[0];
        if (first && first.text === nextEntry.text && this.sameHistoryImages(first.images, nextEntry.images)) return;
        history.unshift(nextEntry);
        if (history.length > 50) history.pop();
        store.set('inputHistory', history);
        store.set('historyIdx', -1);
    },

    /**
     * 对齐弹窗位置，避免在窄屏时被遮挡
     */
    alignPopup(popup: HTMLElement, trigger: HTMLElement): void {
        // 重置定位
        popup.classList.remove('align-left', 'align-right');
        popup.style.left = '';
        popup.style.right = '';

        requestAnimationFrame(() => {
            const viewportWidth = window.innerWidth;
            const triggerRect = trigger.getBoundingClientRect();
            const popupWidth = Math.min(360, viewportWidth - 28);

            // 计算弹窗左边界位置（右对齐触发按钮）
            const popupLeft = triggerRect.right - popupWidth;

            // 如果左边界超出视口左侧，改为左对齐
            if (popupLeft < 8) {
                popup.classList.add('align-left');
                popup.style.left = '8px';
                popup.style.right = 'auto';
            }
            // 如果右边界超出视口右侧，调整位置
            else if (triggerRect.right > viewportWidth - 8) {
                popup.style.left = `${viewportWidth - popupWidth - 8}px`;
                popup.style.right = 'auto';
            }
            // 默认右对齐
            else {
                popup.style.right = `${viewportWidth - triggerRect.right}px`;
                popup.style.left = 'auto';
            }
        });
    },

    alignModelPopup(popup: HTMLElement, trigger: HTMLElement): void {
        popup.classList.remove('align-left', 'align-right');
        popup.style.left = '';
        popup.style.right = '';

        requestAnimationFrame(() => {
            const viewportWidth = window.innerWidth;
            const triggerRect = trigger.getBoundingClientRect();
            const popupWidth = Math.min(360, Math.max(160, viewportWidth - 28));
            const offsetParent = (popup.offsetParent as HTMLElement | null) || popup.parentElement;
            const parentRect = offsetParent?.getBoundingClientRect();
            const minViewportLeft = 8;
            const maxViewportLeft = Math.max(minViewportLeft, viewportWidth - popupWidth - 8);
            const desiredViewportLeft = triggerRect.right - popupWidth;
            const clampedViewportLeft = Math.min(maxViewportLeft, Math.max(minViewportLeft, desiredViewportLeft));
            const relativeLeft = parentRect ? clampedViewportLeft - parentRect.left : clampedViewportLeft;

            popup.style.left = `${relativeLeft}px`;
            popup.style.right = 'auto';
            popup.classList.add(clampedViewportLeft <= minViewportLeft ? 'align-left' : 'align-right');
        });
    },

    autoResize(textarea: HTMLTextAreaElement): void {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        this._syncInputRender(textarea);
    },

    setBusy(busy: boolean): void {
        store.set('isBusy', busy);
        this.updateSendButton();
        const statusBar = document.getElementById('status-bar')!;
        if (busy) statusBar.classList.add('active');
        else statusBar.classList.remove('active');
    },

    updateSendButton(): void {
        const sendBtn = document.getElementById('send') as HTMLButtonElement;
        const input = document.getElementById('input') as HTMLTextAreaElement;
        const busy = store.get('isBusy');
        const hasText = input && input.value.trim().length > 0;
        const hasQueued = store.get('queuedMsgs').length > 0;

        if (busy && !hasText && hasQueued) {
            sendBtn.innerHTML = sendButtonIcon('send');
            sendBtn.className = 'run-queued-btn';
            sendBtn.title = t('queue.run.next.title');
        } else if (busy && !hasText) {
            sendBtn.innerHTML = sendButtonIcon('stop');
            sendBtn.className = 'stop-btn';
            sendBtn.title = t('stop');
        } else {
            sendBtn.innerHTML = sendButtonIcon('send');
            sendBtn.className = '';
            sendBtn.title = busy ? t('send.queued') : t('send');
            sendBtn.title = busy ? t('send.queued') : t('send');
        }
    },

    // ── File Reference Feature (button-based) ──

    _attachedFiles: [] as AttachedFileRef[],
    _searchDebounce: null as ReturnType<typeof setTimeout> | null,
    _fileSearchMode: 'button' as 'button' | 'hash',
    _fileTrigger: null as FileTrigger | null,
    _fileSearchResults: [] as AttachedFileRef[],
    _activeFileSearchIndex: 0,
    _fileSearchRequestTimer: null as ReturnType<typeof setTimeout> | null,
    _hoveredFilePath: '',
    _hoverFrame: 0,
    _lastHoverEvent: null as { input: HTMLTextAreaElement; clientX: number; clientY: number } | null,

    _initFileSearch(): void {
        const addBtn = document.getElementById('add-file-btn') as HTMLButtonElement | null;
        if (!addBtn) return;
        if ((addBtn as any)._mimoFileSearchBound) return;
        (addBtn as any)._mimoFileSearchBound = true;

        // Create popup with search input
        const inputWrapper = document.getElementById('input-wrapper');
        if (!inputWrapper) return;
        let popup = document.getElementById('file-search-popup') as HTMLElement | null;
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'file-search-popup';
            popup.className = 'file-search-popup';
            popup.innerHTML = '<input type="text" id="file-search-input" class="file-search-input" placeholder="Search files..." autocomplete="off" spellcheck="false">';
            inputWrapper.appendChild(popup);
        }

        const searchInput = popup.querySelector('#file-search-input') as HTMLInputElement;
        if (!searchInput) return;

        // Button click -> toggle popup
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (popup.classList.contains('show')) {
                this._closeFileSearch();
            } else {
                this._closeInputPopovers('file');
                this._openFileSearch('button', '', null, true);
            }
        });

        // Search input with debounce
        searchInput.addEventListener('input', () => {
            if (this._searchDebounce) clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => {
                this._fileSearchMode = 'button';
                this._fileTrigger = null;
                vscode.searchFiles(searchInput.value.trim());
            }, 200);
        });

        // Prevent keydown from reaching the main input
        searchInput.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                this._closeFileSearch();
                return;
            }
            if (this._handleFileSearchKeydown(e)) {
                return;
            }
        });

        // Listen for results
        bus.on('fileSearchResults', (results: FilePickerEntry[], meta?: { shown?: number; total?: number; truncated?: boolean; query?: string }) => {
            this._renderFileSearchResults(results, meta);
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            const popupEl = document.getElementById('file-search-popup');
            const addBtnEl = document.getElementById('add-file-btn');
            const target = e.target as HTMLElement;
            if (popupEl && popupEl.classList.contains('show') && !popupEl.contains(target) && target !== addBtnEl) {
                this._closeFileSearch();
            }
        });
    },

    _openFileSearch(mode: 'button' | 'hash', query = '', trigger: FileTrigger | null = null, focusSearch = false, debounce = false): void {
        const popup = document.getElementById('file-search-popup') as HTMLElement | null;
        const searchInput = document.getElementById('file-search-input') as HTMLInputElement | null;
        if (!popup || !searchInput) return;
        this._fileSearchMode = mode;
        this._fileTrigger = trigger;
        this._activeFileSearchIndex = 0;
        this._closeInputPopovers('file');
        popup.dataset.mode = mode;
        popup.classList.add('show');
        searchInput.value = query;
        if (focusSearch) searchInput.focus();
        this._renderFileSearchLoading(query ? 'Searching project files...' : 'Loading project file tree...');
        if (debounce) {
            if (this._searchDebounce) clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => vscode.searchFiles(query), 200);
        } else {
            vscode.searchFiles(query);
        }
        if (this._fileSearchRequestTimer) clearTimeout(this._fileSearchRequestTimer);
        this._fileSearchRequestTimer = setTimeout(() => {
            const openPopup = document.getElementById('file-search-popup');
            if (!openPopup?.classList.contains('show')) return;
            if (openPopup.querySelector('.file-search-list')) return;
            this._renderFileSearchMessage('No file tree response yet. Try reopening the picker.');
        }, 2500);
    },

    _updateHashFileSearch(input: HTMLTextAreaElement): void {
        const trigger = this._getHashFileTrigger(input);
        const popup = document.getElementById('file-search-popup');
        if (!trigger) {
            if (this._fileSearchMode === 'hash') this._closeFileSearch();
            return;
        }
        this._openFileSearch('hash', trigger.query, trigger, false, true);
    },

    _getHashFileTrigger(input: HTMLTextAreaElement): FileTrigger | null {
        const cursor = input.selectionStart;
        if (cursor !== input.selectionEnd) return null;
        const before = input.value.slice(0, cursor);
        const match = /(^|\s)#([^\s#]*)$/.exec(before);
        if (!match) return null;
        const query = match[2] || '';
        const start = before.length - query.length - 1;
        return { start, end: cursor, query };
    },

    _handleFileSearchKeydown(e: KeyboardEvent, input?: HTMLTextAreaElement): boolean {
        const popup = document.getElementById('file-search-popup');
        if (!popup?.classList.contains('show')) return false;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._setActiveFileSearchIndex(this._activeFileSearchIndex + 1);
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._setActiveFileSearchIndex(this._activeFileSearchIndex - 1);
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            const item = this._fileSearchResults[this._activeFileSearchIndex];
            if (item) {
                e.preventDefault();
                this._insertFileReference(item.fullPath, item.name, item.relativePath, input);
                return true;
            }
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            this._closeFileSearch();
            return true;
        }
        return false;
    },

    _renderFileSearchResults(results: FilePickerEntry[], meta?: { shown?: number; total?: number; truncated?: boolean; query?: string }): void {
        const popup = document.getElementById('file-search-popup');
        if (!popup) return;
        if (this._fileSearchRequestTimer) {
            clearTimeout(this._fileSearchRequestTimer);
            this._fileSearchRequestTimer = null;
        }

        popup.querySelector('.file-search-list')?.remove();
        popup.querySelector('.file-search-empty')?.remove();
        popup.querySelector('.file-search-loading')?.remove();
        popup.querySelector('.file-search-summary')?.remove();
        const fileEntries = results.filter(r => (r.kind || 'file') === 'file');
        this._fileSearchResults = fileEntries.map(r => this._makeAttachedFileRef(r.fullPath, r.name, r.relativePath));
        this._activeFileSearchIndex = 0;

        if (results.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'file-search-empty';
            empty.textContent = 'No project files found';
            popup.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'file-search-list';
        const treeMode = results.some(r => (r.kind || 'file') === 'directory');
        let fileIndex = 0;
        for (const r of results) {
            const item = document.createElement('div');
            const kind = r.kind || 'file';
            const depth = Math.min(6, Math.max(0, r.depth || 0));
            item.className = `file-search-item file-search-${kind}${kind === 'file' && fileIndex === this._activeFileSearchIndex ? ' active' : ''}`;
            item.dataset.path = r.fullPath;
            item.dataset.name = r.name;
            item.dataset.relative = r.relativePath;
            item.dataset.kind = kind;
            item.style.setProperty('--file-depth', String(depth));
            if (kind === 'directory') {
                if (depth <= 0) {
                    item.dataset.expanded = 'true';
                } else {
                    item.classList.add('collapsed');
                    item.dataset.expanded = 'false';
                }
                item.innerHTML = `<span class="file-search-chevron">▾</span><span class="file-search-icon" aria-hidden="true"></span><span class="file-search-info"><span class="file-search-name">${this._escapeHtml(r.name)}</span><span class="file-search-path">${this._escapeHtml(r.relativePath || '.')}</span></span>`;
                item.addEventListener('click', () => this._toggleFileTreeDirectory(list, r.relativePath, item));
            } else {
                const currentFileIndex = fileIndex;
                item.innerHTML = `<span class="file-search-chevron"></span><span class="file-search-icon" aria-hidden="true"></span><span class="file-search-info"><span class="file-search-name">${this._escapeHtml(r.name)}</span><span class="file-search-path">${this._escapeHtml(r.relativePath)}</span></span>`;
                item.addEventListener('mouseenter', () => this._setActiveFileSearchIndex(currentFileIndex));
                item.addEventListener('click', () => {
                    this._insertFileReference(r.fullPath, r.name, r.relativePath);
                });
                fileIndex++;
            }
            list.appendChild(item);
        }
        if (treeMode) this._syncFileTreeVisibility(list);
        const shown = Number(meta?.shown ?? results.length);
        const total = Number(meta?.total ?? results.length);
        const truncated = !!meta?.truncated;
        const summary = document.createElement('div');
        summary.className = 'file-search-summary';
        summary.textContent = truncated
            ? `Showing ${shown} / ${total}${meta?.query ? ' matches' : ' entries'}`
            : `${shown}${meta?.query ? ' matches' : ' entries'}`;
        popup.appendChild(summary);
        popup.appendChild(list);
    },

    _renderFileSearchLoading(text: string): void {
        this._renderFileSearchMessage(text, 'file-search-loading');
    },

    _renderFileSearchMessage(text: string, className = 'file-search-empty'): void {
        const popup = document.getElementById('file-search-popup');
        if (!popup) return;
        popup.querySelector('.file-search-list')?.remove();
        popup.querySelector('.file-search-empty')?.remove();
        popup.querySelector('.file-search-loading')?.remove();
        popup.querySelector('.file-search-summary')?.remove();
        const el = document.createElement('div');
        el.className = className;
        el.textContent = text;
        popup.appendChild(el);
    },

    _toggleFileTreeDirectory(list: HTMLElement, dirPath: string, row: HTMLElement): void {
        const nextExpanded = row.dataset.expanded !== 'true';
        row.dataset.expanded = nextExpanded ? 'true' : 'false';
        row.classList.toggle('collapsed', !nextExpanded);
        this._syncFileTreeVisibility(list);
    },

    _syncFileTreeVisibility(list: HTMLElement): void {
        const items = Array.from(list.querySelectorAll<HTMLElement>('.file-search-item'));
        const byPath = new Map<string, HTMLElement>();
        for (const item of items) {
            const rel = item.dataset.relative || '';
            byPath.set(rel, item);
        }
        for (const item of items) {
            const rel = item.dataset.relative || '';
            const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
            let visible = true;
            let currentParent = parent;
            while (currentParent) {
                const parentItem = byPath.get(currentParent);
                if (!parentItem) break;
                if (parentItem.dataset.expanded !== 'true') {
                    visible = false;
                    break;
                }
                currentParent = currentParent.includes('/') ? currentParent.slice(0, currentParent.lastIndexOf('/')) : '';
            }
            item.classList.toggle('file-search-child-collapsed', !visible && !!parent);
        }
    },

    _closeFileSearch(): void {
        const popup = document.getElementById('file-search-popup');
        if (popup) {
            popup.classList.remove('show');
            popup.removeAttribute('data-mode');
            const list = popup.querySelector('.file-search-list');
            if (list) list.remove();
            const empty = popup.querySelector('.file-search-empty');
            if (empty) empty.remove();
            const loading = popup.querySelector('.file-search-loading');
            if (loading) loading.remove();
            const summary = popup.querySelector('.file-search-summary');
            if (summary) summary.remove();
        }
        if (this._fileSearchRequestTimer) {
            clearTimeout(this._fileSearchRequestTimer);
            this._fileSearchRequestTimer = null;
        }
        this._fileTrigger = null;
    },

    _setActiveFileSearchIndex(index: number): void {
        if (this._fileSearchResults.length === 0) return;
        const next = (index + this._fileSearchResults.length) % this._fileSearchResults.length;
        this._activeFileSearchIndex = next;
        const items = Array.from(document.querySelectorAll<HTMLElement>('#file-search-popup .file-search-file'));
        items.forEach((item, i) => item.classList.toggle('active', i === next));
        items[next]?.scrollIntoView({ block: 'nearest' });
    },

    _makeAttachedFileRef(fullPath: string, name: string, relativePath: string): AttachedFileRef {
        let marker = `#${name}`;
        const existing = new Set(this._attachedFiles.map(file => file.marker));
        if (existing.has(marker) && !this._attachedFiles.some(file => file.fullPath === fullPath)) {
            let n = 2;
            while (existing.has(`${marker}-${n}`)) n++;
            marker = `${marker}-${n}`;
        }
        return { name, relativePath, fullPath, marker };
    },

    _insertFileReference(fullPath: string, name: string, relativePath: string, targetInput?: HTMLTextAreaElement): void {
        const input = targetInput || document.getElementById('input') as HTMLTextAreaElement;
        if (!input) return;

        const file = this._makeAttachedFileRef(fullPath, name, relativePath);
        const existing = this._attachedFiles.find(f => f.fullPath === fullPath);
        const marker = existing?.marker || file.marker;
        const trigger = this._fileSearchMode === 'hash' ? this._fileTrigger : null;
        const start = trigger ? trigger.start : input.selectionStart;
        const end = trigger ? trigger.end : input.selectionEnd;
        const text = input.value;
        const prefix = start > 0 && !/\s$/.test(text.slice(0, start)) ? ' ' : '';
        const suffix = end < text.length && !/^\s/.test(text.slice(end)) ? ' ' : '';
        input.value = text.substring(0, start) + prefix + marker + suffix + text.substring(end);
        const cursor = start + prefix.length + marker.length + suffix.length;
        input.selectionStart = input.selectionEnd = cursor;

        this._closeFileSearch();
        input.focus();
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';

        if (!existing) {
            this._attachedFiles.push(file);
        }
        this._renderFileTags();
        this._syncInputRender(input);
        bus.emit('inputChanged', input.value);
    },

    _renderFileTags(): void {
        const input = document.getElementById('input') as HTMLTextAreaElement;
        if (input) this._syncInputRender(input);
    },

    _removeFileReference(index: number): void {
        const file = this._attachedFiles[index];
        if (!file) return;
        const input = document.getElementById('input') as HTMLTextAreaElement;
        if (input) {
            input.value = input.value.replace(file.marker, '').replace(/\s{2,}/g, ' ').trimStart();
            this._syncInputRender(input);
        }
        this._attachedFiles.splice(index, 1);
        this._renderFileTags();
    },

    _resolveFileMarkers(text: string): string {
        let resolved = text;
        const files = this._attachedFiles.slice().sort((a, b) => b.marker.length - a.marker.length);
        const used = new Set<string>();
        for (const file of files) {
            if (!resolved.includes(file.marker)) continue;
            resolved = resolved.split(file.marker).join(file.fullPath);
            used.add(file.fullPath);
        }
        const missing = files
            .filter(file => !used.has(file.fullPath))
            .map(file => file.fullPath);
        if (missing.length > 0) {
            resolved = `${resolved}${resolved.trim() ? '\n\n' : ''}${missing.join('\n')}`;
        }
        return resolved.trim();
    },

    _syncAttachedFilesFromText(text: string): void {
        const next = this._attachedFiles.filter(file => text.includes(file.marker));
        if (next.length !== this._attachedFiles.length) {
            this._attachedFiles = next;
            this._renderFileTags();
        }
    },

    _syncInputRender(input: HTMLTextAreaElement): void {
        const render = document.getElementById('input-render');
        if (!render) return;
        const text = input.value || '';
        if (!text) {
            render.innerHTML = '';
            render.classList.remove('has-content');
            return;
        }
        const files = this._attachedFiles.slice().sort((a, b) => b.marker.length - a.marker.length);
        const parts: string[] = [];
        let cursor = 0;
        while (cursor < text.length) {
            const next = files
                .map(file => ({ file, index: text.indexOf(file.marker, cursor) }))
                .filter(item => item.index >= 0)
                .sort((a, b) => a.index - b.index || b.file.marker.length - a.file.marker.length)[0];
            if (!next) {
                parts.push(this._escapeHtml(text.slice(cursor)));
                break;
            }
            if (next.index > cursor) parts.push(this._escapeHtml(text.slice(cursor, next.index)));
            parts.push(`<span class="inline-file-token" data-path="${this._escapeHtml(next.file.fullPath)}">${this._escapeHtml(next.file.marker)}</span>`);
            cursor = next.index + next.file.marker.length;
        }
        render.innerHTML = parts.join('').replace(/\n/g, '<br>');
        render.style.transform = input.scrollTop ? `translateY(${-input.scrollTop}px)` : '';
        render.classList.toggle('has-content', !!text.trim());
    },

    _updateFileReferenceHover(input: HTMLTextAreaElement, e: MouseEvent): void {
        this._lastHoverEvent = { input, clientX: e.clientX, clientY: e.clientY };
        if (this._hoverFrame) return;
        this._hoverFrame = requestAnimationFrame(() => {
            this._hoverFrame = 0;
            const last = this._lastHoverEvent;
            if (!last) return;
            this._applyFileReferenceHover(last.input, last.clientX, last.clientY);
        });
    },

    _applyFileReferenceHover(input: HTMLTextAreaElement, clientX: number, clientY: number): void {
        const hit = this._getHoveredFileReference(input, clientX, clientY);
        if (!hit) {
            this._hideFileReferenceHover();
            return;
        }
        this._showFileReferenceHover(hit.file.fullPath, clientX, clientY);
    },

    _getHoveredFileReference(input: HTMLTextAreaElement, clientX: number, clientY: number): { file: AttachedFileRef } | null {
        if (this._attachedFiles.length === 0) return null;
        const doc = input.ownerDocument;
        const position: any = (doc as any).caretPositionFromPoint?.(clientX, clientY);
        let offset = typeof position?.offset === 'number' ? position.offset : null;
        if (offset === null) {
            const range: any = (doc as any).caretRangeFromPoint?.(clientX, clientY);
            offset = typeof range?.startOffset === 'number' ? range.startOffset : null;
        }
        if (offset === null) return null;
        const text = input.value || '';
        for (const file of this._attachedFiles) {
            let index = text.indexOf(file.marker);
            while (index >= 0) {
                const end = index + file.marker.length;
                if (offset >= index && offset <= end) return { file };
                index = text.indexOf(file.marker, end);
            }
        }
        return null;
    },

    _showFileReferenceHover(path: string, clientX: number, clientY: number): void {
        if (this._hoveredFilePath === path) {
            const existing = document.getElementById('file-reference-hover');
            if (existing) {
                existing.style.left = `${Math.min(window.innerWidth - 24, clientX + 12)}px`;
                existing.style.top = `${Math.max(8, clientY - 34)}px`;
                return;
            }
        }
        this._hoveredFilePath = path;
        let tooltip = document.getElementById('file-reference-hover') as HTMLElement | null;
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'file-reference-hover';
            tooltip.className = 'file-reference-hover';
            document.body.appendChild(tooltip);
        }
        tooltip.textContent = path;
        tooltip.style.left = `${Math.min(window.innerWidth - 24, clientX + 12)}px`;
        tooltip.style.top = `${Math.max(8, clientY - 34)}px`;
        tooltip.classList.add('show');
    },

    _hideFileReferenceHover(): void {
        this._hoveredFilePath = '';
        this._lastHoverEvent = null;
        document.getElementById('file-reference-hover')?.classList.remove('show');
    },

    _escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
};
