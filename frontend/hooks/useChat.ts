"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  streamChat,
} from "@/lib/api";

import {
  DEFAULT_MODEL_ID,
} from "@/lib/models";


/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

export interface Message {
  id: string;

  role:
    | "user"
    | "assistant";

  content: string;

  status?:
    | "complete"
    | "streaming"
    | "error";
}


export interface ChatSnapshot {
  messages:
    Message[];

  threadId:
    string;

  model:
    string;
}


interface ActiveStream {
  assistantMessageId:
    string;

  controller:
    AbortController;
}


/* ====================================================== */
/* HOOK                                                   */
/* ====================================================== */

export default function useChat() {
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
    const activeStream =
      streamRef.current;

    if (
      !activeStream
    ) {
      setLoading(
        false,
      );

      return;
    }


    /*
     * Abort the active fetch request.
     */
    activeStream.controller.abort();


    /*
     * Keep whatever text was already streamed.
     */
    updateMessage(
      activeStream.assistantMessageId,

      (
        message,
      ) => ({
        ...message,

        content:
          message.content
            .trim()
            .length >
          0
            ? message.content
            : "Generation stopped.",

        status:
          "complete",
      }),
    );


    streamRef.current =
      null;

    setLoading(
      false,
    );
  }


  /* ==================================================== */
  /* REQUEST ASSISTANT TURN                               */
  /* ==================================================== */

  async function requestAssistantTurn(
    promptText:
      string,

    attachmentIds:
      string[],

    assistantMessageId:
      string,
  ) {
    const controller =
      new AbortController();


    const activeStream: ActiveStream =
      {
        assistantMessageId,

        controller,
      };


    streamRef.current =
      activeStream;


    let streamFinished =
      false;

    let streamFailed =
      false;

    let receivedContent =
      false;


    try {
      await streamChat(
        {
          message:
            promptText,

          thread_id:
            threadId ||
            undefined,

          model,

          attachment_ids:
            attachmentIds,
        },

        {
          /* ============================================ */
          /* STREAM START                                 */
          /* ============================================ */

          onStart: (
            event,
          ) => {
            if (
              controller
                .signal
                .aborted
            ) {
              return;
            }


            if (
              event.thread_id &&
              event.thread_id !==
                threadId
            ) {
              setThreadId(
                event.thread_id,
              );
            }
          },


          /* ============================================ */
          /* REAL TOKEN STREAM                            */
          /* ============================================ */

          onToken: (
            text,
          ) => {
            if (
              controller
                .signal
                .aborted
            ) {
              return;
            }


            if (
              !text
            ) {
              return;
            }


            receivedContent =
              true;


            updateMessage(
              assistantMessageId,

              (
                message,
              ) => ({
                ...message,

                content:
                  message.content +
                  text,

                status:
                  "streaming",
              }),
            );
          },


          /* ============================================ */
          /* STREAM COMPLETE                              */
          /* ============================================ */

          onDone: (
            event,
          ) => {
            if (
              controller
                .signal
                .aborted
            ) {
              return;
            }


            streamFinished =
              true;


            if (
              event.thread_id &&
              event.thread_id !==
                threadId
            ) {
              setThreadId(
                event.thread_id,
              );
            }


            updateMessage(
              assistantMessageId,

              (
                message,
              ) => ({
                ...message,

                content:
                  message.content
                    .trim()
                    .length >
                  0
                    ? message.content
                    : "I couldn't generate a response. Please try again.",

                status:
                  message.content
                    .trim()
                    .length >
                  0
                    ? "complete"
                    : "error",
              }),
            );


            if (
              streamRef
                .current
                ?.assistantMessageId ===
              assistantMessageId
            ) {
              streamRef.current =
                null;
            }


            setLoading(
              false,
            );
          },


          /* ============================================ */
          /* BACKEND SSE ERROR                            */
          /* ============================================ */

          onError: (
            event,
          ) => {
            if (
              controller
                .signal
                .aborted
            ) {
              return;
            }


            streamFailed =
              true;


            const errorMessage =
              event.message
                ?.trim() ||
              "I couldn't generate a response right now. Please try again.";


            updateMessage(
              assistantMessageId,

              (
                message,
              ) => ({
                ...message,

                content:
                  errorMessage,

                status:
                  "error",
              }),
            );


            if (
              streamRef
                .current
                ?.assistantMessageId ===
              assistantMessageId
            ) {
              streamRef.current =
                null;
            }


            setLoading(
              false,
            );
          },
        },

        controller.signal,
      );


      /*
       * If the connection ended without receiving either
       * "done" or "error", treat it as an interrupted stream.
       */
      if (
        !controller
          .signal
          .aborted &&
        !streamFinished &&
        !streamFailed
      ) {
        if (
          receivedContent
        ) {
          updateMessage(
            assistantMessageId,

            (
              message,
            ) => ({
              ...message,

              status:
                "complete",
            }),
          );

          streamFinished =
            true;
        } else {
          updateMessage(
            assistantMessageId,

            (
              message,
            ) => ({
              ...message,

              content:
                "The response stream ended unexpectedly. Please try again.",

              status:
                "error",
            }),
          );

          streamFailed =
            true;
        }
      }
    } catch (
      error
    ) {
      /*
       * Abort is expected when the user presses Stop.
       */
      if (
        controller
          .signal
          .aborted
      ) {
        return;
      }


      streamFailed =
        true;


      const errorMessage =
        error instanceof
        Error
          ? error.message
          : "I couldn't generate a response right now. Please try again.";


      updateMessage(
        assistantMessageId,

        (
          message,
        ) => ({
          ...message,

          content:
            errorMessage,

          status:
            "error",
        }),
      );


      console.error(
        error,
      );
    } finally {
      if (
        streamRef
          .current
          ?.assistantMessageId ===
        assistantMessageId
      ) {
        streamRef.current =
          null;
      }


      if (
        !controller
          .signal
          .aborted
      ) {
        setLoading(
          false,
        );
      }
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
      loading ||
      streamRef.current
    ) {
      return;
    }


    const userMessage: Message =
      {
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
    );
  }


  /* ==================================================== */
  /* CLEAR CHAT                                           */
  /* ==================================================== */

  function clearChat() {
    stopGeneration();


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


    replaceMessages(
      snapshot.messages,
    );


    setThreadId(
      snapshot.threadId,
    );


    setModel(
      snapshot.model,
    );
  }


  /* ==================================================== */
  /* DELETE MESSAGE                                       */
  /* ==================================================== */

  function deleteMessage(
    messageId:
      string,
  ) {
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
      loading ||
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

      [],

      assistantMessage.id,
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
      loading ||
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

      [],

      assistantMessage.id,
    );
  }


  /* ==================================================== */
  /* PUBLIC API                                           */
  /* ==================================================== */

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