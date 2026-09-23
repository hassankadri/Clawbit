"use client";

import {
  createContext,
  useContext,
  ReactNode,
} from "react";

import useChat from "./useChat";

const ChatContext = createContext<
  ReturnType<typeof useChat> | null
>(null);

export function ChatProvider({
  children,
}: {
  children: ReactNode;
}) {
  const chat = useChat();

  return (
    <ChatContext.Provider value={chat}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext() {
  const context = useContext(ChatContext);

  if (!context)
    throw new Error(
      "useChatContext must be used inside ChatProvider"
    );

  return context;
}
