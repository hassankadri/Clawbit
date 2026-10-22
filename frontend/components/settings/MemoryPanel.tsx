"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { deleteMemory, listMemories, saveMemory, type SavedMemory } from "@/lib/knowledge";

export default function MemoryPanel({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SavedMemory["scope"]>("workspace");
  const [memories, setMemories] = useState<SavedMemory[]>([]);
  const [editing, setEditing] = useState<SavedMemory>();
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void listMemories(scope, workspaceId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setMemories(result.memories);
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoaded(true);
    });
    return () => controller.abort();
  }, [scope, workspaceId, open, refresh]);

  async function mutate(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      setContent("");
      setEditing(undefined);
      setLoaded(false);
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update memory.");
    } finally {
      setBusy(false);
    }
  }

  return <Dialog.Root open={open} onOpenChange={(value) => {
    setOpen(value);
    setLoaded(false);
    setError("");
  }}>
    <Dialog.Trigger asChild><button type="button">Saved memory</button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[min(90vw,680px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border bg-background p-6 text-foreground shadow-xl">
        <Dialog.Title className="font-semibold">Saved memory</Dialog.Title>
        <Dialog.Description className="my-3 text-sm text-muted-foreground">
          Save only facts or preferences you want reused. Workspace memory stays in this workspace;
          personal memory can inform your other chats. Never save credentials.
        </Dialog.Description>
        <label className="block">Scope
          <select disabled={busy} value={scope} className="ml-3 rounded border bg-background p-2" onChange={(event) => {
            setScope(event.target.value as SavedMemory["scope"]);
            setEditing(undefined);
            setContent("");
            setMemories([]);
            setError("");
            setLoaded(false);
          }}>
            <option value="workspace">Current workspace</option>
            <option value="user">My conversations</option>
          </select>
        </label>
        {error && <p role="alert" className="my-3">{error}</p>}
        <ul className="my-4 space-y-3">
          {memories.map((memory) => <li key={memory.id} className="rounded border p-3">
            <p className="whitespace-pre-wrap">{memory.content}</p>
            <button disabled={busy} type="button" className="mr-4 underline" onClick={() => {
              setEditing(memory);
              setContent(memory.content);
            }}>Edit</button>
            <button disabled={busy} type="button" className="underline" onClick={() => {
              if (window.confirm("Delete this saved memory from future context?")) void mutate(() => deleteMemory(memory));
            }}>Delete</button>
          </li>)}
        </ul>
        {!loaded && <p role="status" className="my-3 text-sm text-muted-foreground">Loading saved memories…</p>}
        {loaded && !error && !memories.length && <p className="my-3 text-sm text-muted-foreground">No saved memories in this scope.</p>}
        <form onSubmit={(event) => {
          event.preventDefault();
          void mutate(() => saveMemory(content, scope, workspaceId, editing));
        }}>
          <label htmlFor="memory-content">{editing ? "Update memory" : "New memory"}</label>
          <textarea
            id="memory-content"
            required
            maxLength={2000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="my-2 block w-full rounded border bg-background p-3"
          />
          <button type="submit" disabled={busy || !content.trim()} className="mr-4 rounded border px-3 py-2">
            {busy ? "Saving…" : "Confirm and save"}
          </button>
          <Dialog.Close type="button" className="underline">Close</Dialog.Close>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
