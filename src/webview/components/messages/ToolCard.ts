/**
 * Tool card labels, colors, summaries, and compact card builders.
 */

import { vscode } from '../../core/vscode';
import { t } from '../../core/i18n';
import { escapeHtml, createElement } from '../../utils/dom';

const TOOL_CARD_INPUT_CHARS = 260;

function compactToolInput(text: string, maxChars = TOOL_CARD_INPUT_CHARS): string {
    if (!text || text.length <= maxChars) return text || '';
    const head = text.slice(0, Math.floor(maxChars * 0.62));
    const tail = text.slice(-Math.floor(maxChars * 0.25));
    return `${head}\n\n... ${t('tool.input.compacted')} (${text.length} chars) ...\n\n${tail}`;
}

function summarizeCommand(command: string): string {
    const clean = (command || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (/\[System\.IO\.File\]::WriteAllText|Set-Content|Out-File/i.test(clean) && clean.length > 220) {
        const pathMatch = clean.match(/["']([A-Za-z]:\\[^"']+|\.{0,2}[\\/][^"']+)["']/);
        return `${t('tool.command.writeLargeFile')}${pathMatch?.[1] ? `: ${pathMatch[1]}` : ''}`;
    }
    return clean.length > 90 ? `${clean.slice(0, 90)}...` : clean;
}

const TOOL_ICONS: Record<string, string> = {
    schedule_tasks: 'SC',
    update_todos: 'TD',
    read_file: 'R', write_file: 'W', edit_file: 'E', list_directory: 'L',
    search_files: 'S', execute_command: '$', fetch_url: 'U', glob_files: 'G',
    delete_file: 'D', move_file: 'M', copy_file: 'C', get_file_info: 'I',
    git_status: 'GS', git_diff: 'GD', git_log: 'GL', git_commit: 'GC',
    git_push: 'GP', git_pull: 'GU', web_search: 'WS',
    browser_open: 'BO', browser_click: 'BC', browser_type: 'BT',
    browser_screenshot: 'BS', browser_get_content: 'BG', browser_close: 'BX',
    spawn_subagent: 'SA', run_workflow: 'WF', git_worktree_add: 'WA', git_worktree_list: 'WL',
    git_worktree_remove: 'WR', read_notebook: 'NR', edit_notebook_cell: 'NE',
    insert_notebook_cell: 'NI', delete_notebook_cell: 'ND',
    desktop_screenshot: 'DS', desktop_windows: 'DW', desktop_focus: 'DF',
    desktop_type: 'DT', desktop_key: 'DK', desktop_click: 'DC',
    desktop_mouse_move: 'DM', desktop_drag: 'DD', desktop_launch: 'DL',
};

export function toolIcon(name: string): string {
    if (name.startsWith('mcp_')) return 'MCP';
    return TOOL_ICONS[name] || '?';
}

export function toolSummary(name: string, args: any): string {
    if (!args || typeof args !== 'object') return '';
    if (name.startsWith('mcp_')) {
        const parts = name.split('_');
        const server = parts[1] || 'unknown';
        const tool = parts.slice(2).join('_');
        return `[${server}] ${tool}`;
    }
    switch (name) {
        case 'schedule_tasks': {
            const tasks = Array.isArray(args.tasks) ? args.tasks : [];
            const simple = tasks.filter((item: any) => String(item?.complexity || '').toLowerCase() === 'simple').length;
            const complex = tasks.filter((item: any) => String(item?.complexity || '').toLowerCase() === 'complex').length;
            return t('tool.summary.tasks')
                .replace('{total}', String(tasks.length))
                .replace('{simple}', String(simple))
                .replace('{complex}', String(complex));
        }
        case 'update_todos': {
            const todos = Array.isArray(args.todos) ? args.todos : [];
            const done = todos.filter((item: any) => /completed|done/i.test(String(item?.status || ''))).length;
            const active = todos.find((item: any) => /in[_-]?progress|active|doing/i.test(String(item?.status || '')));
            const activeText = active ? ` - ${(active.content || active.text || active.title || '').substring(0, 40)}` : '';
            return t('tool.summary.todos')
                .replace('{done}', String(done))
                .replace('{total}', String(todos.length)) + activeText;
        }
        case 'read_file': {
            let summary = args.path || '';
            if (args.offset || args.limit) {
                const start = (args.offset || 0) + 1;
                const end = args.limit ? start + args.limit - 1 : '...';
                summary += ` [L${start}-${end}]`;
            }
            return summary;
        }
        case 'write_file': return (args.path || '') + (args.content ? ` (${args.content.length} chars)` : '');
        case 'edit_file': return args.path || '';
        case 'list_directory': return args.path || '.';
        case 'search_files': return `"${args.pattern || ''}" in ${args.path || '.'}`;
        case 'execute_command': return summarizeCommand(args.command || '');
        case 'fetch_url': return args.url || '';
        case 'glob_files': return `${args.pattern || ''} in ${args.path || '.'}`;
        case 'delete_file': return args.path || '';
        case 'move_file': return `${args.source || ''} -> ${args.destination || ''}`;
        case 'copy_file': return `${args.source || ''} -> ${args.destination || ''}`;
        case 'get_file_info': return args.path || '';
        case 'git_status': return args.path || 'workspace';
        case 'git_diff': return (args.staged ? 'staged' : 'unstaged') + (args.file ? ` ${args.file}` : '');
        case 'git_log': return `${args.count || 10} commits`;
        case 'git_commit': return `"${(args.message || '').substring(0, 40)}"`;
        case 'git_push': return (args.remote || 'origin') + (args.branch ? ` ${args.branch}` : '');
        case 'git_pull': return (args.remote || 'origin') + (args.branch ? ` ${args.branch}` : '');
        case 'web_search': return args.query || '';
        case 'browser_open': return args.url || '';
        case 'browser_click': return args.selector || '';
        case 'browser_type': return `${args.selector || ''} -> "${(args.text || '').substring(0, 30)}"`;
        case 'browser_screenshot': return args.path || 'page';
        case 'browser_get_content': return 'page content';
        case 'browser_close': return '';
        case 'spawn_subagent': return `${args.type || 'general'}: ${(args.task || '').substring(0, 50)}`;
        case 'run_workflow': return `${Array.isArray(args.phases) ? args.phases.length : 0} phases`;
        case 'git_worktree_add': return args.branch || '';
        case 'git_worktree_list': return 'all worktrees';
        case 'git_worktree_remove': return args.path || '';
        case 'read_notebook': return args.path || '';
        case 'edit_notebook_cell': return `${args.path || ''} cell ${args.index}`;
        case 'insert_notebook_cell': return `${args.path || ''} at ${args.index ?? 'end'}`;
        case 'delete_notebook_cell': return `${args.path || ''} cell ${args.index}`;
        case 'desktop_screenshot': return args.windowTitle || 'full screen';
        case 'desktop_windows': return 'list all windows';
        case 'desktop_focus': return args.windowTitle || '';
        case 'desktop_type': return (args.text || '').substring(0, 30);
        case 'desktop_key': return args.key || '';
        case 'desktop_click': return `(${args.x}, ${args.y})`;
        case 'desktop_mouse_move': return `(${args.x}, ${args.y})`;
        case 'desktop_drag': return `(${args.x1},${args.y1}) -> (${args.x2},${args.y2})`;
        case 'desktop_launch': return args.appName || '';
        default: return JSON.stringify(args).substring(0, 60);
    }
}

export function getToolLabel(name: string): string {
    const labels: Record<string, string> = {
        schedule_tasks: t('tool.schedule'),
        read_file: 'Read', write_file: 'Write', edit_file: 'Edit',
        update_todos: t('tool.todos'),
        list_directory: 'List', search_files: 'Search', glob_files: 'Glob',
        execute_command: 'Bash', fetch_url: 'Fetch', web_search: 'Search',
        git_status: 'Git', git_diff: 'Diff', git_log: 'Log',
        git_commit: 'Commit', git_push: 'Push', git_pull: 'Pull',
        delete_file: 'Delete', move_file: 'Move', copy_file: 'Copy',
        get_file_info: 'Info',
        browser_open: 'Open', browser_click: 'Click', browser_type: 'Type',
        browser_screenshot: 'Screenshot', browser_get_content: 'Read', browser_close: 'Close',
        run_workflow: 'Workflow',
    };
    if (name.startsWith('mcp_')) return 'MCP';
    return labels[name] || name;
}

export function getToolColor(name: string): string {
    if (name.startsWith('git_')) return '#F05032';
    if (name.startsWith('browser_')) return '#2196F3';
    if (name.startsWith('mcp_')) return '#9C27B0';
    const colors: Record<string, string> = {
        schedule_tasks: '#64B5F6',
        update_todos: '#4CAF50',
        read_file: '#4EC9B0', write_file: '#CE9178', edit_file: '#DCDCAA',
        search_files: '#569CD6', glob_files: '#569CD6', list_directory: '#569CD6',
        execute_command: '#DCDCAA', fetch_url: '#CE9178', web_search: '#569CD6',
        delete_file: '#F44336', move_file: '#FF9800', copy_file: '#9C27B0',
    };
    return colors[name] || 'var(--vscode-descriptionForeground)';
}

export function getFilePath(args: any): string {
    return args.path || args.filePath || args.target || args.destination || args.dest || args.file || args.source || '';
}

export function getLineInfo(name: string, args: any): string {
    if (name === 'read_file' && (args.offset || args.limit)) {
        const start = (args.offset || 0) + 1;
        const end = args.limit ? start + args.limit - 1 : '...';
        return `[L${start}-${end}]`;
    }
    return '';
}

export function getFileLink(_name: string, args: any): string {
    const pathFields = ['path', 'source', 'file'];
    for (const field of pathFields) {
        if (args[field]) return args[field];
    }
    if (args.command) return args.command;
    if (args.url) return args.url;
    if (args.query) return args.query;
    return '';
}

export function createExecuteCommandCard(name: string, args: any): HTMLElement {
    const card = createElement('div', 'tool-card tool-card-compact tool-card-command collapsed');
    card.setAttribute('data-status', 'running');
    card.setAttribute('data-tool', name);
    (card as any)._toolName = name;
    (card as any)._toolArgs = args;

    const command = args.command || '';
    const commandSummary = summarizeCommand(command);
    const commandPreview = compactToolInput(command);
    const lineCount = String(command || '').split(/\r?\n/).length;
    card.innerHTML =
        `<div class="tool-card-header collapsible-card-header">` +
            `<span class="tool-card-dot"></span>` +
            `<span class="tool-card-title">Bash</span>` +
            `<span class="tool-card-desc">${escapeHtml(commandSummary)}</span>` +
            `<span class="tool-card-meta">${escapeHtml(lineCount > 1 ? `${lineCount} lines` : '1 line')}</span>` +
            `<span class="tool-card-time"></span>` +
        `</div>` +
        `<div class="tool-card-body tool-body">` +
            `<div class="tool-card-section">` +
                `<span class="tool-card-section-label">IN</span>` +
                `<span class="tool-card-section-content">${escapeHtml(commandPreview)}</span>` +
            `</div>` +
        `</div>`;
    return card;
}

export function createToolLine(name: string, args: any): HTMLElement {
    const card = createElement('div', 'tool-line');
    card.setAttribute('data-status', 'running');
    card.setAttribute('data-tool', name);
    (card as any)._toolName = name;
    (card as any)._toolArgs = args;

    const label = getToolLabel(name);
    const color = getToolColor(name);
    const summary = toolSummary(name, args);
    const filePath = getFilePath(args);
    const url = typeof args?.url === 'string' && /^https?:\/\//i.test(args.url) ? args.url : '';
    const lineInfo = getLineInfo(name, args);
    const displayPath = filePath ? (lineInfo ? `${filePath} ${lineInfo}` : filePath) : (url || summary);
    const linkClass = url ? 'tool-link url-link' : 'tool-link';

    card.innerHTML = `<span class="tool-label" style="color:${color}">${label}</span>` +
        `<span class="tool-path"><a class="${linkClass}" href="${url ? escapeHtml(url) : '#'}">${escapeHtml(displayPath)}</a></span>` +
        `<span class="tool-time"></span>`;

    const link = card.querySelector('.tool-link');
    if (link) {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (url) {
                vscode.post({ type: 'openUrl', url });
            } else if (filePath) {
                vscode.post({ type: 'openFile', path: filePath, line: args.offset ? args.offset + 1 : undefined });
            }
        });
    }
    return card;
}
