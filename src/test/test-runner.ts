/**
 * Simple test runner for MiMo Agent.
 * Run: node out/test/test-runner.js
 */

if (typeof (globalThis as any).acquireVsCodeApi !== 'function') {
    let state: any = {};
    (globalThis as any).acquireVsCodeApi = () => ({
        postMessage(_msg: any) {},
        setState(next: any) { state = next; },
        getState() { return state; },
    });
}

let passed = 0;
let failed = 0;
let total = 0;

export function describe(name: string, fn: () => void): void {
    console.log(`\n  ${name}`);
    fn();
}

export function it(name: string, fn: () => void): void {
    total++;
    try {
        fn();
        passed++;
        console.log(`    ✓ ${name}`);
    } catch (e: any) {
        failed++;
        console.log(`    ✗ ${name}`);
        console.log(`      ${e.message}`);
    }
}

export function expect(actual: any) {
    return {
        toBe(expected: any) {
            if (actual !== expected) {
                throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            }
        },
        toEqual(expected: any) {
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            }
        },
        toBeTruthy() {
            if (!actual) {
                throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
            }
        },
        toBeFalsy() {
            if (actual) {
                throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
            }
        },
        toContain(expected: any) {
            if (typeof actual === 'string') {
                if (!actual.includes(expected)) {
                    throw new Error(`Expected "${actual}" to contain "${expected}"`);
                }
            } else if (Array.isArray(actual)) {
                if (!actual.includes(expected)) {
                    throw new Error(`Expected array to contain ${JSON.stringify(expected)}`);
                }
            } else {
                throw new Error(`toContain called on non-string/non-array value: ${typeof actual}`);
            }
        },
        toMatch(expected: RegExp) {
            if (typeof actual !== 'string') {
                throw new Error(`toMatch called on non-string value: ${typeof actual}`);
            }
            if (!expected.test(actual)) {
                throw new Error(`Expected "${actual}" to match ${expected}`);
            }
        },
        toHaveLength(len: number) {
            if (actual.length !== len) {
                throw new Error(`Expected length ${len}, got ${actual.length}`);
            }
        },
        toBeGreaterThan(n: number) {
            if (!(actual > n)) {
                throw new Error(`Expected ${actual} > ${n}`);
            }
        },
        toBeGreaterThanOrEqual(n: number) {
            if (!(actual >= n)) {
                throw new Error(`Expected ${actual} >= ${n}`);
            }
        },
        toBeLessThan(n: number) {
            if (!(actual < n)) {
                throw new Error(`Expected ${actual} < ${n}`);
            }
        },
        toBeLessThanOrEqual(n: number) {
            if (!(actual <= n)) {
                throw new Error(`Expected ${actual} <= ${n}`);
            }
        },
        toBeNull() {
            if (actual !== null) {
                throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
            }
        },
        not: {
            toBe(expected: any) {
                if (actual === expected) {
                    throw new Error(`Expected not ${JSON.stringify(expected)}`);
                }
            },
            toBeNull() {
                if (actual === null) {
                    throw new Error(`Expected not null`);
                }
            },
        },
    };
}

export function summary(): void {
    console.log(`\n  Results: ${passed} passed, ${failed} failed, ${total} total`);
}

export function finalSummary(): void {
    console.log(`\n  =====================`);
    console.log(`  Total: ${passed} passed, ${failed} failed, ${total} total\n`);
    process.exit(failed > 0 ? 1 : 0);
}
