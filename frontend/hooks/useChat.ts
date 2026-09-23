"use client";

import { useEffect, useRef, useState } from "react";

import { chat } from "@/lib/api";
import { DEFAULT_MODEL_ID } from "@/lib/models";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "complete" | "streaming" | "error";
}

export interface ChatSnapshot {
  messages: Message[];
  threadId: string;
  model: string;
}

export default function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID());
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const messagesRef = useRef<Message[]>([]);
  const streamRef = useRef<{
    assistantMessageId: string;
    controller: AbortController;
    timeoutId: number | null;
  } | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  function updateMessage(
    messageId: string,
    updater: (message: Message) => Message,
  ) {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? updater(message) : message,
      ),
    );
  }

  function stopGeneration() {
    const activeStream = streamRef.current;
    const assistantMessage = activeStream
      ? messagesRef.current.find(
          (message) => message.id === activeStream.assistantMessageId,
        )
      : null;

    if (activeStream) {
      if (activeStream.timeoutId !== null) {
        window.clearTimeout(activeStream.timeoutId);
      }

      activeStream.controller.abort();
    }

    if (assistantMessage) {
      updateMessage(assistantMessage.id, (message) => ({
        ...message,
        content:
          message.content.trim().length > 0
            ? message.content
            : "Generation stopped.",
        status: "complete",
      }));
    }

    streamRef.current = null;
    setLoading(false);
  }

  async function streamAssistantResponse(
    assistantMessageId: string,
    responseText: string,
  ) {
    const tokens = responseText.match(/\S+\s*/g) ?? [responseText];
    let index = 0;

    const revealNext = () => {
      const activeStream = streamRef.current;

      if (
        !activeStream ||
        activeStream.assistantMessageId !== assistantMessageId
      ) {
        return;
      }

      const nextContent = tokens.slice(0, index + 1).join("");

      updateMessage(assistantMessageId, (message) => ({
        ...message,
        content: nextContent,
        status: "streaming",
      }));

      index += 1;

      if (index >= tokens.length) {
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          content: responseText,
          status: "complete",
        }));

        streamRef.current = null;
        setLoading(false);
        return;
      }

      const delay = Math.max(8, Math.min(26, Math.floor(1200 / Math.max(tokens.length, 1))));
      activeStream.timeoutId = window.setTimeout(revealNext, delay);
    };

    revealNext();
  }

  async function requestAssistantTurn(
    promptText: string,
    attachmentIds: string[],
    assistantMessageId: string,
  ) {
    const controller = new AbortController();
    streamRef.current = {
      assistantMessageId,
      controller,
      timeoutId: null,
    };

    try {
      const response = await chat(
        {
          message: promptText,
          thread_id: threadId || undefined,
          model,
          attachment_ids: attachmentIds,
        },
        controller.signal,
      );

      if (controller.signal.aborted) {
        return;
      }

      if (threadId !== response.thread_id) {
        setThreadId(response.thread_id);
      }

      await streamAssistantResponse(assistantMessageId, response.response);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      updateMessage(assistantMessageId, (message) => ({
        ...message,
        content:
          "I couldn’t generate a response right now. Please try again.",
        status: "error",
      }));

      streamRef.current = null;
      setLoading(false);
      console.error(error);
    }
  }

  async function sendMessage(text: string, attachmentIds: string[] = []) {
    if (!text.trim() && attachmentIds.length === 0) return;
    if (loading || streamRef.current) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      status: "complete",
    };
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      status: "streaming",
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setLoading(true);
    await requestAssistantTurn(text, attachmentIds, assistantMessage.id);
  }

  function clearChat() {
    stopGeneration();
    setMessages([]);
    setThreadId(crypto.randomUUID());
  }

  function createSnapshot(): ChatSnapshot {
    return {
      messages,
      threadId,
      model,
    };
  }

  function restoreSnapshot(
    snapshot: ChatSnapshot
  ) {
    stopGeneration();
    setMessages(snapshot.messages);
    setThreadId(snapshot.threadId);
    setModel(snapshot.model);
  }

  function deleteMessage(messageId: string) {
    if (streamRef.current?.assistantMessageId === messageId) {
      stopGeneration();
    }

    setMessages((current) =>
      current.filter((message) => message.id !== messageId),
    );
  }

  async function retryAssistantMessage(messageId: string) {
    const currentMessages = messagesRef.current;
    const messageIndex = currentMessages.findIndex((item) => item.id === messageId);

    if (messageIndex <= 0) return;

    const promptMessage = currentMessages[messageIndex - 1];
    if (promptMessage.role !== "user") return;

    stopGeneration();

    setMessages(currentMessages.slice(0, messageIndex));
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      status: "streaming",
    };

    setMessages((current) => [...current, assistantMessage]);
    setLoading(true);
    await requestAssistantTurn(promptMessage.content, [], assistantMessage.id);
  }

  async function editMessage(messageId: string, content: string) {
    const currentMessages = messagesRef.current;
    const messageIndex = currentMessages.findIndex((item) => item.id === messageId);

    if (messageIndex < 0) return;

    const targetMessage = currentMessages[messageIndex];
    if (targetMessage.role !== "user") return;

    stopGeneration();

    const trimmedMessages = currentMessages.slice(0, messageIndex + 1).map((message) =>
      message.id === messageId
        ? {
            ...message,
            content,
            status: "complete" as const,
          }
        : message,
    );

    setMessages(trimmedMessages);

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      status: "streaming",
    };

    setMessages((current) => [...current, assistantMessage]);
    setLoading(true);
    await requestAssistantTurn(content, [], assistantMessage.id);
  }

  return {
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
