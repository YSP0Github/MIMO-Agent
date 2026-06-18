/**
 * Markdown → HTML renderer with syntax highlighting.
 * Runs in Node.js (extension host), NOT in the webview.
 * Output is safe HTML sent to the webview via postMessage.
 */

import hljs from 'highlight.js';
import katex from 'katex';

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isSafeLinkTarget(href: string): boolean {
    const decoded = href.replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(decoded)) return true;
    if (/^localhost:\d+(?:[/?#]|$)/i.test(decoded)) return true;
    if (/^127\.0\.0\.1:\d+(?:[/?#]|$)/i.test(decoded)) return true;
    return false;
}

function normalizeEscapedAttr(value: string): string {
    return escapeHtml(value.replace(/&amp;/g, '&').trim());
}

function isLocalFilePathTarget(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value.replace(/&amp;/g, '&').trim());
}

function renderFileLink(label: string, filePath: string, line?: string): string {
    const cleanPath = filePath.replace(/&amp;/g, '&').trim();
    const lineAttr = line ? ` data-line="${escapeHtml(line)}"` : '';
    return `<a href="#" class="md-link file-link" data-file="${escapeHtml(cleanPath)}"${lineAttr}>${label}</a>`;
}

// ── LaTeX math helpers ──

interface LatexBlock { raw: string; tex: string; display: boolean; }

/**
 * Extract $$...$$ (display) and $...$ (inline) math from raw text,
 * returning placeholders __LATEX_BLOCK_N__ and the extracted blocks.
 */
function extractLatex(text: string): { text: string; blocks: LatexBlock[] } {
    const blocks: LatexBlock[] = [];
    let s = text;

    // 1) $$display$$ — must come first (greedy across lines)
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_: string, tex: string) => {
        const idx = blocks.length;
        blocks.push({ raw: `$$${tex}$$`, tex: tex.trim(), display: true });
        return `\n__LATEX_BLOCK_${idx}__\n`;
    });

    // 2) $inline$ — single-line, must not start/end with whitespace
    s = s.replace(/\$([^\s$][\s\S]*?[^\s$])\$/g, (_: string, tex: string) => {
        const idx = blocks.length;
        blocks.push({ raw: `$${tex}$`, tex: tex.trim(), display: false });
        return `__LATEX_BLOCK_${idx}__`;
    });

    return { text: s, blocks };
}

/**
 * Render a single LaTeX block to HTML via KaTeX. Returns the rendered
 * HTML string. On failure returns the escaped raw source so the user
 * still sees the formula text.
 */
function renderLatexBlock(block: LatexBlock): string {
    try {
        const html = katex.renderToString(block.tex, {
            displayMode: block.display,
            throwOnError: false,
            output: 'html',
            strict: false,
            trust: true,
        });
        if (block.display) {
            return `<div class="latex-display">${html}</div>`;
        }
        return `<span class="latex-inline">${html}</span>`;
    } catch {
        const escaped = escapeHtml(block.raw);
        return block.display
            ? `<div class="latex-display latex-fallback"><code>${escaped}</code></div>`
            : `<span class="latex-inline latex-fallback"><code>${escaped}</code></span>`;
    }
}

function replaceOutsideInlineCodeAndLinks(input: string, replacer: (chunk: string) => string): string {
    return input
        .split(/(<(?:code|a)\b[\s\S]*?<\/(?:code|a)>)/gi)
        .map(chunk => /^<(?:code|a)\b/i.test(chunk) ? chunk : replacer(chunk))
        .join('');
}

const LOCAL_FILE_EXTENSIONS = [
    '7z', 'bmp', 'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'doc', 'docx', 'gif', 'go',
    'h', 'hpp', 'html', 'htm', 'ipynb', 'java', 'jpeg', 'jpg', 'js', 'jsx', 'json',
    'log', 'md', 'mov', 'mp3', 'mp4', 'pdf', 'png', 'ppt', 'pptx', 'py', 'rar', 'rs',
    'svg', 'ts', 'tsx', 'txt', 'webm', 'webp', 'xls', 'xlsx', 'xml', 'yaml', 'yml', 'zip',
].join('|');

function renderTable(tableLines: string[]): string {
    const rows: string[][] = [];
    for (const line of tableLines) {
        // Split by | and filter empty strings from leading/trailing |
        const raw = line.trim();
        const cells = raw.split('|').map(c => c.trim()).filter(c => c !== '');
        if (cells.length > 0) rows.push(cells);
    }
    if (rows.length < 2) return tableLines.join('\n');

    // First row is header
    const header = rows[0];
    const colCount = header.length;
    let html = '<table><thead><tr>';
    for (const h of header) html += '<th>' + h + '</th>';
    html += '</tr></thead><tbody>';

    // Skip separator row (index 1), render data rows
    for (let i = 1; i < rows.length; i++) {
        // Skip separator rows (contain only dashes/colons/pipes)
        if (rows[i].every(c => /^[-:\s|]+$/.test(c))) continue;
        html += '<tr>';
        for (let j = 0; j < colCount; j++) {
            html += '<td>' + (rows[i][j] || '') + '</td>';
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
}

export function renderMarkdown(text: string): string {
    if (!text) return '';

    // 1. Extract code blocks BEFORE escaping to avoid double-escaping
    const codeBlocks: Array<{ lang: string; code: string }> = [];
    let s = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang, code });
        return `\n__CODE_BLOCK_${idx}__\n`;
    });

    // Also handle code blocks without language tag
    s = s.replace(/```\n?([\s\S]*?)```/g, (_: string, code: string) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang: '', code });
        return `\n__CODE_BLOCK_${idx}__\n`;
    });

    // 1b. Extract LaTeX math blocks BEFORE escaping
    const { text: latexText, blocks: latexBlocks } = extractLatex(s);
    s = latexText;

    // 2. Escape HTML for the rest of the content
    s = escapeHtml(s);

    const renderedCodeBlocks = codeBlocks.map(({ lang, code }) => {
        let highlighted: string;
        try {
            if (lang && hljs.getLanguage(lang)) {
                highlighted = hljs.highlight(code, { language: lang }).value;
            } else {
                highlighted = escapeHtml(code);
            }
        } catch {
            highlighted = escapeHtml(code);
        }

        const langLabel = lang || 'text';
        return `<div class="code-block">` +
            `<div class="code-header">` +
            `<span class="code-lang">${escapeHtml(langLabel)}</span>` +
            `<button class="copy-btn">Copy</button>` +
            `</div>` +
            `<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>` +
            `</div>`;
    });

    // Inline code: `...`
    s = s.replace(/`([^\n]+?)`/g, '<code>$1</code>');

    // Headers
    s = s.replace(/^#### (.+)$/gm, '\n<h4>$1</h4>');
    s = s.replace(/^### (.+)$/gm, '\n<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '\n<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '\n<h1>$1</h1>');

    // Horizontal rule
    s = s.replace(/^---+$/gm, '\n<hr>');

    // Bold + italic
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links (markdown style). Keep unsafe protocols as plain escaped text.
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_: string, label: string, href: string) => {
        if (isLocalFilePathTarget(href)) return renderFileLink(label, href);
        if (!isSafeLinkTarget(href)) return `${label} (${href})`;
        return `<a href="${normalizeEscapedAttr(href)}" class="md-link url-link">${label}</a>`;
    });

    // Auto-detect plain URLs (http/https/localhost)
    s = replaceOutsideInlineCodeAndLinks(s, chunk =>
        chunk.replace(/(?<![">&])(https?:\/\/[^\s<>\)]+|localhost:\d+[^\s<>\)]*)/g, (_: string, url: string) => {
            return `<a href="${normalizeEscapedAttr(url)}" class="md-link url-link">${url}</a>`;
        })
    );

    // Auto-detect common Windows file paths in summaries and tables.
    const localFileRe = new RegExp(`\\b([A-Za-z]:[\\\\/][^<>\\r\\n|]*?\\.(${LOCAL_FILE_EXTENSIONS}))(?:\\:(\\d{1,7}))?(?![\\w.-])`, 'gi');
    s = replaceOutsideInlineCodeAndLinks(s, chunk =>
        chunk.replace(localFileRe, (match: string, filePath: string, _ext: string, line?: string) => {
            return renderFileLink(match, filePath, line);
        })
    );

    // Blockquote
    s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Tables: detect consecutive lines starting with | (lines may or may not end with |)
    // Use line-by-line detection to avoid regex backtracking stack overflow
    const lines = s.split('\n');
    const tableBlocks: { start: number; end: number }[] = [];
    let i = 0;
    while (i < lines.length) {
        if (/^\|/.test(lines[i])) {
            const start = i;
            while (i < lines.length && /^\|/.test(lines[i])) i++;
            const blockLines = lines.slice(start, i);
            // Must have at least 2 rows and a separator row with dashes
            if (blockLines.length >= 2 && blockLines.some(l => /^\|[\s\-:|]+\|?$/.test(l.trim()))) {
                tableBlocks.push({ start, end: i });
            }
        } else {
            i++;
        }
    }
    // Replace table blocks in reverse order to preserve indices
    for (let t = tableBlocks.length - 1; t >= 0; t--) {
        const { start, end } = tableBlocks[t];
        const tableLines = lines.slice(start, end);
        lines.splice(start, end - start, '\n' + renderTable(tableLines) + '\n');
    }
    s = lines.join('\n');

    // Checkboxes: - [x] done / - [ ] todo
    s = s.replace(/^([\-\*]) \[x\] (.+)$/gm, '<li class="todo done">&#9745; $2</li>');
    s = s.replace(/^([\-\*]) \[ \] (.+)$/gm, '<li class="todo">&#9744; $2</li>');

    // Wrap consecutive todo items in a task-checklist container
    s = s.replace(/((?:<li class="todo(?:\s+done)?">.*?<\/li>\n?)+)/g, (_: string, block: string) => {
        return '\n<div class="task-checklist">' + block.trim() + '</div>\n';
    });

    // Unordered list items (handle indentation for nesting)
    // Items starting with 2+ spaces are nested (indent level = spaces/2)
    s = s.replace(/^((?: {2})+)[\-\*] (.+)$/gm, (_: string, indent: string, text: string) => {
        const depth = Math.floor(indent.length / 2);
        return '<li data-depth="' + depth + '">' + text + '</li>';
    });
    s = s.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');

    // Ordered list items (handle indentation for nesting)
    s = s.replace(/^((?: {2})+)(\d+)\. (.+)$/gm, (_: string, indent: string, _num: string, text: string) => {
        const depth = Math.floor(indent.length / 2);
        return '<li data-depth="' + depth + '">' + text + '</li>';
    });
    s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Wrap any remaining consecutive <li> items in <ul> (for ordered lists or mixed)
    // Multiple passes to handle nested lists correctly
    for (let pass = 0; pass < 5; pass++) {
        s = s.replace(/((?:<li(?:\s[^>]*)?>.*?<\/li>\n?)+)/g, (block: string) => {
            if (block.startsWith('<ul>') || block.startsWith('<ol>') || block.startsWith('<div')) return block;
            return '\n<ul>' + block.trim() + '</ul>\n';
        });
    }

    // ── Spacing: preserve blank lines as visual separation ──
    // Double newline = paragraph break (visual gap between sections)
    // Single newline = space (within a paragraph)
    // Newlines around block elements (h*, ul, ol, hr, table, pre, blockquote) are preserved

    // Fix: collapse blank lines between list items to avoid splitting into multiple <ul>/<ol>
    // e.g. "- item1\n\n- item2" → "- item1\n- item2"
    s = s.replace(/(<li[^>]*>.*?<\/li>\n)\n+(<li[^>]*>)/g, '$1$2');
    s = s.replace(/(<li[^>]*>.*?<\/li>\n)\n+(<(?:ul|ol)[^>]*>)/g, '$1$2');
    s = s.replace(/(<\/(?:ul|ol)>\n)\n+(<li[^>]*>)/g, '$1$2');

    // Protect block elements: wrap them so newlines around them are preserved
    const blockTags = 'h[1-6]|ul|ol|li|hr|table|thead|tbody|tr|th|td|pre|code|blockquote|div';
    const blockRe = new RegExp(`(<(?:${blockTags})(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:${blockTags})>|<(?:${blockTags})(?:\\s[^>]*)?\\/>)`, 'g');
    const blocks: string[] = [];
    s = s.replace(blockRe, (m) => {
        const idx = blocks.length;
        blocks.push(m);
        return `\n__BLOCK_${idx}__\n`;
    });

    // Also protect inline code to avoid spacing issues
    const inlineCodes: string[] = [];
    s = s.replace(/<code>[\s\S]*?<\/code>/g, (m) => {
        const idx = inlineCodes.length;
        inlineCodes.push(m);
        return `__INLINECODE_${idx}__`;
    });

    // Double newlines → paragraph gap
    s = s.replace(/\n{2,}/g, '\n__PARA_GAP__\n');
    // Single newlines → space (within paragraph)
    s = s.replace(/\n/g, ' ');
    // Restore paragraph gaps as spacing
    s = s.replace(/__PARA_GAP__/g, '\n');

    // Restore inline code
    s = s.replace(/__INLINECODE_(\d+)__/g, (_: string, i: string) => inlineCodes[parseInt(i)]);

    // Restore block elements
    s = s.replace(/__BLOCK_(\d+)__/g, (_: string, i: string) => blocks[parseInt(i)]);

    // Restore fenced code blocks last so markdown rules never rewrite code content.
    s = s.replace(/__CODE_BLOCK_(\d+)__/g, (_: string, i: string) => renderedCodeBlocks[parseInt(i)] || '');

    // Restore LaTeX blocks
    s = s.replace(/__LATEX_BLOCK_(\d+)__/g, (_: string, i: string) => renderLatexBlock(latexBlocks[parseInt(i)]));

    // Final cleanup: collapse multiple spaces, trim
    s = s.replace(/  +/g, ' ');
    s = s.trim();

    return s;
}

export function renderStreamingMarkdown(text: string): string {
    if (!text) return '';

    const codeBlocks: Array<{ lang: string; code: string }> = [];
    let s = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang, code });
        return `\n__STREAM_CODE_BLOCK_${idx}__\n`;
    });
    s = s.replace(/```\n?([\s\S]*?)```/g, (_: string, code: string) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang: '', code });
        return `\n__STREAM_CODE_BLOCK_${idx}__\n`;
    });

    // Extract LaTeX math before escaping
    const { text: latexText, blocks: latexBlocks } = extractLatex(s);
    s = latexText;

    s = escapeHtml(s);
    const renderedCodeBlocks = codeBlocks.map(({ lang, code }) => {
        const langLabel = lang || 'text';
        return `<div class="code-block">` +
            `<div class="code-header">` +
            `<span class="code-lang">${escapeHtml(langLabel)}</span>` +
            `<button class="copy-btn">Copy</button>` +
            `</div>` +
            `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>` +
            `</div>`;
    });

    s = s.replace(/`([^\n]+?)`/g, '<code>$1</code>');
    s = s.replace(/^#### (.+)$/gm, '\n<h4>$1</h4>');
    s = s.replace(/^### (.+)$/gm, '\n<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '\n<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '\n<h1>$1</h1>');
    s = s.replace(/^---+$/gm, '\n<hr>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_: string, label: string, href: string) => {
        if (isLocalFilePathTarget(href)) return renderFileLink(label, href);
        if (!isSafeLinkTarget(href)) return `${label} (${href})`;
        return `<a href="${normalizeEscapedAttr(href)}" class="md-link url-link">${label}</a>`;
    });
    s = replaceOutsideInlineCodeAndLinks(s, chunk =>
        chunk.replace(/(?<![">&])(https?:\/\/[^\s<>\)]+|localhost:\d+[^\s<>\)]*)/g, (_: string, url: string) => {
            return `<a href="${normalizeEscapedAttr(url)}" class="md-link url-link">${url}</a>`;
        })
    );
    s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    s = s.replace(/^([\-\*]) \[x\] (.+)$/gm, '<li class="todo done">&#9745; $2</li>');
    s = s.replace(/^([\-\*]) \[ \] (.+)$/gm, '<li class="todo">&#9744; $2</li>');
    s = s.replace(/^((?: {2})+)[\-\*] (.+)$/gm, (_: string, indent: string, item: string) => {
        const depth = Math.floor(indent.length / 2);
        return '<li data-depth="' + depth + '">' + item + '</li>';
    });
    s = s.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    s = s.replace(/^((?: {2})+)(\d+)\. (.+)$/gm, (_: string, indent: string, _num: string, item: string) => {
        const depth = Math.floor(indent.length / 2);
        return '<li data-depth="' + depth + '">' + item + '</li>';
    });
    s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    s = s.replace(/((?:<li(?:\s[^>]*)?>.*?<\/li>\n?)+)/g, (block: string) => {
        if (block.startsWith('<ul>') || block.startsWith('<ol>') || block.startsWith('<div')) return block;
        return '\n<ul>' + block.trim() + '</ul>\n';
    });

    const blockTags = 'h[1-6]|ul|ol|li|hr|pre|code|blockquote|div';
    const blockRe = new RegExp(`(<(?:${blockTags})(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:${blockTags})>|<(?:${blockTags})(?:\\s[^>]*)?\\/>)`, 'g');
    const blocks: string[] = [];
    s = s.replace(blockRe, (m) => {
        const idx = blocks.length;
        blocks.push(m);
        return `\n__STREAM_BLOCK_${idx}__\n`;
    });
    s = s.replace(/\n{2,}/g, '\n__STREAM_PARA_GAP__\n');
    s = s.replace(/\n/g, ' ');
    s = s.replace(/__STREAM_PARA_GAP__/g, '\n');
    s = s.replace(/__STREAM_BLOCK_(\d+)__/g, (_: string, i: string) => blocks[parseInt(i)] || '');
    s = s.replace(/__STREAM_CODE_BLOCK_(\d+)__/g, (_: string, i: string) => renderedCodeBlocks[parseInt(i)] || '');
    // Restore LaTeX blocks
    s = s.replace(/__LATEX_BLOCK_(\d+)__/g, (_: string, i: string) => renderLatexBlock(latexBlocks[parseInt(i)]));
    return s.replace(/  +/g, ' ').trim();
}
