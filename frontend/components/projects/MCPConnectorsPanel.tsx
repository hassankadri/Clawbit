"use client";

import * as Dialog from "@radix-ui/react-dialog";

import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  CreditCard,
  GitBranch,
  HardDrive,
  KeyRound,
  MessageSquare,
  PlugZap,
  RefreshCw,
  Search,
  Terminal,
  Unplug,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  connectGitHubMCP,
  connectGoogleDriveMCP,
  connectNotionMCP,
  connectSlackMCP,
  connectStripeMCP,
  disconnectGitHubMCP,
  disconnectGoogleDriveMCP,
  disconnectNotionMCP,
  disconnectSlackMCP,
  disconnectStripeMCP,
  getMCPCatalog,
  getMCPStatus,
  refreshMCPStatus,
  type MCPConnectorCatalogItem,
  type MCPServerStatus,
  type MCPStatusResponse,
} from "@/lib/api";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface MCPConnectorsPanelProps {
  theme: Theme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ConnectorView {
  id: string;
  name: string;
  description: string;
  category: string;
  configured: boolean;
  connected: boolean;
  auth?: string;
  server?: MCPServerStatus;
}

type TokenConnectorId =
  | "github"
  | "notion"
  | "stripe";

type OAuthConnectorId =
  | "google-drive"
  | "slack";

type ConnectorId =
  | TokenConnectorId
  | OAuthConnectorId;

function isTokenConnector(
  id: string,
): id is TokenConnectorId {
  return (
    id === "github" ||
    id === "notion" ||
    id === "stripe"
  );
}

function isOAuthConnector(
  id: string,
): id is OAuthConnectorId {
  return (
    id === "google-drive" ||
    id === "slack"
  );
}

function sleep(
  milliseconds: number,
) {
  return new Promise<void>(
    (resolve) => {
      window.setTimeout(
        resolve,
        milliseconds,
      );
    },
  );
}

/* ====================================================== */
/* CONNECTOR ICONS                                        */
/* ====================================================== */

const CONNECTOR_ICONS: Record<
  string,
  LucideIcon
> = {
  github: GitBranch,
  notion: BookOpen,
  stripe: CreditCard,
  "google-drive":
    HardDrive,
  slack: MessageSquare,
};

/* ====================================================== */
/* COMPONENT                                              */
/* ====================================================== */

export default function MCPConnectorsPanel({
  theme,
  open,
  onOpenChange,
}: MCPConnectorsPanelProps) {
  const isDark =
    theme === "dark";

  const [
    catalog,
    setCatalog,
  ] =
    useState<
      MCPConnectorCatalogItem[]
    >([]);

  const [
    status,
    setStatus,
  ] =
    useState<
      MCPStatusResponse | null
    >(null);

  const [
    loading,
    setLoading,
  ] =
    useState(false);

  const [
    refreshing,
    setRefreshing,
  ] =
    useState(false);

  const [
    error,
    setError,
  ] =
    useState<
      string | null
    >(null);

  const [
    selectedId,
    setSelectedId,
  ] =
    useState(
      "github",
    );

  const [
    search,
    setSearch,
  ] =
    useState("");

  const [
    credentialDialogOpen,
    setCredentialDialogOpen,
  ] =
    useState(false);

  const [
    credentialConnector,
    setCredentialConnector,
  ] =
    useState<
      TokenConnectorId | null
    >(null);

  const [
    credential,
    setCredential,
  ] =
    useState("");

  const [
    credentialError,
    setCredentialError,
  ] =
    useState<
      string | null
    >(null);

  const [
    connecting,
    setConnecting,
  ] =
    useState(false);

  const [
    oauthConnectingId,
    setOAuthConnectingId,
  ] =
    useState<
      OAuthConnectorId | null
    >(null);

  const [
    disconnectingId,
    setDisconnectingId,
  ] =
    useState<
      ConnectorId | null
    >(null);

  /* ==================================================== */
  /* INITIAL LOAD                                         */
  /* ==================================================== */

  useEffect(() => {
    if (
      !open
    ) {
      return;
    }

    const controller =
      new AbortController();

    async function load() {
      setLoading(
        true,
      );

      setError(
        null,
      );

      try {
        const catalogResult =
          await getMCPCatalog(
            controller.signal,
          );

        if (
          controller.signal.aborted
        ) {
          return;
        }

        setCatalog(
          catalogResult.connectors,
        );

        const statusResult =
          await getMCPStatus(
            controller.signal,
          );

        if (
          controller.signal.aborted
        ) {
          return;
        }

        setStatus(
          statusResult,
        );
      } catch (
        loadError
      ) {
        if (
          controller.signal.aborted
        ) {
          return;
        }

        setError(
          loadError instanceof
            Error
            ? loadError.message
            : "Could not load MCP connectors.",
        );
      } finally {
        if (
          !controller.signal.aborted
        ) {
          setLoading(
            false,
          );
        }
      }
    }

    void load();

    return () => {
      controller.abort();
    };
  }, [
    open,
  ]);

  /* ==================================================== */
  /* CONNECTORS                                           */
  /* ==================================================== */

  const connectors =
    useMemo<
      ConnectorView[]
    >(
      () => {
        const serverMap =
          new Map<
            string,
            MCPServerStatus
          >();

        for (
          const server of
          status?.servers ??
          []
        ) {
          serverMap.set(
            server.id,
            server,
          );
        }

        return catalog
          .filter(
            (
              item,
            ) =>
              item.available !==
              false,
          )
          .map(
            (
              item,
            ) => {
              const server =
                serverMap.get(
                  item.id,
                );

              return {
                id:
                  item.id,

                name:
                  item.name,

                description:
                  item.description,

                category:
                  item.category,

                configured:
                  item.configured,

                connected:
                  server?.status ===
                  "connected",

                auth:
                  item.auth,

                server,
              };
            },
          );
      },
      [
        catalog,
        status,
      ],
    );

  /* ==================================================== */
  /* SEARCH                                               */
  /* ==================================================== */

  const filteredConnectors =
    useMemo(
      () => {
        const query =
          search
            .trim()
            .toLowerCase();

        if (
          !query
        ) {
          return connectors;
        }

        return connectors.filter(
          (
            connector,
          ) =>
            [
              connector.name,
              connector.description,
              connector.category,
            ]
              .join(
                " ",
              )
              .toLowerCase()
              .includes(
                query,
              ),
        );
      },
      [
        connectors,
        search,
      ],
    );

  const selectedConnector =
    connectors.find(
      (
        connector,
      ) =>
        connector.id ===
        selectedId,
    ) ??
    connectors[0] ??
    null;

  const connectedCount =
    connectors.filter(
      (
        connector,
      ) =>
        connector.connected,
    ).length;

  /* ==================================================== */
  /* CREDENTIAL COPY                                      */
  /* ==================================================== */

  function getCredentialTitle(
    id:
      TokenConnectorId,
  ) {
    switch (
      id
    ) {
      case "github":
        return "Connect GitHub";

      case "notion":
        return "Connect Notion";

      case "stripe":
        return "Connect Stripe";
    }
  }

  function getCredentialLabel(
    id:
      TokenConnectorId,
  ) {
    switch (
      id
    ) {
      case "github":
        return "GitHub access token";

      case "notion":
        return "Notion integration token";

      case "stripe":
        return "Stripe secret or restricted key";
    }
  }

  function getCredentialPlaceholder(
    id:
      TokenConnectorId,
  ) {
    switch (
      id
    ) {
      case "github":
        return "github_pat_...";

      case "notion":
        return "ntn_...";

      case "stripe":
        return "sk_... or rk_...";
    }
  }

  function getCredentialHelp(
    id:
      TokenConnectorId,
  ) {
    switch (
      id
    ) {
      case "github":
        return "Clawbit will only receive the GitHub permissions granted to this token.";

      case "notion":
        return "Use an integration token that has access to the Notion pages you want Clawbit to work with.";

      case "stripe":
        return "Use a restricted Stripe key when possible and only grant the permissions Clawbit needs.";
    }
  }

  /* ==================================================== */
  /* RELOAD                                               */
  /* ==================================================== */

  async function reloadMCP() {
    const [
      catalogResult,
      statusResult,
    ] =
      await Promise.all(
        [
          getMCPCatalog(),
          getMCPStatus(),
        ],
      );

    setCatalog(
      catalogResult.connectors,
    );

    setStatus(
      statusResult,
    );
  }

  /* ==================================================== */
  /* REFRESH                                              */
  /* ==================================================== */

  async function handleRefresh() {
    if (
      refreshing
    ) {
      return;
    }

    setRefreshing(
      true,
    );

    setError(
      null,
    );

    try {
      const [
        catalogResult,
        statusResult,
      ] =
        await Promise.all(
          [
            getMCPCatalog(),
            refreshMCPStatus(),
          ],
        );

      setCatalog(
        catalogResult.connectors,
      );

      setStatus(
        statusResult,
      );
    } catch (
      refreshError
    ) {
      setError(
        refreshError instanceof
          Error
          ? refreshError.message
          : "Could not refresh MCP connectors.",
      );
    } finally {
      setRefreshing(
        false,
      );
    }
  }

  /* ==================================================== */
  /* TOKEN CONNECTORS                                     */
  /* ==================================================== */

  function openConnectDialog(
    connectorId:
      string,
  ) {
    if (
      !isTokenConnector(
        connectorId,
      )
    ) {
      return;
    }

    setCredentialConnector(
      connectorId,
    );

    setCredential(
      "",
    );

    setCredentialError(
      null,
    );

    setCredentialDialogOpen(
      true,
    );
  }

  async function handleTokenConnect() {
    if (
      !credentialConnector ||
      !credential.trim() ||
      connecting
    ) {
      return;
    }

    setConnecting(
      true,
    );

    setCredentialError(
      null,
    );

    setError(
      null,
    );

    try {
      switch (
        credentialConnector
      ) {
        case "github":
          await connectGitHubMCP(
            credential,
          );

          break;

        case "notion":
          await connectNotionMCP(
            credential,
          );

          break;

        case "stripe":
          await connectStripeMCP(
            credential,
          );

          break;
      }

      await reloadMCP();

      setSelectedId(
        credentialConnector,
      );

      setCredential(
        "",
      );

      setCredentialDialogOpen(
        false,
      );
    } catch (
      connectError
    ) {
      setCredentialError(
        connectError instanceof
          Error
          ? connectError.message
          : "Could not connect MCP.",
      );
    } finally {
      setConnecting(
        false,
      );
    }
  }

  /* ==================================================== */
  /* OAUTH                                                */
  /* ==================================================== */

  async function waitForOAuthConnection(
    connectorId:
      OAuthConnectorId,

    popup:
      Window,
  ) {
    const startedAt =
      Date.now();

    const timeout =
      120_000;

    while (
      Date.now() -
        startedAt <
      timeout
    ) {
      if (
        popup.closed
      ) {
        throw new Error(
          "The login window was closed before the connection completed.",
        );
      }

      try {
        const currentStatus =
          await getMCPStatus();

        const server =
          currentStatus.servers.find(
            (
              item,
            ) =>
              item.id ===
              connectorId,
          );

        if (
          server?.status ===
          "connected"
        ) {
          setStatus(
            currentStatus,
          );

          return;
        }

        if (
          server?.status ===
          "error"
        ) {
          throw new Error(
            server.error ||
              `${server.name} MCP could not connect.`,
          );
        }
      } catch (
        pollError
      ) {
        if (
          pollError instanceof
            Error &&
          (
            pollError.message.includes(
              "MCP could not connect",
            ) ||
            pollError.message.includes(
              "timed out",
            ) ||
            pollError.message.includes(
              "Unauthorized",
            ) ||
            pollError.message.includes(
              "Forbidden",
            )
          )
        ) {
          throw pollError;
        }
      }

      await sleep(
        1500,
      );
    }

    throw new Error(
      "The OAuth connection timed out. Please try again.",
    );
  }

  async function handleOAuthConnect(
    connectorId:
      OAuthConnectorId,
  ) {
    if (
      oauthConnectingId
    ) {
      return;
    }

    setOAuthConnectingId(
      connectorId,
    );

    setError(
      null,
    );

    const popup =
      window.open(
        "about:blank",

        `clawbit-mcp-${connectorId}`,

        [
          "popup=yes",
          "width=720",
          "height=780",
          "resizable=yes",
          "scrollbars=yes",
        ].join(
          ",",
        ),
      );

    if (
      !popup
    ) {
      setOAuthConnectingId(
        null,
      );

      setError(
        "Your browser blocked the login window. Allow popups for Clawbit and try again.",
      );

      return;
    }

    try {
      popup.document.title =
        "Connecting to Clawbit";

      popup.document.body.innerHTML = `
        <div
          style="
            min-height:100vh;
            display:flex;
            align-items:center;
            justify-content:center;
            background:#111;
            color:#aaa;
            font-family:Arial,sans-serif;
            font-size:14px;
          "
        >
          Preparing secure login...
        </div>
      `;

      let authorizationUrl =
        "";

      switch (
        connectorId
      ) {
        case "google-drive": {
          const result =
            await connectGoogleDriveMCP();

          authorizationUrl =
            result.authorization_url;

          break;
        }

        case "slack": {
          const result =
            await connectSlackMCP();

          authorizationUrl =
            result.authorization_url;

          break;
        }
      }

      if (
        !authorizationUrl
      ) {
        throw new Error(
          "The backend did not return an OAuth login URL.",
        );
      }

      popup.location.href =
        authorizationUrl;

      await waitForOAuthConnection(
        connectorId,
        popup,
      );

      if (
        !popup.closed
      ) {
        popup.close();
      }

      await reloadMCP();

      setSelectedId(
        connectorId,
      );
    } catch (
      oauthError
    ) {
      if (
        !popup.closed
      ) {
        popup.close();
      }

      setError(
        oauthError instanceof
          Error
          ? oauthError.message
          : "OAuth connection failed.",
      );
    } finally {
      setOAuthConnectingId(
        null,
      );
    }
  }

  /* ==================================================== */
  /* CONNECT                                              */
  /* ==================================================== */

  function handleConnectorConnect(
    connector:
      ConnectorView,
  ) {
    if (
      isTokenConnector(
        connector.id,
      )
    ) {
      openConnectDialog(
        connector.id,
      );

      return;
    }

    if (
      isOAuthConnector(
        connector.id,
      )
    ) {
      void handleOAuthConnect(
        connector.id,
      );
    }
  }

  /* ==================================================== */
  /* DISCONNECT                                           */
  /* ==================================================== */

  async function handleDisconnect(
    connectorId:
      string,
  ) {
    if (
      disconnectingId
    ) {
      return;
    }

    if (
      !isTokenConnector(
        connectorId,
      ) &&
      !isOAuthConnector(
        connectorId,
      )
    ) {
      return;
    }

    setDisconnectingId(
      connectorId,
    );

    setError(
      null,
    );

    try {
      switch (
        connectorId
      ) {
        case "github":
          await disconnectGitHubMCP();

          break;

        case "notion":
          await disconnectNotionMCP();

          break;

        case "stripe":
          await disconnectStripeMCP();

          break;

        case "google-drive":
          await disconnectGoogleDriveMCP();

          break;

        case "slack":
          await disconnectSlackMCP();

          break;
      }

      await reloadMCP();
    } catch (
      disconnectError
    ) {
      setError(
        disconnectError instanceof
          Error
          ? disconnectError.message
          : "Could not disconnect MCP.",
      );
    } finally {
      setDisconnectingId(
        null,
      );
    }
  }

  /* ==================================================== */
  /* SELECTED CONNECTOR                                   */
  /* ==================================================== */

  const SelectedIcon =
    selectedConnector
      ? CONNECTOR_ICONS[
          selectedConnector.id
        ] ??
        PlugZap
      : PlugZap;

  const selectedTools =
    selectedConnector
      ?.server
      ?.tools ??
    [];

  const selectedIsOAuth =
    selectedConnector
      ? isOAuthConnector(
          selectedConnector.id,
        )
      : false;

  const selectedIsConnecting =
    selectedConnector
      ? oauthConnectingId ===
          selectedConnector.id ||
        (
          isTokenConnector(
            selectedConnector.id,
          ) &&
          connecting
        )
      : false;

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <>
      <Dialog.Root
        open={
          open
        }
        onOpenChange={
          onOpenChange
        }
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1300] bg-black/55 backdrop-blur-[3px]" />

          <Dialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-[1301] flex h-[min(700px,88vh)] w-[min(980px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[22px] border outline-none shadow-[0_30px_90px_rgba(0,0,0,0.28)]",

              isDark
                ? "border-white/[0.09] bg-[#101010] text-white"
                : "border-black/[0.10] bg-white text-zinc-950",
            )}
          >
            <Dialog.Title className="sr-only">
              MCP Connectors
            </Dialog.Title>

            <Dialog.Description className="sr-only">
              Connect external apps and services to Clawbit.
            </Dialog.Description>

            {/* ========================================= */}
            {/* CONNECTOR SIDEBAR                         */}
            {/* ========================================= */}

            <aside
              className={cn(
                "flex w-[300px] shrink-0 flex-col border-r",

                isDark
                  ? "border-white/[0.07] bg-[#0b0b0b]"
                  : "border-black/[0.08] bg-[#f7f7f7]",
              )}
            >
              <div className="px-4 pb-3 pt-5">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-[10px] border",

                      isDark
                        ? "border-white/[0.08] bg-[#181818]"
                        : "border-black/[0.08] bg-white",
                    )}
                  >
                    <PlugZap
                      size={
                        16
                      }
                      className="text-zinc-500"
                    />
                  </div>

                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold">
                      MCP
                    </p>

                    <p className="mt-0.5 text-[10px] text-zinc-500">
                      Connectors
                    </p>
                  </div>
                </div>
              </div>

              {/* SEARCH */}

              <div className="px-3">
                <div className="relative">
                  <Search
                    size={
                      13
                    }
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                  />

                  <input
                    value={
                      search
                    }
                    onChange={(
                      event,
                    ) =>
                      setSearch(
                        event.target
                          .value,
                      )
                    }
                    placeholder="Search connectors"
                    spellCheck={
                      false
                    }
                    className={cn(
                      "h-9 w-full rounded-[10px] border pl-9 pr-9 text-[11px] outline-none shadow-none transition-colors",

                      isDark
                        ? "border-white/[0.09] bg-[#151515] text-zinc-200 placeholder:text-zinc-600 focus:border-white/[0.16]"
                        : "border-black/[0.10] bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-black/[0.18]",
                    )}
                  />

                  {search ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSearch(
                          "",
                        )
                      }
                      aria-label="Clear search"
                      className={cn(
                        "absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-zinc-500 transition-colors",

                        isDark
                          ? "hover:bg-white/[0.07] hover:text-white"
                          : "hover:bg-black/[0.055] hover:text-black",
                      )}
                    >
                      <X
                        size={
                          11
                        }
                      />
                    </button>
                  ) : null}
                </div>
              </div>

              {/* CONNECTOR LIST */}

              <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2">
                {loading ? (
                  <div className="flex items-center gap-2 px-3 py-4 text-[10px] text-zinc-500">
                    <RefreshCw
                      size={
                        11
                      }
                      className="animate-spin"
                    />

                    Loading connectors...
                  </div>
                ) : filteredConnectors.length >
                  0 ? (
                  <>
                    <p className="px-3 pb-2 text-[9px] font-medium uppercase tracking-[0.12em] text-zinc-500">
                      Available
                    </p>

                    <div className="space-y-1">
                      {filteredConnectors.map(
                        (
                          connector,
                        ) => {
                          const Icon =
                            CONNECTOR_ICONS[
                              connector.id
                            ] ??
                            PlugZap;

                          const active =
                            connector.id ===
                            selectedConnector?.id;

                          const connectingOAuth =
                            oauthConnectingId ===
                            connector.id;

                          return (
                            <button
                              key={
                                connector.id
                              }
                              type="button"
                              onClick={() =>
                                setSelectedId(
                                  connector.id,
                                )
                              }
                              className={cn(
                                "flex w-full items-center gap-3 rounded-[11px] px-3 py-3 text-left transition-colors",

                                active
                                  ? isDark
                                    ? "bg-white/[0.08]"
                                    : "bg-black/[0.06]"
                                  : isDark
                                    ? "hover:bg-white/[0.05]"
                                    : "hover:bg-black/[0.04]",
                              )}
                            >
                              <div
                                className={cn(
                                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border",

                                  isDark
                                    ? "border-white/[0.07] bg-[#191919]"
                                    : "border-black/[0.07] bg-white",
                                )}
                              >
                                {connectingOAuth ? (
                                  <RefreshCw
                                    size={
                                      14
                                    }
                                    className="animate-spin text-zinc-500"
                                  />
                                ) : (
                                  <Icon
                                    size={
                                      14
                                    }
                                    className="text-zinc-500"
                                  />
                                )}
                              </div>

                              <div className="min-w-0 flex-1">
                                <p
                                  className={cn(
                                    "truncate text-[11px] font-medium",

                                    isDark
                                      ? "text-zinc-200"
                                      : "text-zinc-900",
                                  )}
                                >
                                  {
                                    connector.name
                                  }
                                </p>

                                <div className="mt-1 flex items-center gap-1.5">
                                  {connectingOAuth ? (
                                    <>
                                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />

                                      <span className="text-[9px] text-zinc-500">
                                        Waiting for login
                                      </span>
                                    </>
                                  ) : connector.connected ? (
                                    <>
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />

                                      <span className="text-[9px] text-zinc-500">
                                        Connected
                                      </span>
                                    </>
                                  ) : connector.server?.status ===
                                    "error" ? (
                                    <>
                                      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />

                                      <span className="text-[9px] text-zinc-500">
                                        Connection error
                                      </span>
                                    </>
                                  ) : (
                                    <span className="text-[9px] text-zinc-500">
                                      Ready to connect
                                    </span>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        },
                      )}
                    </div>
                  </>
                ) : (
                  <p className="px-3 py-6 text-center text-[10px] text-zinc-500">
                    No connectors found.
                  </p>
                )}
              </div>

              <div
                className={cn(
                  "border-t px-4 py-3 text-[9px] text-zinc-500",

                  isDark
                    ? "border-white/[0.07]"
                    : "border-black/[0.08]",
                )}
              >
                {connectedCount ===
                0
                  ? "No MCP connectors connected"
                  : `${connectedCount} connector${
                      connectedCount ===
                      1
                        ? ""
                        : "s"
                    } connected`}
              </div>
            </aside>

            {/* ========================================= */}
            {/* DETAILS                                   */}
            {/* ========================================= */}

            <section className="flex min-w-0 flex-1 flex-col">
              <div
                className={cn(
                  "flex h-[68px] shrink-0 items-center justify-between border-b px-5",

                  isDark
                    ? "border-white/[0.07]"
                    : "border-black/[0.08]",
                )}
              >
                <div>
                  <p className="text-[13px] font-medium">
                    Connector details
                  </p>

                  <p className="mt-1 text-[10px] text-zinc-500">
                    Connect real external tools to Clawbit
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      void handleRefresh()
                    }
                    disabled={
                      refreshing
                    }
                    title="Refresh MCP status"
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-[9px] text-zinc-500 transition-colors disabled:opacity-40",

                      isDark
                        ? "hover:bg-white/[0.06] hover:text-white"
                        : "hover:bg-black/[0.05] hover:text-black",
                    )}
                  >
                    <RefreshCw
                      size={
                        14
                      }
                      className={
                        refreshing
                          ? "animate-spin"
                          : ""
                      }
                    />
                  </button>

                  <Dialog.Close
                    asChild
                  >
                    <button
                      type="button"
                      title="Close"
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-[9px] text-zinc-500 transition-colors",

                        isDark
                          ? "hover:bg-white/[0.06] hover:text-white"
                          : "hover:bg-black/[0.05] hover:text-black",
                      )}
                    >
                      <X
                        size={
                          15
                        }
                      />
                    </button>
                  </Dialog.Close>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {error ? (
                  <div
                    className={cn(
                      "mb-5 flex items-start gap-3 rounded-[12px] border px-4 py-3",

                      isDark
                        ? "border-red-500/20 bg-red-500/[0.06]"
                        : "border-red-200 bg-red-50",
                    )}
                  >
                    <AlertCircle
                      size={
                        14
                      }
                      className="mt-0.5 shrink-0 text-red-500"
                    />

                    <p
                      className={cn(
                        "text-[10px] leading-5",

                        isDark
                          ? "text-red-200"
                          : "text-red-700",
                      )}
                    >
                      {
                        error
                      }
                    </p>
                  </div>
                ) : null}

                {selectedConnector ? (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-4">
                        <div
                          className={cn(
                            "flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border",

                            isDark
                              ? "border-white/[0.08] bg-[#181818]"
                              : "border-black/[0.08] bg-[#f7f7f7]",
                          )}
                        >
                          <SelectedIcon
                            size={
                              19
                            }
                            className="text-zinc-500"
                          />
                        </div>

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-[18px] font-semibold tracking-[-0.02em]">
                              {
                                selectedConnector.name
                              }
                            </h2>

                            {selectedConnector.connected ? (
                              <StatusPill tone="success">
                                Connected
                              </StatusPill>
                            ) : selectedConnector.server?.status ===
                              "error" ? (
                              <StatusPill tone="error">
                                Error
                              </StatusPill>
                            ) : (
                              <StatusPill tone="neutral">
                                Available
                              </StatusPill>
                            )}

                            {selectedIsOAuth ? (
                              <StatusPill tone="neutral">
                                OAuth
                              </StatusPill>
                            ) : null}
                          </div>

                          <p className="mt-2 max-w-[520px] text-[11px] leading-5 text-zinc-500">
                            {
                              selectedConnector.description
                            }
                          </p>
                        </div>
                      </div>

                      {selectedConnector.connected ? (
                        <button
                          type="button"
                          onClick={() =>
                            void handleDisconnect(
                              selectedConnector.id,
                            )
                          }
                          disabled={
                            disconnectingId ===
                            selectedConnector.id
                          }
                          className={cn(
                            "flex h-9 shrink-0 items-center gap-2 rounded-[9px] border px-4 text-[11px] transition-colors disabled:opacity-40",

                            isDark
                              ? "border-white/[0.09] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
                              : "border-black/[0.10] text-zinc-700 hover:bg-black/[0.045] hover:text-black",
                          )}
                        >
                          {disconnectingId ===
                          selectedConnector.id ? (
                            <RefreshCw
                              size={
                                13
                              }
                              className="animate-spin"
                            />
                          ) : (
                            <Unplug
                              size={
                                13
                              }
                            />
                          )}

                          {disconnectingId ===
                          selectedConnector.id
                            ? "Disconnecting..."
                            : "Disconnect"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            handleConnectorConnect(
                              selectedConnector,
                            )
                          }
                          disabled={
                            selectedIsConnecting
                          }
                          className={cn(
                            "flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-4 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",

                            isDark
                              ? "bg-white text-black hover:bg-zinc-200"
                              : "bg-zinc-900 text-white hover:bg-black",
                          )}
                        >
                          {selectedIsConnecting ? (
                            <RefreshCw
                              size={
                                13
                              }
                              className="animate-spin"
                            />
                          ) : (
                            <PlugZap
                              size={
                                13
                              }
                            />
                          )}

                          {selectedIsConnecting
                            ? "Connecting..."
                            : "Connect"}
                        </button>
                      )}
                    </div>

                    {/* INFO CARDS */}

                    <div className="mt-7 grid gap-3 sm:grid-cols-3">
                      <InfoCard
                        theme={
                          theme
                        }
                        icon={
                          Terminal
                        }
                        label="Transport"
                        value={
                          selectedConnector
                            .server
                            ?.transport ??
                          (
                            selectedConnector.id ===
                              "notion" ||
                            selectedConnector.id ===
                              "stripe"
                              ? "stdio"
                              : "streamable_http"
                          )
                        }
                      />

                      <InfoCard
                        theme={
                          theme
                        }
                        icon={
                          KeyRound
                        }
                        label="Authentication"
                        value={
                          selectedIsOAuth
                            ? "OAuth 2.0"
                            : "Token"
                        }
                      />

                      <InfoCard
                        theme={
                          theme
                        }
                        icon={
                          Wrench
                        }
                        label="Tools exposed"
                        value={String(
                          selectedTools.length,
                        )}
                      />
                    </div>

                    {/* CONNECTOR ERROR */}

                    {selectedConnector.server?.status ===
                    "error" ? (
                      <div
                        className={cn(
                          "mt-5 flex items-start gap-3 rounded-[12px] border px-4 py-3",

                          isDark
                            ? "border-red-500/20 bg-red-500/[0.05]"
                            : "border-red-200 bg-red-50",
                        )}
                      >
                        <AlertCircle
                          size={
                            14
                          }
                          className="mt-0.5 shrink-0 text-red-500"
                        />

                        <div>
                          <p
                            className={cn(
                              "text-[10px] font-medium",

                              isDark
                                ? "text-red-300"
                                : "text-red-700",
                            )}
                          >
                            MCP connection failed
                          </p>

                          <p className="mt-1 text-[10px] leading-5 text-zinc-500">
                            {selectedConnector
                              .server
                              .error ??
                              "The MCP server could not be reached."}
                          </p>
                        </div>
                      </div>
                    ) : null}

                    {/* TOOLS / CONNECT CTA */}

                    {selectedConnector.connected ? (
                      <div className="mt-8">
                        <h3
                          className={cn(
                            "text-[12px] font-medium",

                            isDark
                              ? "text-zinc-300"
                              : "text-zinc-900",
                          )}
                        >
                          Available tools
                        </h3>

                        <p className="mt-1 text-[10px] text-zinc-500">
                          Clawbit can use these tools when they are relevant to your request.
                        </p>

                        {selectedTools.length >
                        0 ? (
                          <div className="mt-3 space-y-2">
                            {selectedTools.map(
                              (
                                tool,
                              ) => (
                                <div
                                  key={
                                    tool.name
                                  }
                                  className={cn(
                                    "flex items-start gap-3 rounded-[13px] border px-4 py-3.5",

                                    isDark
                                      ? "border-white/[0.07] bg-[#151515]"
                                      : "border-black/[0.08] bg-[#f8f8f8]",
                                  )}
                                >
                                  <div
                                    className={cn(
                                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]",

                                      isDark
                                        ? "bg-[#202020]"
                                        : "bg-white",
                                    )}
                                  >
                                    <Wrench
                                      size={
                                        14
                                      }
                                      className="text-zinc-500"
                                    />
                                  </div>

                                  <div className="min-w-0">
                                    <p
                                      className={cn(
                                        "break-all font-mono text-[11px]",

                                        isDark
                                          ? "text-zinc-300"
                                          : "text-zinc-800",
                                      )}
                                    >
                                      {
                                        tool.name
                                      }
                                    </p>

                                    <p className="mt-1 text-[10px] leading-5 text-zinc-500">
                                      {tool.description ||
                                        "No description provided by the MCP server."}
                                    </p>
                                  </div>
                                </div>
                              ),
                            )}
                          </div>
                        ) : (
                          <div
                            className={cn(
                              "mt-3 rounded-[13px] border px-4 py-6 text-center",

                              isDark
                                ? "border-white/[0.07] bg-[#151515]"
                                : "border-black/[0.08] bg-[#f8f8f8]",
                            )}
                          >
                            <p className="text-[10px] text-zinc-500">
                              This MCP server currently exposes no tools.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        className={cn(
                          "mt-8 rounded-[15px] border p-5",

                          isDark
                            ? "border-white/[0.07] bg-[#0d0d0d]"
                            : "border-black/[0.08] bg-[#fafafa]",
                        )}
                      >
                        <p
                          className={cn(
                            "text-[11px] font-medium",

                            isDark
                              ? "text-zinc-300"
                              : "text-zinc-900",
                          )}
                        >
                          Connect{" "}
                          {
                            selectedConnector.name
                          }
                        </p>

                        <p className="mt-2 max-w-[540px] text-[10px] leading-5 text-zinc-500">
                          {selectedIsOAuth
                            ? `Clawbit will open ${selectedConnector.name} in a secure browser login window. After you approve access, its MCP tools will appear here.`
                            : `Enter your ${selectedConnector.name} credential to connect the MCP server. Clawbit will test the connection before enabling its tools.`}
                        </p>

                        {selectedConnector.configured &&
                        !selectedConnector.connected ? (
                          <div
                            className={cn(
                              "mt-4 flex items-center gap-2 rounded-[10px] border px-3 py-2.5",

                              isDark
                                ? "border-amber-500/15 bg-amber-500/[0.04]"
                                : "border-amber-200 bg-amber-50",
                            )}
                          >
                            <AlertCircle
                              size={
                                12
                              }
                              className="text-amber-500"
                            />

                            <p className="text-[9px] text-zinc-500">
                              Authentication exists, but the MCP server is not currently connected.
                            </p>
                          </div>
                        ) : null}

                        <button
                          type="button"
                          onClick={() =>
                            handleConnectorConnect(
                              selectedConnector,
                            )
                          }
                          disabled={
                            selectedIsConnecting
                          }
                          className={cn(
                            "mt-5 flex h-9 items-center gap-2 rounded-[9px] px-4 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",

                            isDark
                              ? "bg-white text-black hover:bg-zinc-200"
                              : "bg-zinc-900 text-white hover:bg-black",
                          )}
                        >
                          {selectedIsConnecting ? (
                            <RefreshCw
                              size={
                                13
                              }
                              className="animate-spin"
                            />
                          ) : (
                            <PlugZap
                              size={
                                13
                              }
                            />
                          )}

                          {selectedIsConnecting
                            ? "Waiting for login..."
                            : selectedIsOAuth
                              ? `Sign in to ${selectedConnector.name}`
                              : `Connect ${selectedConnector.name}`}
                        </button>
                      </div>
                    )}
                  </>
                ) : loading ? (
                  <div className="flex min-h-[300px] items-center justify-center gap-2 text-[11px] text-zinc-500">
                    <RefreshCw
                      size={
                        14
                      }
                      className="animate-spin"
                    />

                    Loading connector details...
                  </div>
                ) : (
                  <div className="flex min-h-[300px] items-center justify-center text-[11px] text-zinc-500">
                    No connector is available.
                  </div>
                )}
              </div>
            </section>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* =============================================== */}
      {/* TOKEN CREDENTIAL DIALOG                         */}
      {/* =============================================== */}

      <Dialog.Root
        open={
          credentialDialogOpen
        }
        onOpenChange={(
          nextOpen,
        ) => {
          if (
            connecting
          ) {
            return;
          }

          setCredentialDialogOpen(
            nextOpen,
          );

          if (
            !nextOpen
          ) {
            setCredential(
              "",
            );

            setCredentialError(
              null,
            );
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1400] bg-black/60 backdrop-blur-[2px]" />

          <Dialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-[1401] w-[min(460px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border p-5 outline-none shadow-[0_25px_80px_rgba(0,0,0,0.28)]",

              isDark
                ? "border-white/[0.09] bg-[#151515] text-white"
                : "border-black/[0.10] bg-white text-zinc-950",
            )}
          >
            <Dialog.Title className="text-[15px] font-semibold">
              {credentialConnector
                ? getCredentialTitle(
                    credentialConnector,
                  )
                : "Connect MCP"}
            </Dialog.Title>

            <Dialog.Description className="mt-1 text-[10px] leading-5 text-zinc-500">
              Enter the credential used by this connector. It will be sent to your Clawbit backend to establish the MCP connection.
            </Dialog.Description>

            {credentialConnector ? (
              <div className="mt-5">
                <label className="block">
                  <span className="mb-2 block text-[10px] font-medium text-zinc-500">
                    {getCredentialLabel(
                      credentialConnector,
                    )}
                  </span>

                  <input
                    autoFocus
                    type="password"
                    value={
                      credential
                    }
                    onChange={(
                      event,
                    ) =>
                      setCredential(
                        event.target
                          .value,
                      )
                    }
                    onKeyDown={(
                      event,
                    ) => {
                      if (
                        event.key ===
                        "Enter"
                      ) {
                        event.preventDefault();

                        void handleTokenConnect();
                      }
                    }}
                    placeholder={getCredentialPlaceholder(
                      credentialConnector,
                    )}
                    className={cn(
                      "h-10 w-full rounded-[10px] border px-3 font-mono text-[11px] outline-none shadow-none transition-colors",

                      isDark
                        ? "border-white/[0.09] bg-[#0d0d0d] text-zinc-200 placeholder:text-zinc-700 focus:border-white/[0.16]"
                        : "border-black/[0.10] bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-black/[0.18]",
                    )}
                  />
                </label>

                <p className="mt-2 text-[9px] leading-4 text-zinc-500">
                  {getCredentialHelp(
                    credentialConnector,
                  )}
                </p>
              </div>
            ) : null}

            {credentialError ? (
              <div
                className={cn(
                  "mt-4 flex items-start gap-2 rounded-[10px] border px-3 py-2.5",

                  isDark
                    ? "border-red-500/20 bg-red-500/[0.05]"
                    : "border-red-200 bg-red-50",
                )}
              >
                <AlertCircle
                  size={
                    12
                  }
                  className="mt-0.5 shrink-0 text-red-500"
                />

                <p
                  className={cn(
                    "text-[9px] leading-4",

                    isDark
                      ? "text-red-300"
                      : "text-red-700",
                  )}
                >
                  {
                    credentialError
                  }
                </p>
              </div>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={
                  connecting
                }
                onClick={() =>
                  setCredentialDialogOpen(
                    false,
                  )
                }
                className={cn(
                  "h-9 rounded-[9px] border px-4 text-[11px] transition-colors disabled:opacity-40",

                  isDark
                    ? "border-white/[0.09] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
                    : "border-black/[0.10] text-zinc-700 hover:bg-black/[0.045] hover:text-black",
                )}
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={
                  connecting ||
                  !credential.trim()
                }
                onClick={() =>
                  void handleTokenConnect()
                }
                className={cn(
                  "flex h-9 items-center gap-2 rounded-[9px] px-4 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",

                  isDark
                    ? "bg-white text-black hover:bg-zinc-200"
                    : "bg-zinc-900 text-white hover:bg-black",
                )}
              >
                {connecting ? (
                  <RefreshCw
                    size={
                      13
                    }
                    className="animate-spin"
                  />
                ) : (
                  <PlugZap
                    size={
                      13
                    }
                  />
                )}

                {connecting
                  ? "Connecting..."
                  : "Connect"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/* ====================================================== */
/* STATUS PILL                                            */
/* ====================================================== */

function StatusPill({
  children,
  tone,
}: {
  children:
    ReactNode;

  tone:
    | "success"
    | "error"
    | "neutral";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-1 text-[9px]",

        tone ===
        "success"
          ? "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-600 dark:text-emerald-400"
          : tone ===
              "error"
            ? "border-red-500/20 bg-red-500/[0.06] text-red-600 dark:text-red-400"
            : "border-black/[0.09] bg-black/[0.035] text-zinc-500 dark:border-white/[0.08] dark:bg-white/[0.04]",
      )}
    >
      {tone ===
      "success" ? (
        <CheckCircle2
          size={
            10
          }
          className="mr-1"
        />
      ) : null}

      {children}
    </span>
  );
}

/* ====================================================== */
/* INFO CARD                                              */
/* ====================================================== */

function InfoCard({
  theme,
  icon: Icon,
  label,
  value,
}: {
  theme:
    Theme;

  icon:
    LucideIcon;

  label:
    string;

  value:
    string;
}) {
  const isDark =
    theme ===
    "dark";

  return (
    <div
      className={cn(
        "rounded-[14px] border p-4",

        isDark
          ? "border-white/[0.07] bg-[#0d0d0d]"
          : "border-black/[0.08] bg-[#fafafa]",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          size={
            14
          }
          className="text-zinc-500"
        />

        <span className="text-[10px] text-zinc-500">
          {
            label
          }
        </span>
      </div>

      <p
        className={cn(
          "mt-3 break-all font-mono text-[11px]",

          isDark
            ? "text-zinc-300"
            : "text-zinc-800",
        )}
      >
        {
          value
        }
      </p>
    </div>
  );
}