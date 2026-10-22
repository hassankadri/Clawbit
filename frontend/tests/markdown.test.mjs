import assert from "node:assert/strict";
import { test, mock } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownModule from "../components/chat/Markdown.tsx";

const Markdown = MarkdownModule.default;

const python = [
  "@app.get(\"/hello\")",
  "def hello(name: str = \"world\") -> str:",
  '    """Return a greeting with <tags> & punctuation."""',
  '    return f"Hello, {name}!"',
  "",
].join("\n");

function fence(language, source) {
  return `\`\`\`${language}\n${source}\`\`\``;
}

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...elements(node.props.children, predicate),
  ];
}

// Execute the installed react-markdown -> rehype-highlight -> React pipeline.
function blocks(content) {
  const markdown = Markdown({ content });
  const tree = markdown.type(markdown.props);
  return elements(tree, (element) => element.type === markdown.props.components.pre)
    .map((pre) => pre.type(pre.props));
}

function render(content) {
  return renderToStaticMarkup(React.createElement(Markdown, { content }));
}

// Read rendered <pre><code> text without collapsing whitespace or decoding twice.
function codeTexts(html) {
  return [...html.matchAll(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, "").replace(
      /&(amp|lt|gt|quot|#x27|#39);/g,
      (entity) => ({
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
        "&#x27;": "'", "&#39;": "'",
      })[entity],
    ));
}

async function copyBlock(block) {
  // Only the hook dispatcher and browser APIs are stubbed for direct event
  // invocation. Parsing, highlighting, source extraction and copy() are real.
  const state = mock.method(React, "useState", (initial) => [initial, () => {}]);
  const writeText = mock.fn(async () => {});
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true, value: { clipboard: { writeText } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true, value: { setTimeout: mock.fn() },
    });
    const tree = block.type(block.props);
    const [button] = elements(tree, (element) => element.type === "button");
    assert.ok(button.props["aria-label"].startsWith("Copy "));
    await button.props.onClick();
    assert.equal(writeText.mock.callCount(), 1);
    return writeText.mock.calls[0].arguments[0];
  } finally {
    state.mock.restore();
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
  }
}

test("Python decorators, annotations, docstrings and string returns render and copy exactly", async () => {
  const content = fence("python", python);
  const [block] = blocks(content);
  assert.equal(block.props.code, python);
  assert.deepEqual(codeTexts(render(content)), [python]);
  assert.equal(await copyBlock(block), python);
  assert.match(render(content), /hljs-meta/);
  assert.match(render(content), /hljs-string/);
});

test("nested highlighting spans preserve source rather than coercing React objects", async () => {
  const source = 'def greet(name: str = "a,b") -> str:\n    return f"Hi {name.upper()}!"\n';
  const content = fence("python", source);
  const [block] = blocks(content);
  const spans = elements(block.props.highlightedCode, (element) => element.type === "span");
  assert.ok(spans.some((span) => elements(span.props.children, (el) => el.type === "span").length));
  // This demonstrates the original failure at the actual conversion boundary.
  assert.match(String(block.props.highlightedCode), /\[object Object\]/);
  assert.equal(block.props.code, source);
  assert.deepEqual(codeTexts(render(content)), [source]);
  assert.equal(await copyBlock(block), source);
});

test("nested JSON objects and punctuation render and copy exactly", async () => {
  const source = '{\n  "outer": {"items": [1, {"text": "<&>\\n"}], "ok": true}\n}\n';
  const content = fence("json", source);
  assert.deepEqual(codeTexts(render(content)), [source]);
  assert.equal(await copyBlock(blocks(content)[0]), source);
  assert.match(render(content), /hljs-attr/);
});

for (const language of ["javascript", "typescript", "bash", "plaintext", ""]) {
  test(`${language || "unlabelled"} blocks preserve indentation, special characters and trailing whitespace`, async () => {
    const source = {
      javascript: 'const greet = (name) => `Hello, ${name} <&>`;  \n\tgreet("world");\n\n',
      typescript: 'const greet = (name: string): string => `Hello, ${name} <&>`;  \n\tgreet("world");\n\n',
      bash: 'printf \'%s\\n\' "$HOME" "<&>"  \n\t# $ ` \\ & | ;\n\n',
      plaintext: '  literal [object Object], <tag> & "quotes" `ticks`  \n\t雪 😀 &lt;\n\n',
      "": '  first line  \n\t<&> "quotes", `ticks` \\ $ { }\n\n',
    }[language];
    const content = fence(language, source);
    const [block] = blocks(content);
    assert.equal(block.props.language, language || "text");
    assert.equal(block.props.code, source);
    assert.deepEqual(codeTexts(render(content)), [source]);
    assert.equal(await copyBlock(block), source);
    if (["javascript", "typescript", "bash"].includes(language)) {
      assert.match(render(content), /<span class="hljs-/);
    }
  });
}

test("inline code, headings, lists, tables, links and quotes remain ordinary Markdown", () => {
  const content = '# Heading\n\nUse `x < y && z` inline.\n\n- one\n- two\n\n1. first\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n> quote\n\n**bold** and [link](https://example.com)';
  const html = render(content);
  assert.equal(blocks(content).length, 0);
  assert.match(html, /<code class="rounded-\[6px\][^"]*">x &lt; y &amp;&amp; z<\/code>/);
  for (const tag of ["h1", "ul", "ol", "li", "table", "th", "td", "blockquote", "strong", "a"]) {
    assert.match(html, new RegExp(`<${tag}(?:\\s|>)`));
  }
  assert.doesNotMatch(html, /aria-label="Copy/);
});

test("multiple code blocks in one assistant response each copy their own source", async () => {
  const sources = [python, '{"nested": {"value": 2}}\n', '  plain & text\n'];
  const content = [fence("python", sources[0]), "Text with `inline` code.", fence("json", sources[1]), fence("", sources[2])].join("\n\n");
  const renderedBlocks = blocks(content);
  assert.equal(renderedBlocks.length, 3);
  assert.deepEqual(codeTexts(render(content)), sources);
  for (const [index, block] of renderedBlocks.entries()) {
    assert.equal(await copyBlock(block), sources[index]);
  }
});

test("empty fences, unknown languages and partially streamed fences remain readable", async () => {
  for (const [content, expected] of [
    ['```\n```', ""],
    [fence("custom-language", "  <unknown> & value\n"), "  <unknown> & value\n"],
    ['```python\ndef partial():\n    return "hello"', 'def partial():\n    return "hello"\n'],
    ['    indented_code()\n', 'indented_code()\n'],
  ]) {
    assert.deepEqual(codeTexts(render(content)), [expected]);
    assert.equal(await copyBlock(blocks(content)[0]), expected);
  }
});
