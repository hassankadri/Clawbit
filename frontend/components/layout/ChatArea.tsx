
"use client";

import { ArrowDown } from "lucide-react";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import Message from "@/components/chat/Message";
import type { Message as ChatMessage } from "@/hooks/useChat";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface ChatAreaProps {
  messages: ChatMessage[];
  loading: boolean;
  theme: Theme;
  assistantName: string;

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

const BOTTOM_THRESHOLD = 96;

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(
    0,
    element.scrollHeight -
      element.clientHeight -
      element.scrollTop,
  );
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const firstMessageIdRef = useRef<string | undefined>(
    messages[0]?.id,
  );

  const messageCountRef = useRef(messages.length);

  const touchYRef = useRef<number | null>(null);

  const resizeFrameRef = useRef<number | null>(null);

  const [showJumpToLatest, setShowJumpToLatest] =
    useState(false);

  /* ==================================================== */
  /* SCROLL TO LATEST                                     */
  /* ==================================================== */

  function scrollToLatest() {
    const viewport = scrollRef.current;

    if (!viewport) return;

    /*
     * Do not animate automatic scrolling.
     *
     * Repeated smooth-scroll commands compete with
     * mouse and touch scrolling during streamed responses.
     */

    viewport.scrollTop = viewport.scrollHeight;

    lastScrollTopRef.current = viewport.scrollTop;

    followRef.current = true;

    setShowJumpToLatest(false);
  }

  /* ==================================================== */
  /* PAUSE AUTOMATIC FOLLOWING                            */
  /* ==================================================== */

  function pauseFollowing() {
    followRef.current = false;

    const viewport = scrollRef.current;

    if (
      viewport &&
      viewport.scrollHeight > viewport.clientHeight + 2
    ) {
      setShowJumpToLatest(true);
    }
  }

  /* ==================================================== */
  /* NATIVE SCROLL TRACKING                               */
  /* ==================================================== */

  function handleScroll() {
    const viewport = scrollRef.current;

    if (!viewport) return;

    const distance = distanceFromBottom(viewport);

    const movingUp =
      viewport.scrollTop < lastScrollTopRef.current - 1;

    if (movingUp) {
      /*
       * Mouse, trackpad, scrollbar dragging and
       * keyboard scrolling all pause auto-follow.
       */
      followRef.current = false;
    } else if (distance <= 12) {
      /*
       * Resume when the user returns almost exactly
       * to the bottom of the conversation.
       */
      followRef.current = true;
    } else if (distance > BOTTOM_THRESHOLD) {
      followRef.current = false;
    }

    lastScrollTopRef.current = viewport.scrollTop;

    setShowJumpToLatest(
      !followRef.current &&
        viewport.scrollHeight > viewport.clientHeight + 2,
    );
  }

  /* ==================================================== */
  /* MOUSE AND TRACKPAD                                   */
  /* ==================================================== */

  function handleWheel(
    event: ReactWheelEvent<HTMLDivElement>,
  ) {
    /*
     * Pause before the browser performs upward scrolling.
     *
     * This avoids another streamed token pulling the
     * conversation back down.
     */
    if (event.deltaY < 0) {
      pauseFollowing();
    }
  }

  /* ==================================================== */
  /* TOUCH SCROLLING                                      */
  /* ==================================================== */

  function handleTouchStart(
    event: ReactTouchEvent<HTMLDivElement>,
  ) {
    touchYRef.current =
      event.touches[0]?.clientY ?? null;
  }

  function handleTouchMove(
    event: ReactTouchEvent<HTMLDivElement>,
  ) {
    const nextY = event.touches[0]?.clientY;

    if (nextY === undefined) return;

    if (
      touchYRef.current !== null &&
      nextY > touchYRef.current + 2
    ) {
      /*
       * Moving a finger downward scrolls toward
       * earlier messages.
       */
      pauseFollowing();
    }

    touchYRef.current = nextY;
  }

  /* ==================================================== */
  /* KEYBOARD SCROLLING                                   */
  /* ==================================================== */

  function handleKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const target = event.target as HTMLElement;

    if (
      target.matches("input,textarea,select") ||
      target.isContentEditable
    ) {
      return;
    }

    if (
      ["ArrowUp", "PageUp", "Home"].includes(event.key)
    ) {
      pauseFollowing();
    }
  }

  /* ==================================================== */
  /* MESSAGE UPDATES                                      */
  /* ==================================================== */

  useLayoutEffect(() => {
    const viewport = scrollRef.current;

    if (!viewport) return;

    const firstId = messages[0]?.id;

    const conversationChanged =
      firstMessageIdRef.current !== firstId;

    firstMessageIdRef.current = firstId;
    messageCountRef.current = messages.length;

    if (conversationChanged) {
      followRef.current = true;

      if (messages.length <= 1) {
        /*
         * Keep the first message at the beginning
         * of a new conversation.
         */
        viewport.scrollTop = 0;
        lastScrollTopRef.current = 0;

        /*
         * Reset after layout, rather than calling
         * setState synchronously inside the effect.
         *
         * Cancel if messages change again before
         * this animation frame executes.
         */
        const frameId = window.requestAnimationFrame(() => {
          setShowJumpToLatest(false);
        });

        return () => {
          window.cancelAnimationFrame(frameId);
        };
      } else {
        /*
         * Opening an existing conversation starts
         * at its latest messages.
         */
        scrollToLatest();
      }

      return;
    }

    /*
     * Streamed text can update the existing assistant
     * message without adding another message to the array.
     *
     * Only follow if the user has not scrolled away.
     */
    if (messages.length > 1 && followRef.current) {
      scrollToLatest();
    }
  }, [messages, loading]);

  /* ==================================================== */
  /* DYNAMIC CONTENT HEIGHT                               */
  /* ==================================================== */

  useEffect(() => {
    const content = contentRef.current;

    if (
      !content ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }

    /*
     * Markdown, images and streamed text may change
     * height without changing the message count.
     *
     * The observer follows those changes only while
     * auto-follow is enabled.
     */
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;

        if (
          followRef.current &&
          messageCountRef.current > 1
        ) {
          scrollToLatest();
        }
      });
    });

    observer.observe(content);

    return () => {
      observer.disconnect();

      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, []);

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* SCROLLABLE CONVERSATION */}

      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Conversation messages"
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={() => {
          touchYRef.current = null;
        }}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain focus:outline-none"
        style={{
          overflowAnchor: "none",
        }}
      >
        <div
          ref={contentRef}
          className="mx-auto w-full max-w-[860px] px-5 pb-12 pt-10 sm:px-7 sm:pt-12 lg:px-8 lg:pt-14"
        >
          <div className="flex flex-col gap-7">
            {messages.map((message, index) => (
              <div
                key={message.id}
                className="animate-[chat-message-enter_180ms_cubic-bezier(0.2,0,0,1)_both]"
                style={{
                  animationDelay:
                    index === messages.length - 1
                      ? "0ms"
                      : undefined,
                }}
              >
                <Message
                  theme={theme}
                  message={message}
                  assistantName={assistantName}
                  onEditMessage={onEditMessage}
                  onDeleteMessage={onDeleteMessage}
                  onRetryMessage={onRetryMessage}
                  onStopGeneration={onStopGeneration}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* JUMP TO LATEST */}

      {showJumpToLatest && (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label="Jump to latest message"
          title="Jump to latest message"
          className={cn(
            "absolute bottom-5 left-1/2 z-20 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border px-3 text-xs font-medium shadow-lg transition-colors",
            theme === "dark"
              ? "border-white/15 bg-[#242424] text-zinc-100 hover:bg-[#303030]"
              : "border-black/10 bg-white text-zinc-800 hover:bg-zinc-100",
          )}
        >
          <ArrowDown size={15} strokeWidth={1.8} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
