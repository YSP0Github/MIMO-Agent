import * as path from 'path';

// ── Always blocked commands ──

const ALWAYS_BLOCKED = new Set([
    'format', 'shutdown', 'reboot',
    'taskkill', 'diskpart', 'fdisk', 'mkfs',
    'Stop-Computer', 'Format-Volume', 'Clear-Disk', 'Initialize-Disk',
    'bcdedit', 'bootcfg', 'fixmbr', 'fixboot',
]);

// ── Prefixes to strip before checking ──

const STRIP_PREFIXES = [
    'sudo ', '/bin/', '/usr/bin/', '/sbin/', '/usr/sbin/',
    'cmd /c ', 'cmd.exe /c ', 'cmd /k ', 'cmd.exe /k ',
    'powershell -c ', 'powershell.exe -c ',
    'powershell -command ', 'powershell.exe -command ',
    'pwsh -c ', 'pwsh.exe -c ', 'pwsh -command ', 'pwsh.exe -command ',
    'nohup ', 'exec ',
    'Start-Process ', 'Invoke-Expression ', 'Invoke-Command ',
];

// ── Shell exec prefixes that wrap dangerous commands ──
// These need special handling: extract inner command and check recursively

const SHELL_EXEC_PREFIXES = [
    'bash -c ', 'bash -e ', 'bash -ec ',
    'sh -c ', 'sh -e ', 'sh -ec ',
    'zsh -c ', 'fish -c ',
    'python -c ', 'python3 -c ',
    'node -e ', 'node --eval ',
    'perl -e ', 'ruby -e ',
    'php -r ',
    'powershell -c ', 'powershell -command ',
    'pwsh -c ', 'pwsh -command ',
    'Invoke-Expression ', 'Invoke-Command ',
    'Start-Process -FilePath ',
];

// ── Pipe danger patterns ──

const PIPE_DANGER_PATTERNS: RegExp[] = [
    /\|\s*(ba)?sh/,                    // pipe to shell
    /\|\s*python/,                     // pipe to python
    /\|\s*node/,                       // pipe to node
    /\|\s*perl/,                       // pipe to perl
    /\|\s*ruby/,                       // pipe to ruby
    /\|\s*xargs\s+.*(-I|--exec)/,     // xargs with exec
    /\|\s*sudo/,                       // pipe to sudo
    />\s*\/dev\/null\s+2>&1\s*&&/,    // redirect + chain
];

// ── SSRF protection: internal IP patterns ──

const INTERNAL_IP_PATTERNS: RegExp[] = [
    /169\.254\.169\.254/,             // AWS/GCP/Azure metadata
    /100\.100\.100\.200/,             // Alibaba Cloud metadata
    /metadata\.google\.internal/,     // GCP metadata
    /169\.254\.170\.2/,               // Azure metadata
    /127\.0\.0\.\d+/,                 // localhost
    /192\.168\.\d+\.\d+/,             // private network
    /10\.\d+\.\d+\.\d+/,             // private network
    /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/, // private network
    /0\.0\.0\.0/,                     // any address
    /\[::1\]/,                        // IPv6 localhost
];

// ── Always dangerous patterns ──

const DANGEROUS_PATTERNS: RegExp[] = [
    /rm\s+(-[rfv]+\s+)*\/\s*$/,         // rm -rf /
    /rm\s+(-[rfv]+\s+)*\*\s*$/,         // rm -rf *
    />\s*\/dev\/sd/i,                     // write to disk device
    /dd\s+if=/i,                          // dd command
    /chmod\s+-[a-z]*R\s+777\s+[/\\]/i,  // chmod -R 777 /
    /curl\s.*\|\s*(ba)?sh/i,            // pipe to shell
    /wget\s.*\|\s*(ba)?sh/i,
    /:\(\)\{.*\|.*\&\};:/i,             // fork bomb
    /format\s+[a-zA-Z]:/i,              // format drive
    /Remove-Item\s+.*-Recurse\s+.*-Force\s+[a-zA-Z]:/i,
    /del\s+\/[sfq]\s+[a-zA-Z]:/i,
    /rd\s+\/[sq]\s+[a-zA-Z]:/i,
    // System registry manipulation
    /reg\s+(delete|save|restore)\s+HKEY_/i,
    /regedit\s+\/[sSpPeE]/i,
    // System service manipulation
    /sc\s+(delete|stop|config)\s+/i,
    /net\s+(stop|start)\s+(wuauserv|bits|cryptsvc|trustedinstaller)/i,
    // Task scheduler manipulation
    /schtasks\s+\/(delete|create\s+.*\/ru\s+SYSTEM)/i,
    // Boot/MBR manipulation
    /bootrec\s+/i,
    /bcdboot\s+/i,
];

// ── Needs confirmation patterns ──

const CONFIRM_PATTERNS: RegExp[] = [
    /rm\s+-[r]+/i,
    /rmdir\s+/i,
    /Remove-Item\s+/i,
    /del\s+/i,
    /move\s+.*[\/\\]/i,
    /ren(ame)?\s+/i,
];

// ── Sensitive file extensions ──

const SENSITIVE_EXTENSIONS = new Set([
    '.env', '.key', '.pem', '.p12', '.jks', '.secret',
    '.pfx', '.keystore', '.credentials', '.token',
]);

const MAX_SHELL_GENERATED_FILE_BYTES = 6 * 1024 * 1024;

const LARGE_FILE_WRITE_PATTERNS: RegExp[] = [
    /\[System\.IO\.File\]::WriteAll(Text|Bytes)/i,
    /\b(Set-Content|Add-Content|Out-File)\b/i,
    /\bfsutil\s+file\s+createnew\b/i,
    /\bSetLength\s*\(/i,
    /\btruncate\s+-s\b/i,
    /\bfallocate\b/i,
    /\bFileStream\b/i,
];

// ── System drive protection ──

/**
 * Windows critical directories that should NEVER be modified by the agent.
 * Comprehensive list covering system, program files, user profile, and boot.
 */
const WIN_CRITICAL_DIRS = [
    // Windows system
    'C:\\Windows',
    'C:\\WINDOWS',
    // Program Files
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\Program Files\\Common Files',
    'C:\\Program Files (x86)\\Common Files',
    // User profile critical files
    'C:\\Users\\Public',
    // System config
    'C:\\ProgramData',
    'C:\\Recovery',
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information',
    'C:\\pagefile.sys',
    'C:\\hiberfil.sys',
    'C:\\swapfile.sys',
    'C:\\bootmgr',
    'C:\\BOOTNXT',
    'C:\\boot',
    'C:\\Boot',
    // Windows Defender
    'C:\\ProgramData\\Microsoft\\Windows Defender',
    // Windows Update cache
    'C:\\Windows\\SoftwareDistribution',
    // Driver store
    'C:\\Windows\\System32\\DriverStore',
    // WinSxS (component store)
    'C:\\Windows\\WinSxS',
];

/**
 * Directories that require confirmation if workspace is on a different drive.
 * Operations here won't be blocked but will ask for user approval.
 */
const WIN_SENSITIVE_DIRS = [
    'C:\\Users',               // User profiles (reading is OK, writing needs check)
    'C:\\temp',
    'C:\\Windows\\Temp',
    'C:\\Windows\\Logs',
];

/**
 * Linux/macOS critical directories.
 */
const UNIX_CRITICAL_DIRS = [
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/boot',
    '/root',
    '/var',
    '/sys',
    '/proc',
    '/dev',
    '/snap',
];

/**
 * Get the drive letter of a path (Windows) or the root mount (Unix).
 * Returns 'C:' for 'C:\\Users\\...', '/' for '/home/...'
 */
function getDriveRoot(filePath: string): string {
    if (process.platform === 'win32') {
        const match = filePath.match(/^([a-zA-Z]):/i);
        return match ? match[1].toUpperCase() + ':' : 'C:';
    }
    return '/';
}

/**
 * Extract potential file paths from a command string.
 * Handles quoted and unquoted paths.
 */
function extractPathsFromCommand(cmd: string): string[] {
    const paths: string[] = [];

    // Match quoted paths (single or double quotes)
    const quotedPattern = /["']([a-zA-Z]:\\[^"']+|\/[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = quotedPattern.exec(cmd)) !== null) {
        paths.push(m[1]);
    }

    // Match unquoted paths (after common flags/redirects)
    const flagPattern = /(?:>[>\s]|<\s|(?:cd|dir|type|cat|less|more|head|tail|cp|mv|rm|del|type)\s+)([a-zA-Z]:\\[^\s"']+|\/[^\s"']+)/gi;
    while ((m = flagPattern.exec(cmd)) !== null) {
        paths.push(m[1]);
    }

    // Match bare paths (most common: command followed by path)
    const barePattern = /(?:^|\s)((?:[a-zA-Z]:\\|\.\.?\/|\/)[^\s"<>|]+)/gm;
    while ((m = barePattern.exec(cmd)) !== null) {
        // Filter out flags and URLs
        const p = m[1];
        if (!p.startsWith('-') && !p.startsWith('http') && !p.includes('|')) {
            paths.push(p);
        }
    }

    // Deduplicate
    return [...new Set(paths)];
}

/**
 * Check if a path targets a critical system directory.
 * Returns null if safe, or a reason string if not.
 */
function checkPathAgainstCriticalDirs(targetPath: string, workspaceRoot: string): string | null {
    const resolved = path.resolve(targetPath);
    const workspaceDrive = getDriveRoot(path.resolve(workspaceRoot));
    const targetDrive = getDriveRoot(resolved);
    const criticalDirs = process.platform === 'win32' ? WIN_CRITICAL_DIRS : UNIX_CRITICAL_DIRS;
    const sensitiveDirs = process.platform === 'win32' ? WIN_SENSITIVE_DIRS : [];

    // Check critical dirs (always blocked)
    for (const dir of criticalDirs) {
        const dirResolved = path.resolve(dir);
        if (isSameOrInsidePath(resolved, dirResolved)) {
            return `禁止操作：目标路径在系统关键目录 ${dir} 内`;
        }
    }

    // Check sensitive dirs (confirmation needed if workspace is on different drive)
    if (targetDrive !== workspaceDrive) {
        for (const dir of sensitiveDirs) {
            const dirResolved = path.resolve(dir);
            if (isSameOrInsidePath(resolved, dirResolved)) {
                return `敏感操作：目标路径在系统盘 ${dir} 内（当前工作区在 ${workspaceDrive} 盘）`;
            }
        }

        // If target is on C: drive but not in workspace, warn
        if (targetDrive === 'C:' && workspaceDrive !== 'C:') {
            // Allow reading, but warn on write operations
            return `注意：操作目标在系统盘 C:（工作区在 ${workspaceDrive}:），请确认`;
        }
    }

    return null;
}

// ── Helper: Extract inner command from shell exec prefixes ──

/**
 * Extract the inner command from shell -c style prefixes.
 * For example: bash -c "rm -rf /" → rm -rf /
 */
function extractInnerCommand(cmd: string): string | null {
    for (const prefix of SHELL_EXEC_PREFIXES) {
        if (cmd.toLowerCase().startsWith(prefix.toLowerCase())) {
            const rest = cmd.slice(prefix.length).trim();
            // Extract quoted content
            const quoted = rest.match(/^["'](.+)["']$/s);
            if (quoted) return quoted[1];
            return rest;
        }
    }
    return null;
}

/**
 * Check if a command contains dangerous pipe operations.
 */
function checkPipeSafety(cmd: string): { safe: boolean; reason?: string } {
    for (const pattern of PIPE_DANGER_PATTERNS) {
        if (pattern.test(cmd)) {
            return {
                safe: false,
                reason: `检测到危险管道操作: ${pattern.source}`,
            };
        }
    }
    return { safe: true };
}

function parseExplicitSizeToken(token: string): number | null {
    const normalized = token.trim().toLowerCase().replace(/\s+/g, '');
    const unitMatch = normalized.match(/^(\d+(?:\.\d+)?)(kb|mb|gb|b)$/i);
    if (unitMatch) {
        const value = Number(unitMatch[1]);
        const unit = unitMatch[2].toLowerCase();
        const multiplier = unit === 'gb'
            ? 1024 * 1024 * 1024
            : unit === 'mb'
                ? 1024 * 1024
                : unit === 'kb'
                    ? 1024
                    : 1;
        return Math.round(value * multiplier);
    }
    if (/^\d+$/.test(normalized)) {
        return Number(normalized);
    }
    return null;
}

function extractExplicitByteSizes(cmd: string): number[] {
    const sizes: number[] = [];
    const addSize = (value: number | null) => {
        if (value !== null && Number.isFinite(value) && value > 0) {
            sizes.push(value);
        }
    };

    for (const match of cmd.matchAll(/\b\d+(?:\.\d+)?\s*(?:kb|mb|gb|b)\b/gi)) {
        addSize(parseExplicitSizeToken(match[0]));
    }

    for (const match of cmd.matchAll(/\b(\d+(?:\.\d+)?)\s*\*\s*1024\s*\*\s*1024(?:\s*\*\s*1024)?\b/gi)) {
        const factor = Number(match[1]);
        const hasGigabyteTerm = /\*\s*1024\s*\*\s*1024\s*\*\s*1024/i.test(match[0]);
        addSize(Math.round(factor * (hasGigabyteTerm ? 1024 * 1024 * 1024 : 1024 * 1024)));
    }

    for (const match of cmd.matchAll(/\b1\.\.\s*(\d{7,})\b/g)) {
        addSize(Number(match[1]));
    }

    for (const match of cmd.matchAll(/\b(?:createnew|SetLength)\s*\(?\s*["']?[^"'\r\n]*?["']?\s*,?\s*(\d{7,})\b/gi)) {
        addSize(Number(match[1]));
    }

    return sizes;
}

function checkLargeFileGeneration(cmd: string): { safe: boolean; reason?: string } {
    if (!LARGE_FILE_WRITE_PATTERNS.some((pattern) => pattern.test(cmd))) {
        return { safe: true };
    }

    const sizes = extractExplicitByteSizes(cmd);
    if (!sizes.some((size) => size >= MAX_SHELL_GENERATED_FILE_BYTES)) {
        return { safe: true };
    }

    return {
        safe: false,
        reason: 'Blocking shell-based generation of oversized files; prefer a smaller structured test file.',
    };
}

/**
 * Check if a URL targets internal/private network (SSRF protection).
 */
export function checkUrlSSRF(rawUrl: string): { safe: boolean; reason?: string } {
    let host = '';
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { safe: false, reason: `Unsupported protocol: ${parsed.protocol}` };
        }
        host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
        return { safe: false, reason: 'Invalid URL' };
    }

    if (host === 'localhost' || host === '0' || host === '::1' || host === '::') {
        return { safe: false, reason: `Blocked internal network host: ${host}` };
    }
    if (host.endsWith('.localhost') || host === 'metadata.google.internal') {
        return { safe: false, reason: `Blocked internal network host: ${host}` };
    }
    for (const pattern of INTERNAL_IP_PATTERNS) {
        if (pattern.test(host)) {
            return { safe: false, reason: `Blocked internal network host: ${host}` };
        }
    }

    return { safe: true };
}

export function checkSSRF(cmd: string): { safe: boolean; reason?: string } {
    // Only check network commands
    if (!/(curl|wget|fetch|Invoke-WebRequest|http\.get)/i.test(cmd)) {
        return { safe: true };
    }

    for (const pattern of INTERNAL_IP_PATTERNS) {
        if (pattern.test(cmd)) {
            return {
                safe: false,
                reason: `禁止访问内部网络地址（${pattern.source}），可能存在 SSRF 风险`,
            };
        }
    }

    return { safe: true };
}

// ── Main safety check ──

export type SafetyResult = { blocked: boolean; needsConfirm: boolean; reason: string };

export function isCommandSafe(cmd: string, workspace?: string): SafetyResult {
    // 1. Check dangerous patterns — always blocked
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) {
            return { blocked: true, needsConfirm: false, reason: '危险操作：匹配到破坏性命令模式' };
        }
    }

    // 2. Check pipe danger patterns
    const pipeCheck = checkPipeSafety(cmd);
    if (!pipeCheck.safe) {
        return { blocked: true, needsConfirm: false, reason: pipeCheck.reason! };
    }

    // 3. Check SSRF (internal network access)
    const ssrfCheck = checkSSRF(cmd);
    if (!ssrfCheck.safe) {
        return { blocked: true, needsConfirm: false, reason: ssrfCheck.reason! };
    }

    const largeFileCheck = checkLargeFileGeneration(cmd);
    if (!largeFileCheck.safe) {
        return { blocked: true, needsConfirm: false, reason: largeFileCheck.reason! };
    }

    // 4. Extract and check shell -c inner commands (recursive)
    const innerCmd = extractInnerCommand(cmd);
    if (innerCmd && innerCmd !== cmd) {
        const innerResult = isCommandSafe(innerCmd, workspace);
        if (innerResult.blocked) {
            return { blocked: true, needsConfirm: false, reason: `嵌套命令被阻止: ${innerResult.reason}` };
        }
    }

    // 5. Strip common prefixes
    let stripped = cmd.trim();
    let changed = true;
    while (changed) {
        changed = false;
        for (const prefix of STRIP_PREFIXES) {
            if (stripped.toLowerCase().startsWith(prefix.toLowerCase())) {
                stripped = stripped.slice(prefix.length).trim();
                changed = true;
                break;
            }
        }
    }

    // 6. Check always-blocked commands
    const first = stripped.toLowerCase().split(/\s+/)[0] || '';
    if (ALWAYS_BLOCKED.has(first)) {
        return { blocked: true, needsConfirm: false, reason: `命令 '${first}' 已被禁用` };
    }
    const origFirst = cmd.toLowerCase().trim().split(/\s+/)[0] || '';
    if (ALWAYS_BLOCKED.has(origFirst)) {
        return { blocked: true, needsConfirm: false, reason: `命令 '${origFirst}' 已被禁用` };
    }

    // 7. Extract and check paths in command (if workspace is provided)
    if (workspace) {
        const paths = extractPathsFromCommand(cmd);
        for (const p of paths) {
            const issue = checkPathAgainstCriticalDirs(p, workspace);
            if (issue) {
                // Critical dirs → blocked; Sensitive dirs → needs confirm
                if (issue.startsWith('禁止')) {
                    return { blocked: true, needsConfirm: false, reason: issue };
                }
                return { blocked: false, needsConfirm: true, reason: issue };
            }
        }
    }

    // 8. Check confirmation patterns — risky but allowed with confirmation
    for (const pattern of CONFIRM_PATTERNS) {
        if (pattern.test(cmd)) {
            return { blocked: false, needsConfirm: true, reason: '此操作会删除文件，是否继续？' };
        }
    }

    return { blocked: false, needsConfirm: false, reason: '' };
}

// ── File path safety ──

const PROTECTED_DIRS = process.platform === 'win32'
    ? WIN_CRITICAL_DIRS
    : UNIX_CRITICAL_DIRS;

function isSameOrInsidePath(targetPath: string, parentPath: string): boolean {
    const target = path.resolve(targetPath);
    const parent = path.resolve(parentPath);
    const rel = path.relative(parent, target);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isPathSafe(filePath: string, workspace: string): { safe: boolean; reason: string } {
    const resolved = path.resolve(filePath);
    for (const p of PROTECTED_DIRS) {
        const pResolved = path.resolve(p);
        if (isSameOrInsidePath(resolved, pResolved)) {
            return { safe: false, reason: `路径在受保护目录: ${p}` };
        }
    }
    return { safe: true, reason: '' };
}

export function isSensitiveFile(filePath: string): boolean {
    return SENSITIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function resolvePath(filePath: string, workspace: string): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    return path.join(workspace, filePath);
}

// ── Legacy API ──

export function isCommandBlocked(cmd: string, workspace?: string): { blocked: boolean; reason: string } {
    const result = isCommandSafe(cmd, workspace);
    return { blocked: result.blocked, reason: result.reason };
}
