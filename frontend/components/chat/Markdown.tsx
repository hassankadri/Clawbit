"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import "highlight.js/styles/github-dark.css";

import { Copy, Check } from "lucide-react";

interface Props {
  content: string;
}

export default function Markdown({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        p({ children }) {
          return <p className="mb-3 last:mb-0 leading-7">{children}</p>;
        },

        ul({ children }) {
          return <ul className="my-3 list-disc space-y-2 pl-5">{children}</ul>;
        },

        ol({ children }) {
          return <ol className="my-3 list-decimal space-y-2 pl-5">{children}</ol>;
        },

        li({ children }) {
          return <li className="leading-7">{children}</li>;
        },

        h1({ children }) {
          return <h1 className="mb-3 text-[1.35em] font-semibold tracking-tight">{children}</h1>;
        },

        h2({ children }) {
          return <h2 className="mb-3 text-[1.18em] font-semibold tracking-tight">{children}</h2>;
        },

        h3({ children }) {
          return <h3 className="mb-2 text-[1.08em] font-semibold tracking-tight">{children}</h3>;
        },

        code(props) {
          const { className, children } = props;

          const match = /language-(\w+)/.exec(className || "");

          if (!match) {
            return (
              <code className="rounded-[6px] border border-[color:var(--border)] bg-[color:var(--card)] px-1.5 py-0.5 text-[0.92em] text-violet-500">
                {children}
              </code>
            );
          }

          return (
            <CodeBlock
              language={match[1]}
              code={String(children).replace(/\n$/, "")}
              className={className}
            />
          );
        },

        table({ children }) {
          return (
            <div className="my-4 overflow-x-auto rounded-[16px] border border-[color:var(--border)] shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
              <table className="w-full">{children}</table>
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

function CodeBlock({
  language,
  code,
  className,
}: {
  language: string;
  code: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);

    setCopied(true);

    setTimeout(() => setCopied(false), 1500);
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
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}
