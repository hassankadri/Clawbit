
"use client";

import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import {
  Check,
  Code2,
  Copy,
} from "lucide-react";

import "highlight.js/styles/github-dark.css";

import SourceCitation from "./SourceCitation";
import type { SourceReference } from "@/lib/knowledge";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

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

/* ====================================================== */
/* SOURCE CITATIONS                                       */
/* ====================================================== */

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

        for (const match of child.value.matchAll(
          /\[(S[\w-]+)\]/g,
        )) {
          parts.push({
            type: "text",
            value: child.value.slice(
              offset,
              match.index,
            ),
          });

          parts.push({
            type: "link",
            url: `#clawbit-source-${match[1]}`,
            children: [
              {
                type: "text",
                value: match[0],
              },
            ],
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

/* ====================================================== */
/* CODE TEXT EXTRACTION                                   */
/* ====================================================== */

/*
 * Highlight.js wraps syntax in nested spans.
 *
 * Extract actual source text so the Copy button
 * never copies HTML or "[object Object]".
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

  if (
    isValidElement<{
      children?: ReactNode;
    }>(node)
  ) {
    return extractCodeText(node.props.children);
  }

  return "";
}

/* ====================================================== */
/* LANGUAGE LABELS                                        */
/* ====================================================== */

function getLanguage(className?: string): string {
  const match =
    /(?:^|\s)language-([\w+.-]+)/.exec(
      className ?? "",
    );

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

  return (
    labels[language.toLowerCase()] ??
    language
  );
}

/* ====================================================== */
/* CODE BLOCK                                            */
/* ====================================================== */

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

  const timeoutRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);

      setCopied(true);

      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      className="
        not-prose
        my-7
        w-full
        min-w-0
        overflow-hidden
        rounded-[18px]
        bg-[#303030]
        text-[#eeeeee]
        shadow-[0_8px_26px_rgba(0,0,0,0.12)]
        sm:my-8
      "
    >
      {/* HEADER */}

      <div
        className="
          flex
          min-h-[49px]
          items-center
          justify-between
          gap-4
          px-5
          pb-0
          pt-3
        "
      >
        {/* LANGUAGE */}

        <div
          className="
            flex
            min-w-0
            items-center
            gap-2.5
            text-[12px]
            font-semibold
            tracking-[0.005em]
            text-zinc-200
          "
        >
          <Code2
            size={15}
            strokeWidth={1.8}
            aria-hidden="true"
          />

          <span className="truncate">
            {getLanguageLabel(language)}
          </span>
        </div>

        {/* COPY BUTTON */}

        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label={
            copied ? "Code copied" : "Copy code"
          }
          title={
            copied ? "Copied" : "Copy code"
          }
          className="
            flex
            h-8
            w-8
            shrink-0
            items-center
            justify-center
            rounded-lg
            text-zinc-300
            transition-colors
            hover:bg-white/10
            hover:text-white
            focus-visible:bg-white/10
            focus-visible:outline-none
          "
        >
          {copied ? (
            <Check size={17} />
          ) : (
            <Copy size={17} />
          )}
        </button>
      </div>

      {/* CODE CONTENT */}

      <pre
        className="
          m-0
          max-w-full
          overflow-x-auto
          px-5
          pb-6
          pt-3
          text-left
        "
      >
        <code
          className={`
            hljs
            block
            min-w-max
            !bg-transparent
            !p-0
            font-mono
            text-[13px]
            leading-[1.75]
            ${className ?? ""}
          `}
        >
          {highlightedCode}
        </code>
      </pre>
    </div>
  );
}

/* ====================================================== */
/* MARKDOWN RENDERER                                      */
/* ====================================================== */

export default function Markdown({
  content,
  sources = [],
}: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        citationReferences,
      ]}
      rehypePlugins={[
        rehypeHighlight,
      ]}
      components={{
        /* ---------------------------------------------- */
        /* LINKS AND CITATIONS                            */
        /* ---------------------------------------------- */

        a({ href, children }) {
          if (
            href?.startsWith(
              "#clawbit-source-",
            )
          ) {
            const id = href.slice(
              "#clawbit-source-".length,
            );

            return (
              <SourceCitation
                source={sources.find(
                  (source) =>
                    source.source_id === id,
                )}
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

        /* ---------------------------------------------- */
        /* PARAGRAPHS                                      */
        /* ---------------------------------------------- */

        p({ children }) {
          return (
            <p className="mb-4 leading-7 last:mb-0">
              {children}
            </p>
          );
        },

        /* ---------------------------------------------- */
        /* LISTS                                           */
        /* ---------------------------------------------- */

        ul({ children }) {
          return (
            <ul className="my-4 list-disc space-y-2 pl-6">
              {children}
            </ul>
          );
        },

        ol({ children }) {
          return (
            <ol className="my-4 list-decimal space-y-2 pl-6">
              {children}
            </ol>
          );
        },

        li({ children }) {
          return (
            <li className="leading-7">
              {children}
            </li>
          );
        },

        /* ---------------------------------------------- */
        /* HEADINGS                                        */
        /* ---------------------------------------------- */

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

        /* ---------------------------------------------- */
        /* FENCED CODE BLOCKS                             */
        /* ---------------------------------------------- */

        pre({ children }) {
          const codeElement = Array.isArray(
            children,
          )
            ? children.find(isValidElement)
            : children;

          if (
            !isValidElement<{
              className?: string;
              children?: ReactNode;
            }>(codeElement)
          ) {
            return (
              <pre className="my-7 overflow-x-auto rounded-xl bg-[#303030] p-5 text-zinc-100">
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
              code={extractCodeText(
                highlightedCode,
              )}
              highlightedCode={
                highlightedCode
              }
            />
          );
        },

        /* ---------------------------------------------- */
        /* INLINE CODE                                    */
        /* ---------------------------------------------- */

        code({ className, children }) {
          /*
           * Keep Highlight.js token classes for
           * fenced blocks. Their parent <pre>
           * renders the custom CodeBlock component.
           */

          if (
            /(?:^|\s)(?:language-[\w+.-]+|hljs)(?:\s|$)/.test(
              className ?? "",
            )
          ) {
            return (
              <code className={className}>
                {children}
              </code>
            );
          }

          return (
            <code
              className="
                rounded-md
                border
                border-[color:var(--border)]
                bg-[color:var(--surface-alt)]
                px-1.5
                py-0.5
                font-mono
                text-[0.91em]
                text-[color:var(--foreground)]
              "
            >
              {children}
            </code>
          );
        },

        /* ---------------------------------------------- */
        /* TABLES                                         */
        /* ---------------------------------------------- */

        table({ children }) {
          return (
            <div className="my-5 w-full overflow-x-auto rounded-xl border border-[color:var(--border)]">
              <table className="w-full text-left">
                {children}
              </table>
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

        /* ---------------------------------------------- */
        /* BLOCKQUOTES                                    */
        /* ---------------------------------------------- */

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
