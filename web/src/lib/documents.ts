import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, InfoResponse } from "@api";
import { api } from "./api.ts";
import { store } from "./storage.ts";

/**
 * Open documents, VS Code style: workspace files (saved to disk automatically), read-only
 * examples and untitled buffers (both saved with "Save As").
 */
export interface Tab {
  key: string; // "file:a.cast" | "example:demo.cast" | "untitled:1"
  name: string;
  kind: "file" | "example" | "untitled";
}

const NEW_FILE = "# New script. Type a command and pick from the suggestions (Ctrl+Space).\n\n";

export function useDocuments(info: InfoResponse | null, onError: (msg: string) => void) {
  const [tabs, setTabs] = useState<Tab[]>(() => store.get("tabs", []));
  const [active, setActive] = useState<string>(() => store.get("activeTab", ""));
  const [source, setSourceState] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [dir, setDir] = useState("");
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const buffers = useRef(new Map<string, string>(Object.entries(store.get<Record<string, string>>("buffers", {}))));
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => store.set("tabs", tabs), [tabs]);
  useEffect(() => store.set("activeTab", active), [active]);

  const refresh = useCallback(async () => {
    try {
      const r = await api.files();
      setFiles(r.files);
      setDir(r.dir);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Unsaved buffers (examples edited, untitled) survive a reload. */
  const persistBuffers = () => {
    const keep: Record<string, string> = {};
    for (const [k, v] of buffers.current) if (!k.startsWith("file:")) keep[k] = v;
    store.set("buffers", keep);
  };

  const load = useCallback(
    async (tab: Tab): Promise<string | null> => {
      if (buffers.current.has(tab.key)) return buffers.current.get(tab.key)!;
      if (tab.kind === "file") {
        try {
          const r = await api.read(tab.name);
          buffers.current.set(tab.key, r.source);
          return r.source;
        } catch (e) {
          onError((e as Error).message);
          return null;
        }
      }
      if (tab.kind === "example") {
        const ex = info?.examples.find((x) => x.name === tab.name);
        if (!ex) return null;
        buffers.current.set(tab.key, ex.source);
        return ex.source;
      }
      return "";
    },
    [info, onError],
  );

  const activate = useCallback(
    async (key: string, list = tabs) => {
      const tab = list.find((t) => t.key === key);
      if (!tab) {
        setActive("");
        setSourceState("");
        return;
      }
      const text = await load(tab);
      if (text === null) return;
      setActive(key);
      setSourceState(text);
    },
    [tabs, load],
  );

  const openTab = useCallback(
    async (tab: Tab, text?: string) => {
      if (text !== undefined) buffers.current.set(tab.key, text);
      const list = tabs.some((t) => t.key === tab.key) ? tabs : [...tabs, tab];
      setTabs(list);
      await activate(tab.key, list);
    },
    [tabs, activate],
  );

  // First load: restore the last active tab, or open the default example.
  const booted = useRef(false);
  useEffect(() => {
    if (!info || booted.current) return;
    booted.current = true;
    const current = tabs.find((t) => t.key === active) ?? tabs[0];
    if (current) activate(current.key);
    else {
      const legacy = store.get<string>("source", "");
      if (legacy) openTab({ key: "untitled:1", name: "Untitled-1", kind: "untitled" }, legacy);
      else {
        const ex = info.examples.find((x) => x.name === "demo.cast") ?? info.examples[0];
        if (ex) openTab({ key: `example:${ex.name}`, name: ex.name, kind: "example" });
      }
    }
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edits: files save themselves shortly after typing stops; other buffers are kept locally.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setSource = useCallback((text: string) => {
    setSourceState(text);
    const key = activeRef.current;
    if (!key) return;
    buffers.current.set(key, text);
    setDirty((d) => new Set(d).add(key));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (key.startsWith("file:")) {
        try {
          await api.write(key.slice(5), text);
          setDirty((d) => {
            const n = new Set(d);
            n.delete(key);
            return n;
          });
        } catch (e) {
          onError(`not saved: ${(e as Error).message}`);
        }
      } else persistBuffers();
    }, 400);
  }, [onError]);

  const close = useCallback(
    (key: string) => {
      const i = tabs.findIndex((t) => t.key === key);
      const list = tabs.filter((t) => t.key !== key);
      setTabs(list);
      if (!key.startsWith("file:")) {
        buffers.current.delete(key);
        persistBuffers();
      }
      if (key === active) {
        const next = list[Math.min(i, list.length - 1)];
        activate(next?.key ?? "", list);
      }
    },
    [tabs, active, activate],
  );

  const newFile = useCallback(
    async (rawName: string): Promise<boolean> => {
      try {
        const f = await api.write(rawName, NEW_FILE, true);
        await refresh();
        await openTab({ key: `file:${f.name}`, name: f.name, kind: "file" }, NEW_FILE);
        return true;
      } catch (e) {
        onError((e as Error).message);
        return false;
      }
    },
    [refresh, openTab, onError],
  );

  const rename = useCallback(
    async (from: string, rawTo: string) => {
      try {
        const f = await api.rename(from, rawTo);
        const oldKey = `file:${from}`;
        const newKey = `file:${f.name}`;
        const text = buffers.current.get(oldKey);
        buffers.current.delete(oldKey);
        if (text !== undefined) buffers.current.set(newKey, text);
        setTabs((ts) => ts.map((t) => (t.key === oldKey ? { key: newKey, name: f.name, kind: "file" } : t)));
        if (active === oldKey) setActive(newKey);
        await refresh();
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [active, refresh, onError],
  );

  const remove = useCallback(
    async (name: string) => {
      try {
        await api.remove(name);
        buffers.current.delete(`file:${name}`);
        close(`file:${name}`);
        await refresh();
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [close, refresh, onError],
  );

  /** Save an example or untitled buffer into the workspace under a new name. */
  const saveAs = useCallback(
    async (rawName: string) => {
      const key = active;
      try {
        const f = await api.write(rawName, source, true);
        const tab: Tab = { key: `file:${f.name}`, name: f.name, kind: "file" };
        buffers.current.set(tab.key, source);
        buffers.current.delete(key);
        persistBuffers();
        const list = tabs.map((t) => (t.key === key ? tab : t));
        setTabs(list);
        setActive(tab.key);
        setDirty((d) => {
          const n = new Set(d);
          n.delete(key);
          return n;
        });
        await refresh();
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [active, source, tabs, refresh, onError],
  );

  const newUntitled = useCallback(() => {
    let n = 1;
    while (tabs.some((t) => t.key === `untitled:${n}`)) n++;
    openTab({ key: `untitled:${n}`, name: `Untitled-${n}`, kind: "untitled" }, "");
  }, [tabs, openTab]);

  const activeTab = tabs.find((t) => t.key === active) ?? null;
  return {
    tabs, active, activeTab, source, setSource, files, dir, dirty,
    activate, close, refresh, newFile, newUntitled, rename, remove, saveAs,
    openFile: (name: string) => openTab({ key: `file:${name}`, name, kind: "file" }),
    openExample: (name: string) => openTab({ key: `example:${name}`, name, kind: "example" }),
  };
}
