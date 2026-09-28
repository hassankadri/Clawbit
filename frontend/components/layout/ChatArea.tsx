"use client";

import {
  useEffect,
  useRef,
} from "react";

import Message from "@/components/chat/Message";
import type { Message as ChatMessage } from "@/hooks/useChat";
import type { Theme } from "@/lib/theme";

interface ChatAreaProps {
  messages: ChatMessage[];
  loading: boolean;
  theme: Theme;
  assistantName: string;

  onEditMessage: (
    messageId: string,
    content: string,
  ) => Promise<void> | void;

  onDeleteMessage: (
    messageId: string,
  ) => void;

  onRetryMessage: (
    messageId: string,
  ) => Promise<void> | void;

  onStopGeneration: () => void;
}

export default function ChatArea({
  messages,
  loading,
  theme,
  assistantName,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onStopGeneration,
}: ChatAreaProps) {
  const scrollRef =
    useRef<HTMLDivElement | null>(
      null,
    );

  const endRef =
    useRef<HTMLDivElement | null>(
      null,
    );

  const previousMessageCountRef =
    useRef(
      messages.length,
    );

  /* ====================================================== */
  /* SCROLL BEHAVIOR                                        */
  /* ====================================================== */

  useEffect(() => {
    const previousCount =
      previousMessageCountRef.current;

    const currentCount =
      messages.length;

    previousMessageCountRef.current =
      currentCount;

    /*
     * Important:
     *
     * Do NOT force-scroll the first message to the bottom.
     * That is what made the conversation feel like it was
     * growing from bottom -> top.
     *
     * Once a conversation is already underway, keep newer
     * messages visible with a gentle scroll.
     */
    if (
      currentCount <= 1
    ) {
      scrollRef.current?.scrollTo({
        top: 0,
        behavior: "auto",
      });

      return;
    }

    if (
      currentCount >
        previousCount ||
      loading
    ) {
      const frameId =
        window.requestAnimationFrame(
          () => {
            endRef.current?.scrollIntoView({
              behavior:
                "smooth",

              block:
                "end",
            });
          },
        );

      return () =>
        window.cancelAnimationFrame(
          frameId,
        );
    }
  }, [
    loading,
    messages,
  ]);

  /* ====================================================== */
  /* UI                                                     */
  /* ====================================================== */

  return (
    <div
      ref={
        scrollRef
      }
      className="min-h-0 flex-1 overflow-y-auto scroll-smooth"
    >
      <div className="mx-auto w-full max-w-[860px] px-5 pb-12 pt-10 sm:px-7 sm:pt-12 lg:px-8 lg:pt-14">
        <div className="flex flex-col gap-7">
          {messages.map(
            (
              message,
              index,
            ) => (
              <div
                key={
                  message.id
                }
                className="animate-[chat-message-enter_180ms_cubic-bezier(0.2,0,0,1)_both]"
                style={{
                  animationDelay:
                    index ===
                    messages.length -
                      1
                      ? "0ms"
                      : undefined,
                }}
              >
                <Message
                  theme={
                    theme
                  }
                  message={
                    message
                  }
                  assistantName={
                    assistantName
                  }
                  onEditMessage={
                    onEditMessage
                  }
                  onDeleteMessage={
                    onDeleteMessage
                  }
                  onRetryMessage={
                    onRetryMessage
                  }
                  onStopGeneration={
                    onStopGeneration
                  }
                />
              </div>
            ),
          )}

          <div
            ref={
              endRef
            }
            className="h-2"
          />
        </div>
      </div>
    </div>
  );
}