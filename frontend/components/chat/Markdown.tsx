"use client";

import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { Check, Code2, Copy } from "lucide-react";

import "highlight.js/styles/github-dark.css";

import SourceCitation from "./SourceCitation";
import type { SourceReference } from "@/lib/knowledge";

interface Props {
  content: string;
  sources?: SourceReference[];
  isStreaming?: boolean;
}

interface CitationNode {
  type: string;
  value?: string;
  url?: string;
  children?: CitationNode[];
}

function citationReferences() {
  return (tree: CitationNode) => {
    function visit(node: CitationNode) {
      if (
        !node.children ||
        ["link", "code", "inlineCode"].includes(node.type)
      ) {
        return;
      }

      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }

        const parts: CitationNode[] = [];
        let offset = 0;

        for (const match of child.value.matchAll(/\[(S[\w-]+)\]/g)) {
          parts.push({
            type: "text",
            value: child.value.slice(offset, match.index),
          });

          parts.push({
            type: "link",
            url: `#clawbit-source-${match[1]}`,
            children: [{ type: "text", value: match[0] }],
          });

          offset = match.index + match[0].length;
        }

        parts.push({
          type: "text",
          value: child.value.slice(offset),
        });

        return parts;
      });
    }

    visit(tree);
  };
}

function extractCodeText(node: ReactNode): string {
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(extractCodeText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractCodeText(node.props.children);
  }

  return "";
}

function getLanguage(className?: string): string {
  const match = /(?:^|\s)language-([\w+.-]+)/.exec(className ?? "");
  return match?.[1] ?? "text";
}

function getLanguageLabel(language: string): string {
  const labels: Record<string, string> = {
    bash: "Bash",
    c: "C",
    cpp: "C++",
    cs: "C#",
    csharp: "C#",
    css: "CSS",
    dockerfile: "Dockerfile",
    go: "Go",
    html: "HTML",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    json: "JSON",
    jsx: "JSX",
    kotlin: "Kotlin",
    lua: "Lua",
    markdown: "Markdown",
    md: "Markdown",
    php: "PHP",
    powershell: "PowerShell",
    ps1: "PowerShell",
    py: "Python",
    python: "Python",
    rb: "Ruby",
    rust: "Rust",
    rs: "Rust",
    sh: "Shell",
    sql: "SQL",
    swift: "Swift",
    text: "Code",
    txt: "Code",
    ts: "TypeScript",
    tsx: "TypeScript",
    typescript: "TypeScript",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
  };

  return labels[language.toLowerCase()] ?? language;
}

interface CodeBlockProps {
  language: string;
  code: string;
  className?: string;
  highlightedCode: ReactNode;
  isStreaming: boolean;
}

function CodeBlock({
  language,
  code,
  className,
  highlightedCode,
  isStreaming,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const preRef = useRef<HTMLPreElement | null>(null);
  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Track manual scrolling inside this specific code block.
   *
   * Scrolling up pauses following.
   * Returning to the bottom resumes following.
   */
  function handleCodeScroll() {
    const element = preRef.current;
    if (!element) return;

    const distanceFromBottom =
      element.scrollHeight - element.clientHeight - element.scrollTop;

    const movingUp =
      element.scrollTop < lastScrollTopRef.current - 1;

    if (movingUp) {
      followRef.current = false;
    } else if (distanceFromBottom <= 16) {
      followRef.current = true;
    }

    lastScrollTopRef.current = element.scrollTop;
  }

  /**
   * Pause following immediately when the user scrolls upward.
   * The native browser scroll remains enabled.
   */
  function handleCodeWheel(event: ReactWheelEvent<HTMLPreElement>) {
    const element = preRef.current;

    if (
      element &&
      element.scrollHeight > element.clientHeight + 2 &&
      event.deltaY < 0
    ) {
      followRef.current = false;
    }
  }

  /**
   * While streaming, stay at the bottom only if the user
   * has not manually scrolled away.
   *
   * This effect belongs to the code panel, not the outer chat.
   *
   * useEffect is intentional here. The existing Markdown tests invoke
   * CodeBlock directly, and their React test setup supports useEffect.
   */
  useEffect(() => {
    if (!isStreaming || !followRef.current) return;

    const element = preRef.current;
    if (!element) return;

    element.scrollTop = element.scrollHeight;
    lastScrollTopRef.current = element.scrollTop;
  }, [code, isStreaming]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);

      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }

      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="not-prose my-7 w-full min-w-0 overflow-hidden rounded-[18px] bg-[#303030] text-[#eeeeee] shadow-[0_8px_26px_rgba(0,0,0,0.12)] sm:my-8">
      <div className="flex min-h-[49px] items-center justify-between gap-4 px-5 pb-0 pt-3">
        <div className="flex min-w-0 items-center gap-2.5 text-[12px] font-semibold tracking-[0.005em] text-zinc-200">
          <Code2 size={15} strokeWidth={1.8} aria-hidden="true" />

          <span className="truncate">
            {getLanguageLabel(language)}
          </span>

          {isStreaming && (
            <span className="ml-1 flex items-center gap-1.5 text-[10px] font-normal text-violet-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
              Generating
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label={copied ? "Code copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:outline-none"
        >
          {copied ? <Check size={17} /> : <Copy size={17} />}
        </button>
      </div>

      <pre
        ref={preRef}
        data-code-scroll
        tabIndex={0}
        aria-label={`${getLanguageLabel(language)} code block`}
        onScroll={handleCodeScroll}
        onWheel={handleCodeWheel}
        className="m-0 max-w-full overflow-auto overscroll-y-auto overscroll-x-contain px-5 pb-6 pt-3 text-left focus-visible:outline-none"
        style={{
          maxHeight: "min(65vh, 520px)",
          scrollbarGutter: "stable",
          overflowAnchor: "none",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <code
          className={`hljs block min-w-max !bg-transparent !p-0 font-mono text-[13px] leading-[1.75] ${className ?? ""}`}
        >
          {highlightedCode}
        </code>
      </pre>
    </div>
  );
}

export default function Markdown({
  content,
  sources = [],
  isStreaming = false,
}: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, citationReferences]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a({ href, children }) {
          if (href?.startsWith("#clawbit-source-")) {
            const id = href.slice("#clawbit-source-".length);

            return (
              <SourceCitation
                source={sources.find((source) => source.source_id === id)}
              />
            );
          }

          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          );
        },

        p({ children }) {
          return <p className="mb-4 leading-7 last:mb-0">{children}</p>;
        },

        ul({ children }) {
          return <ul className="my-4 list-disc space-y-2 pl-6">{children}</ul>;
        },

        ol({ children }) {
          return <ol className="my-4 list-decimal space-y-2 pl-6">{children}</ol>;
        },

        li({ children }) {
          return <li className="leading-7">{children}</li>;
        },

        h1({ children }) {
          return (
            <h1 className="mb-4 mt-6 text-[1.35em] font-semibold tracking-tight first:mt-0">
              {children}
            </h1>
          );
        },

        h2({ children }) {
          return (
            <h2 className="mb-3 mt-6 text-[1.18em] font-semibold tracking-tight first:mt-0">
              {children}
            </h2>
          );
        },

        h3({ children }) {
          return (
            <h3 className="mb-3 mt-5 text-[1.08em] font-semibold tracking-tight first:mt-0">
              {children}
            </h3>
          );
        },

        pre({ children }) {
          const codeElement = Array.isArray(children)
            ? children.find(isValidElement)
            : children;

          if (
            !isValidElement<{
              className?: string;
              children?: ReactNode;
            }>(codeElement)
          ) {
            return (
              <pre
                data-code-scroll
                tabIndex={0}
                className="my-7 max-h-[min(65vh,520px)] overflow-auto overscroll-y-auto rounded-xl bg-[#303030] p-5 text-zinc-100"
              >
                {children}
              </pre>
            );
          }

          const {
            className,
            children: highlightedCode,
          } = codeElement.props;

          return (
            <CodeBlock
              language={getLanguage(className)}
              className={className}
              code={extractCodeText(highlightedCode)}
              highlightedCode={highlightedCode}
              isStreaming={isStreaming}
            />
          );
        },

        code({ className, children }) {
          if (
            /(?:^|\s)(?:language-[\w+.-]+|hljs)(?:\s|$)/.test(
              className ?? "",
            )
          ) {
            return <code className={className}>{children}</code>;
          }

          return (
            <code className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface-alt)] px-1.5 py-0.5 font-mono text-[0.91em] text-[color:var(--foreground)]">
              {children}
            </code>
          );
        },

        table({ children }) {
          return (
            <div className="my-5 w-full overflow-x-auto rounded-xl border border-[color:var(--border)]">
              <table className="w-full text-left">{children}</table>
            </div>
          );
        },

        th({ children }) {
          return (
            <th className="border-b border-[color:var(--border)] bg-[color:var(--surface-alt)] px-4 py-3 text-[12px] font-semibold">
              {children}
            </th>
          );
        },

        td({ children }) {
          return (
            <td className="border-b border-[color:var(--border)] px-4 py-3 align-top">
              {children}
            </td>
          );
        },

        blockquote({ children }) {
          return (
            <blockquote className="my-5 border-l-[3px] border-zinc-500 bg-[color:var(--surface-alt)] px-4 py-3 text-[color:var(--muted-foreground)]">
              {children}
            </blockquote>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}