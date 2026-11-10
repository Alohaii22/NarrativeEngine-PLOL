import '@testing-library/jest-dom';

Element.prototype.scrollIntoView = function () {};
Element.prototype.scrollTo = function () {};

Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return 40; },
});

// Node 25+ defines its own `localStorage` global, which is unusable without
// --localstorage-file and hides the one jsdom provides. Give tests a working
// in-memory one so the suite passes on current Node as well as on Node 20/22.
function hasWorkingStorage(): boolean {
    try {
        return typeof globalThis.localStorage?.clear === 'function';
    } catch {
        return false;
    }
}
if (!hasWorkingStorage()) {
    class MemoryStorage implements Storage {
        private items = new Map<string, string>();
        get length() { return this.items.size; }
        clear() { this.items.clear(); }
        getItem(key: string) { return this.items.has(key) ? this.items.get(key)! : null; }
        key(index: number) { return [...this.items.keys()][index] ?? null; }
        removeItem(key: string) { this.items.delete(key); }
        setItem(key: string, value: string) { this.items.set(key, String(value)); }
        [name: string]: unknown;
    }
    for (const name of ['localStorage', 'sessionStorage'] as const) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: new MemoryStorage() });
    }
}
