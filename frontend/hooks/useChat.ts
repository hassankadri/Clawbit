"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ChatStreamError,
  streamChat,
  getActiveChatMode,
  setActiveChatMode,
  type ChatMode,
} from "@/lib/api";
import { createHistory, loadHistory, historySnapshot, removeHistoryMessage } from "@/lib/history";

import {
  DEFAULT_MODEL_ID,
} from "@/lib/models";


/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

import type { SourceReference, ResearchReport } from "@/lib/knowledge";

export interface Message {
  createdAt?: number;
  attachmentIds?: string[];
  sources?: SourceReference[];
  research?: ResearchReport;
  id: string;

  role:
    | "user"
    | "assistant";

  content: string;

  status?:
    | "complete"
    | "streaming"
    | "error"
    | "cancelled";

  error?: string;
  errorStatus?: number;
}


export interface ChatSnapshot {
  mode?: ChatMode;
  historyVersion?: number;
  workspaceId?: string;
  conversationId?: string;
  serverPersisted?: boolean;
  messages:
    Message[];

  threadId:
    string;

  model:
    string;
}


interface ActiveStream {
  flush: () => void;
  timer?: ReturnType<typeof setTimeout>;
  assistantMessageId:
    string;

  controller:
    AbortController;
}


/* ====================================================== */
/* HOOK                                                   */
/* ====================================================== */

export default function useChat(options: { persistent?: boolean } = {}) {
  const persistent = options.persistent ?? false;
  const historyRef = useRef<ChatSnapshot | null>(null);
  const selectionRef = useRef(0);
  const loadRef = useRef<AbortController | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [
    messages,
    setMessages,
  ] =
    useState<Message[]>(
      [],
    );

  const [
    loading,
    setLoading,
  ] =
    useState(
      false,
    );

  const [
    threadId,
    setThreadId,
  ] =
    useState<string>(
      () =>
        crypto.randomUUID(),
    );

  const [
    model,
    setModel,
  ] =
    useState(
      DEFAULT_MODEL_ID,
    );


  const messagesRef =
    useRef<Message[]>(
      [],
    );


  const streamRef =
    useRef<
      ActiveStream
      | null
    >(
      null,
    );


  /* ==================================================== */
  /* KEEP MESSAGE REF CURRENT                             */
  /* ==================================================== */

  useEffect(
    () => {
      messagesRef.current =
        messages;
    },

    [
      messages,
    ],
  );


  /* ==================================================== */
  /* MESSAGE STATE HELPERS                                */
  /* ==================================================== */

  function replaceMessages(
    nextMessages:
      Message[],
  ) {
    messagesRef.current =
      nextMessages;

    setMessages(
      nextMessages,
    );
  }


  function updateMessages(
    updater: (
      current:
        Message[],
    ) => Message[],
  ) {
    setMessages(
      (
        current,
      ) => {
        const next =
          updater(
            current,
          );

        messagesRef.current =
          next;

        return next;
      },
    );
  }


  function updateMessage(
    messageId:
      string,

    updater: (
      message:
        Message,
    ) => Message,
  ) {
    updateMessages(
      (
        current,
      ) =>
        current.map(
          (
            message,
          ) =>
            message.id ===
            messageId
              ? updater(
                  message,
                )
              : message,
        ),
    );
  }


  /* ==================================================== */
  /* STOP GENERATION                                      */
  /* ==================================================== */

  function stopGeneration() {
    const active = streamRef.current;
    if (!active) return;
    active.flush();
    streamRef.current = null;
    active.controller.abort();
    updateMessage(active.assistantMessageId, (message) => ({
      ...message,
      status: "cancelled",
    }));
    setLoading(false);
    if (persistent) setHistoryLoading(true);
  }

  useEffect(() => () => {
    selectionRef.current += 1;
    loadRef.current?.abort();
    const active = streamRef.current;
    streamRef.current = null;
    if (active) {
      clearTimeout(active.timer);
      active.controller.abort();
    }
  }, []);

  async function requestAssistantTurn(
    promptText: string,
    attachmentIds: string[],
    assistantMessageId: string,
    turn?: {
      userMessageId: string;
      operation: "send" | "edit" | "retry" | "regenerate";
      targetMessageId?: string;
      conversationId?: string;
      workspaceId?: string;
      hasLegacyHistory?: boolean;
    },
  ) {
    const controller = new AbortController();
    let pendingText = "";
    let terminal = false;
    const active: ActiveStream = { assistantMessageId, controller, flush };
    streamRef.current = active;
    const isCurrent = () => streamRef.current === active && !controller.signal.aborted;
    const selection = selectionRef.current;
    setHistoryError("");

    function flush() {
      clearTimeout(active.timer);
      active.timer = undefined;
      const text = pendingText;
      pendingText = "";
      if (text && isCurrent()) {
        updateMessage(assistantMessageId, (message) => ({
          ...message, content: message.content + text, status: "streaming",
        }));
      }
    }

    function fail(message: string, status?: number) {
      if (!isCurrent()) return;
      terminal = true;
      flush();
      updateMessage(assistantMessageId, (current) => ({
        ...current, status: "error", error: message, errorStatus: status,
      }));
    }

    try {
      if (persistent && turn) {
        if (!historyRef.current?.serverPersisted) {
          if (turn.hasLegacyHistory) {
            throw new Error("Import this browser conversation before continuing, editing or retrying it.");
          }
          const saved = await createHistory({
            id: turn.conversationId ?? threadId, thread_id: threadId,
            workspace_id: turn.workspaceId ?? threadId, model, mode: getActiveChatMode(),
            title: promptText.trim().slice(0, 80) || "New Chat",
          }, controller.signal);
          if (!isCurrent()) return;
          historyRef.current = historySnapshot(saved);
        }
      }
      await streamChat({
        message: promptText,
        thread_id: threadId || undefined,
        model,
        attachment_ids: attachmentIds,
        ...(persistent && turn ? {
          request_id: crypto.randomUUID(), user_message_id: turn.userMessageId,
          assistant_message_id: assistantMessageId,
          expected_version: historyRef.current?.historyVersion,
          workspace_id: historyRef.current?.workspaceId,
          operation: turn.operation, target_message_id: turn.targetMessageId,
        } : {}),
      }, {
        onStart: (event) => {
          if (isCurrent() && event.thread_id !== threadId) setThreadId(event.thread_id);
        },
        onSources: (sources) => {
          if (isCurrent() && !terminal) updateMessage(assistantMessageId, (message) => ({ ...message, sources }));
        },
        onToken: (text) => {
          if (!isCurrent() || !text || terminal) return;
          pendingText += text;
          // Coalesce deltas for one message update per frame-sized interval.
          if (active.timer === undefined) active.timer = setTimeout(flush, 32);
        },
        onDone: (event) => {
          if (!isCurrent() || terminal) return;
          terminal = true;
          flush();
          if (event.thread_id !== threadId) setThreadId(event.thread_id);
          updateMessage(assistantMessageId, (message) => ({
            ...message,
            sources: event.inspector?.sources ?? [],
            research: event.inspector?.research,
            status: message.content.trim() ? "complete" : "error",
            error: message.content.trim() ? undefined : "The provider returned no answer text.",
          }));
        },
        onError: (event) => fail(event.message, event.status_code),
      }, controller.signal);
      if (!terminal) fail("The response stream ended unexpectedly. Please retry.");
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof Error && error.name === "AbortError") {
        flush();
        updateMessage(assistantMessageId, (message) => ({ ...message, status: "cancelled" }));
      } else {
        fail(
          error instanceof Error ? error.message : "The response failed. Please retry.",
          error instanceof ChatStreamError ? error.status_code : undefined,
        );
      }
    } finally {
      clearTimeout(active.timer);
      if (persistent && historyRef.current?.serverPersisted && selectionRef.current === selection
          && (streamRef.current === active || streamRef.current === null)) {
        try {
          let saved = await loadHistory(threadId);
          for (let attempt = 0; saved.running && attempt < 10; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (selectionRef.current !== selection || (streamRef.current !== active && streamRef.current !== null)) return;
            saved = await loadHistory(threadId);
          }
          if (selectionRef.current === selection && (streamRef.current === active || streamRef.current === null)) {
            historyRef.current = historySnapshot(saved);
            if (turn?.operation === "send" && !saved.messages?.some((message) => message.id === assistantMessageId)) {
              setHistoryError("This attempt was not saved. Your text remains here; copy it before reloading history.");
            } else {
              replaceMessages(saved.messages ?? []);
            }
            if (turn?.operation !== "send" && saved.messages?.at(-1)?.id !== assistantMessageId) {
              setHistoryError("The new revision did not complete. The previous conversation is preserved.");
            }
            window.dispatchEvent(new Event("clawbit-history-updated"));
          }
        } catch {
          if (selectionRef.current === selection) setHistoryError("Could not refresh saved history. Reload before sending again.");
        }
      }
      if (streamRef.current === active) {
        streamRef.current = null;
        setLoading(false);
      }
      if (selectionRef.current === selection && streamRef.current === null) setHistoryLoading(false);
    }
  }


  /* ==================================================== */
  /* SEND MESSAGE                                         */
  /* ==================================================== */

  async function sendMessage(
    text:
      string,

    attachmentIds:
      string[] = [],
    context: { conversationId?: string; workspaceId?: string } = {},
  ) {
    const normalizedText =
      text.trim();


    if (
      !normalizedText &&
      attachmentIds.length ===
        0
    ) {
      return;
    }


    if (
      loading || historyLoading ||
      streamRef.current
    ) {
      return;
    }


    const userMessage: Message =
      {
        createdAt: Date.now(),
        attachmentIds,
        id:
          crypto.randomUUID(),

        role:
          "user",

        content:
          text,

        status:
          "complete",
      };


    const assistantMessage: Message =
      {
        id:
          crypto.randomUUID(),

        role:
          "assistant",

        content:
          "",

        status:
          "streaming",
      };


    const hasLegacyHistory = messagesRef.current.length > 0 && !historyRef.current?.serverPersisted;
    updateMessages(
      (
        current,
      ) => [
        ...current,

        userMessage,

        assistantMessage,
      ],
    );


    setLoading(
      true,
    );


    await requestAssistantTurn(
      text,

      attachmentIds,

      assistantMessage.id,
      { userMessageId: userMessage.id, operation: "send", hasLegacyHistory, ...context },
    );
  }


  /* ==================================================== */
  /* CLEAR CHAT                                           */
  /* ==================================================== */

  function clearChat() {
    stopGeneration();
    selectionRef.current += 1;
    loadRef.current?.abort();
    historyRef.current = null;
    setHistoryError("");
    setHistoryLoading(false);


    replaceMessages(
      [],
    );


    setThreadId(
      crypto.randomUUID(),
    );
  }


  /* ==================================================== */
  /* SNAPSHOT                                             */
  /* ==================================================== */

  function createSnapshot():
    ChatSnapshot {
    return {
      ...historyRef.current,
      mode: getActiveChatMode(),
      messages:
        messagesRef.current,

      threadId,

      model,
    };
  }


  function restoreSnapshot(
    snapshot:
      ChatSnapshot,
  ) {
    stopGeneration();
    selectionRef.current += 1;
    loadRef.current?.abort();
    historyRef.current = snapshot;
    setHistoryError("");
    setHistoryLoading(false);


    replaceMessages(
      snapshot.messages.map((message) => message.status === "streaming"
        ? { ...message, status: "cancelled" as const }
        : message),
    );


    setThreadId(
      snapshot.threadId,
    );


    setModel(
      snapshot.model,
    );
    if (snapshot.mode) setActiveChatMode(snapshot.mode);
    if (persistent && snapshot.serverPersisted) {
      const selection = selectionRef.current;
      const controller = new AbortController();
      loadRef.current = controller;
      setHistoryLoading(true);
      void loadHistory(snapshot.threadId, controller.signal).then((saved) => {
        if (selection !== selectionRef.current) return;
        historyRef.current = historySnapshot(saved);
        replaceMessages(saved.messages ?? []);
        setModel(saved.model);
        setActiveChatMode(saved.mode);
      }).catch((error: unknown) => {
        if (selection === selectionRef.current && !controller.signal.aborted) {
          setHistoryError(error instanceof Error ? error.message : "Could not load saved history.");
        }
      }).finally(() => {
        if (selection === selectionRef.current) setHistoryLoading(false);
      });
    }
  }


  /* ==================================================== */
  /* DELETE MESSAGE                                       */
  /* ==================================================== */

  function deleteMessage(
    messageId:
      string,
  ) {
    if (persistent) {
      if (loading || historyLoading) return;
      const saved = historyRef.current;
      if (saved?.historyVersion === undefined) {
        setHistoryError("Import this browser conversation before changing saved history.");
        return;
      }
      if (!window.confirm("Remove this message and all following messages from the current conversation? The earlier revision will remain saved.")) return;
      const selection = selectionRef.current;
      void removeHistoryMessage(threadId, messageId, saved.historyVersion).then((record) => {
        if (selection !== selectionRef.current) return;
        historyRef.current = historySnapshot(record);
        replaceMessages(record.messages ?? []);
        window.dispatchEvent(new Event("clawbit-history-updated"));
      }).catch((error: unknown) => {
        if (selection === selectionRef.current) setHistoryError(error instanceof Error ? error.message : "Could not remove the message.");
      });
      return;
    }
    if (
      streamRef
        .current
        ?.assistantMessageId ===
      messageId
    ) {
      stopGeneration();
    }


    updateMessages(
      (
        current,
      ) =>
        current.filter(
          (
            message,
          ) =>
            message.id !==
            messageId,
        ),
    );
  }


  /* ==================================================== */
  /* RETRY ASSISTANT                                      */
  /* ==================================================== */

  async function retryAssistantMessage(
    messageId:
      string,
  ) {
    if (
      loading || historyLoading ||
      streamRef.current
    ) {
      return;
    }


    const currentMessages =
      messagesRef.current;


    const messageIndex =
      currentMessages.findIndex(
        (
          item,
        ) =>
          item.id ===
          messageId,
      );


    if (
      messageIndex <=
      0
    ) {
      return;
    }


    const promptMessage =
      currentMessages[
        messageIndex -
        1
      ];


    if (
      promptMessage.role !==
      "user"
    ) {
      return;
    }


    stopGeneration();


    const assistantMessage: Message =
      {
        id:
          crypto.randomUUID(),

        role:
          "assistant",

        content:
          "",

        status:
          "streaming",
      };


    replaceMessages(
      [
        ...currentMessages.slice(
          0,

          messageIndex,
        ),

        assistantMessage,
      ],
    );


    setLoading(
      true,
    );


    await requestAssistantTurn(
      promptMessage.content,

      promptMessage.attachmentIds ?? [],

      assistantMessage.id,
      {
        userMessageId: promptMessage.id,
        operation: currentMessages[messageIndex].status === "complete" ? "regenerate" : "retry",
        targetMessageId: messageId, hasLegacyHistory: !historyRef.current?.serverPersisted,
      },
    );
  }


  /* ==================================================== */
  /* EDIT USER MESSAGE                                    */
  /* ==================================================== */

  async function editMessage(
    messageId:
      string,

    content:
      string,
  ) {
    if (
      loading || historyLoading ||
      streamRef.current
    ) {
      return;
    }


    const currentMessages =
      messagesRef.current;


    const messageIndex =
      currentMessages.findIndex(
        (
          item,
        ) =>
          item.id ===
          messageId,
      );


    if (
      messageIndex <
      0
    ) {
      return;
    }


    const targetMessage =
      currentMessages[
        messageIndex
      ];


    if (
      targetMessage.role !==
      "user"
    ) {
      return;
    }


    const normalizedContent =
      content.trim();


    if (
      !normalizedContent
    ) {
      return;
    }


    stopGeneration();


    const trimmedMessages =
      currentMessages
        .slice(
          0,

          messageIndex +
            1,
        )
        .map(
          (
            message,
          ) =>
            message.id ===
            messageId
              ? {
                  ...message,

                  content,

                  status:
                    "complete" as const,
                }
              : message,
        );


    const assistantMessage: Message =
      {
        id:
          crypto.randomUUID(),

        role:
          "assistant",

        content:
          "",

        status:
          "streaming",
      };


    replaceMessages(
      [
        ...trimmedMessages,

        assistantMessage,
      ],
    );


    setLoading(
      true,
    );


    await requestAssistantTurn(
      content,

      targetMessage.attachmentIds ?? [],

      assistantMessage.id,
      { userMessageId: targetMessage.id, operation: "edit", targetMessageId: messageId,
        hasLegacyHistory: !historyRef.current?.serverPersisted },
    );
  }


  /* ==================================================== */
  /* PUBLIC API                                           */
  /* ==================================================== */

  return {
    historyError,
    historyLoading,
    messages,

    loading,

    model,

    setModel,

    threadId,

    sendMessage,

    stopGeneration,

    deleteMessage,

    retryAssistantMessage,

    editMessage,

    clearChat,

    createSnapshot,

    restoreSnapshot,
  };
}
