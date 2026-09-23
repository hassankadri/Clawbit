"use client";

import { useEffect, useRef } from "react";

import Message from "@/components/chat/Message";
import type { Message as ChatMessage } from "@/hooks/useChat";
import type { Theme } from "@/lib/theme";

interface ChatAreaProps {
  messages: ChatMessage[];
  loading: boolean;
  theme: Theme;
  onEditMessage: (messageId: string, content: string) => Promise<void> | void;
  onDeleteMessage: (messageId: string) => void;
  onRetryMessage: (messageId: string) => Promise<void> | void;
  onStopGeneration: () => void;
}

export default function ChatArea({
  messages,
  loading,
  theme,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onStopGeneration,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [loading, messages]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-end gap-5 px-4 pb-5 pt-14 sm:px-6 sm:pb-6 sm:pt-16 lg:px-8">
        {messages.map((message) => (
          <Message
            key={message.id}
            theme={theme}
            message={message}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            onRetryMessage={onRetryMessage}
            onStopGeneration={onStopGeneration}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
