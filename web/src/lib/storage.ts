/** localStorage that never throws (private mode, blocked storage). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`nearcast:${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`nearcast:${key}`, JSON.stringify(value));
    } catch {}
  },
  del(key: string): void {
    try {
      localStorage.removeItem(`nearcast:${key}`);
    } catch {}
  },
};

export const session = {
  has(key: string): boolean {
    try {
      return sessionStorage.getItem(`nearcast:${key}`) !== null;
    } catch {
      return false;
    }
  },
  mark(key: string): void {
    try {
      sessionStorage.setItem(`nearcast:${key}`, "1");
    } catch {}
  },
};
