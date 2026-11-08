"use client";

import { ArrowDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type TouchEvent as ReactTouchEvent,
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
  onRetryMessage: (messageId: string) => Promise<void> | void;
  onStopGeneration: () => void;
}

const BOTTOM_THRESHOLD = 96;

function getDistanceFromBottom(element: HTMLElement): number {
  return Math.max(
    0,
    element.scrollHeight - element.clientHeight - element.scrollTop,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const firstMessageIdRef = useRef<string | undefined>(messages[0]?.id);
  const messageCountRef = useRef(messages.length);
  const touchYRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  /**
   * Stop following new tokens when the user interacts with the chat.
   * This ref changes synchronously, before the next React render.
   */
  const pauseFollowing = useCallback(() => {
    followRef.current = false;

    const viewport = scrollRef.current;
    if (!viewport) return;

    setShowJumpToLatest(getDistanceFromBottom(viewport) > 12);
  }, []);

  /**
   * Follow the latest message only when explicitly requested.
   */
  const scrollToLatest = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    viewport.scrollTop = viewport.scrollHeight;

    lastScrollTopRef.current = viewport.scrollTop;
    followRef.current = true;

    setShowJumpToLatest(false);
  }, []);

  /**
   * Native scrolling remains completely under the user's control.
   */
  const handleScroll = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const distance = getDistanceFromBottom(viewport);

    const movingUp =
      viewport.scrollTop < lastScrollTopRef.current - 1;

    if (movingUp) {
      followRef.current = false;
    } else if (distance <= 12) {
      // Returning to the bottom resumes automatic following.
      followRef.current = true;
    } else if (distance > BOTTOM_THRESHOLD) {
      followRef.current = false;
    }

    lastScrollTopRef.current = viewport.scrollTop;

    setShowJumpToLatest(
      !followRef.current && distance > 12,
    );
  }, []);

  /**
   * Pause automatic following on wheel input.
   * Do not preventDefault: the browser must handle scrolling naturally.
   */
  const handleWheel = useCallback(() => {
    pauseFollowing();
  }, [pauseFollowing]);

  const handleTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      touchYRef.current =
        event.touches[0]?.clientY ?? null;

      pauseFollowing();
    },
    [pauseFollowing],
  );

  const handleTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextY = event.touches[0]?.clientY;

      if (nextY === undefined) return;

      if (
        touchYRef.current !== null &&
        Math.abs(nextY - touchYRef.current) > 2
      ) {
        pauseFollowing();
      }

      touchYRef.current = nextY;
    },
    [pauseFollowing],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;

      if (
        target.matches("input, textarea, select") ||
        target.isContentEditable
      ) {
        return;
      }

      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]
          .includes(event.key)
      ) {
        pauseFollowing();
      }
    },
    [pauseFollowing],
  );

  /**
   * Stream updates are coalesced into animation frames.
   * Crucially, the frame checks followRef again before moving the viewport.
   * A wheel event can therefore cancel auto-follow before the next token.
   */
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const firstId = messages[0]?.id;
    const conversationChanged =
      firstMessageIdRef.current !== firstId;

    firstMessageIdRef.current = firstId;
    messageCountRef.current = messages.length;

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (conversationChanged) {
      followRef.current = true;

      if (messages.length <= 1) {
        viewport.scrollTop = 0;
        lastScrollTopRef.current = 0;

        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null;
          setShowJumpToLatest(false);
        });

        return () => {
          if (animationFrameRef.current !== null) {
            window.cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
          }
        };
      }
    }

    if (!followRef.current || messages.length <= 1) {
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;

      // The user may have started scrolling since this effect was scheduled.
      if (!followRef.current) return;

      const currentViewport = scrollRef.current;
      if (!currentViewport) return;

      if (conversationChanged) {
        setShowJumpToLatest(false);
      }

      currentViewport.scrollTop = currentViewport.scrollHeight;
      lastScrollTopRef.current = currentViewport.scrollTop;
    });

    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [messages, loading]);

  /**
   * Markdown and code blocks can change height without a new message.
   * ResizeObserver follows those changes only while follow mode is active.
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }

      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;

        const viewport = scrollRef.current;
        if (!viewport) return;

        if (followRef.current && messageCountRef.current > 1) {
          viewport.scrollTop = viewport.scrollHeight;
          lastScrollTopRef.current = viewport.scrollTop;
          return;
        }

        const distance = getDistanceFromBottom(viewport);
        setShowJumpToLatest(distance > 12);
      });
    });

    observer.observe(content);

    return () => {
      observer.disconnect();

      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Conversation messages"
        onScroll={handleScroll}
        onWheelCapture={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={() => {
          touchYRef.current = null;
        }}
        onPointerDownCapture={(event) => {
          if (event.target === event.currentTarget) {
            pauseFollowing();
          }
        }}
        onKeyDown={handleKeyDown}
        className="clawbit-chat-scroller min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-auto focus:outline-none"
        style={{
          overflowAnchor: "none",
          scrollBehavior: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div
          ref={contentRef}
          className="clawbit-chat-content mx-auto w-full max-w-[860px] px-3 pb-8 pt-5 sm:px-7 sm:pb-12 sm:pt-10 lg:px-8 lg:pt-14"
        >
          <div className="flex flex-col gap-5 sm:gap-7">
            {messages.map((message, index) => (
              <div
                key={message.id}
                className="animate-[chat-message-enter_180ms_cubic-bezier(0.2,0,0,1)_both]"
                style={{
                  animationDelay:
                    index === messages.length - 1 ? "0ms" : undefined,
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

      {showJumpToLatest && messages.length > 1 && (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label="Jump to latest message"
          title="Jump to latest message"
          className={cn(
            "absolute bottom-5 left-1/2 z-20 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border px-3 text-xs font-medium shadow-lg transition-all duration-200",
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