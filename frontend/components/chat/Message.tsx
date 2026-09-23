"use client";

import type { Theme } from "@/lib/theme";
import AssistantMessage from "./AssistantMessage";
import UserMessage from "./UserMessage";

export interface MessageProps {
  theme: Theme;
  message: {
    id: string;
    role: "user" | "assistant";
    content: string;
    status?: "complete" | "streaming" | "error";
  };
  onEditMessage: (messageId: string, content: string) => Promise<void> | void;
  onDeleteMessage: (messageId: string) => void;
  onRetryMessage: (messageId: string) => Promise<void> | void;
  onStopGeneration: () => void;
}

export default function Message({
  theme,
  message,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onStopGeneration,
}: MessageProps) {
  if (message.role === "user") {
    return (
      <UserMessage
        theme={theme}
        content={message.content}
        onEdit={(nextContent) => onEditMessage(message.id, nextContent)}
        onDelete={() => onDeleteMessage(message.id)}
      />
    );
  }

  return (
    <AssistantMessage
      theme={theme}
      content={message.content}
      status={message.status}
      onDelete={() => onDeleteMessage(message.id)}
      onRetry={() => onRetryMessage(message.id)}
      onStop={onStopGeneration}
    />
  );
}
