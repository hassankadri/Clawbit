
"use client";

import type {
  SourceReference,
  ResearchReport,
} from "@/lib/knowledge";

import type { Theme } from "@/lib/theme";

import AssistantMessage from "./AssistantMessage";
import UserMessage from "./UserMessage";

export interface MessageProps {
  theme: Theme;
  assistantName: string;

  message: {
    id: string;
    role: "user" | "assistant";
    content: string;
    attachmentIds?: string[];
    status?: "complete" | "streaming" | "error" | "cancelled";
    error?: string;
    sources?: SourceReference[];
    research?: ResearchReport;
  };

  onEditMessage: (
    messageId: string,
    content: string,
  ) => Promise<void> | void;

  onDeleteMessage: (messageId: string) => void;

  onRetryMessage: (
    messageId: string,
  ) => Promise<void> | void;

  onStopGeneration: () => void;
}

export default function Message({
  theme,
  assistantName,
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
        attachmentIds={message.attachmentIds}
        onEdit={(nextContent) =>
          onEditMessage(message.id, nextContent)
        }
        onDelete={() => onDeleteMessage(message.id)}
      />
    );
  }

  return (
    <AssistantMessage
      theme={theme}
      assistantName={assistantName}
      content={message.content}
      status={message.status}
      error={message.error}
      sources={message.sources}
      research={message.research}
      onDelete={() => onDeleteMessage(message.id)}
      onRetry={() => onRetryMessage(message.id)}
      onStop={onStopGeneration}
    />
  );
}
