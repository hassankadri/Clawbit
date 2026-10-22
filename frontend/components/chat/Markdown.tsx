
"use client";

import {
  isValidElement,
  useState,
  type ReactNode,
} from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import "highlight.js/styles/github-dark.css";

import { Copy, Check } from "lucide-react";
import SourceCitation from "./SourceCitation";
import type { SourceReference } from "@/lib/knowledge";

interface Props {
  content: string;
  sources?: SourceReference[];
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
      if (!node.children || ["link", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const parts: CitationNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/\[(S[\w-]+)\]/g)) {
          parts.push({ type: "text", value: child.value.slice(offset, match.index) });
          parts.push({
            type: "link",
            url: `#clawbit-source-${match[1]}`,
            children: [{ type: "text", value: match[0] }],
          });
          offset = match.index + match[0].length;
        }
        parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    }
    visit(tree);
  };
}

/**
 * Extract original text from syntax-highlighted React nodes.
 *
 * rehype-highlight creates nested <span> elements.
 * String(children) would turn those elements into
 * "[object Object]" and corrupt copied code.
 */
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

export default function Markdown({ content, sources = [] }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, citationReferences]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a({ href, children }) {
          if (href?.startsWith("#clawbit-source-")) {
            const id = href.slice("#clawbit-source-".length);
            return <SourceCitation source={sources.find((source) => source.source_id === id)} />;
          }
          return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
        p({ children }) {
          return (
            <p className="mb-3 last:mb-0 leading-7">
              {children}
            </p>
          );
        },

        ul({ children }) {
          return (
            <ul className="my-3 list-disc space-y-2 pl-5">
              {children}
            </ul>
          );
        },

        ol({ children }) {
          return (
            <ol className="my-3 list-decimal space-y-2 pl-5">
              {children}
            </ol>
          );
        },

        li({ children }) {
          return <li className="leading-7">{children}</li>;
        },

        h1({ children }) {
          return (
            <h1 className="mb-3 text-[1.35em] font-semibold tracking-tight">
              {children}
            </h1>
          );
        },

        h2({ children }) {
          return (
            <h2 className="mb-3 text-[1.18em] font-semibold tracking-tight">
              {children}
            </h2>
          );
        },

        h3({ children }) {
          return (
            <h3 className="mb-2 text-[1.08em] font-semibold tracking-tight">
              {children}
            </h3>
          );
        },

        /**
         * Handle fenced code blocks at the <pre> level.
         * This avoids rendering a custom <div> inside
         * an existing <pre> element.
         */
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
              <pre className="overflow-x-auto p-4">
                {children}
              </pre>
            );
          }

          const {
            className,
            children: highlightedCode,
          } = codeElement.props;

          const languageMatch =
            /(?:^|\s)language-([\w+.-]+)/.exec(
              className ?? "",
            );

          const language =
            languageMatch?.[1] ?? "text";

          const code = extractCodeText(
            highlightedCode,
          );

          return (
            <CodeBlock
              language={language}
              code={code}
              className={className}
              highlightedCode={highlightedCode}
            />
          );
        },

        /**
         * Inline code remains separate from fenced blocks.
         */
        code({ children }) {
          return (
            <code className="rounded-[6px] border border-[color:var(--border)] bg-[color:var(--card)] px-1.5 py-0.5 text-[0.92em] text-violet-500">
              {children}
            </code>
          );
        },

        table({ children }) {
          return (
            <div className="my-4 overflow-x-auto rounded-[16px] border border-[color:var(--border)] shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
              <table className="w-full">
                {children}
              </table>
            </div>
          );
        },

        th({ children }) {
          return (
            <th className="border-b border-[color:var(--border)] bg-[color:var(--card)] px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-[0.08em] text-[color:var(--muted-foreground)]">
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
            <blockquote className="my-4 rounded-[14px] border-l-4 border-violet-500 bg-[color:var(--accent-hover)] px-4 py-3 italic text-[color:var(--muted-foreground)]">
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

interface CodeBlockProps {
  language: string;
  code: string;
  className?: string;
  highlightedCode: ReactNode;
}

function CodeBlock({
  language,
  code,
  className,
  highlightedCode,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      // Always copy the original code, never React nodes.
      await navigator.clipboard.writeText(code);

      setCopied(true);

      window.setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch (error) {
      console.error("Failed to copy code:", error);
    }
  }

  return (
    <div className="my-5 overflow-hidden rounded-[16px] border border-[color:var(--border)] bg-[color:var(--surface)] shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border)] bg-[color:var(--card)] px-4 py-2.5">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted-foreground)]">
          {language}
        </span>

        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${language} code`}
          className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
        >
          {copied ? (
            <>
              <Check size={14} />
              Copied
            </>
          ) : (
            <>
              <Copy size={14} />
              Copy
            </>
          )}
        </button>
      </div>

      <pre className="overflow-x-auto bg-[color:var(--surface)] p-4">
        <code className={className}>
          {highlightedCode}
        </code>
      </pre>
    </div>
  );
}
