# Markdown regression tests

Run `npm test` from `frontend` with Node 22.15+ (verified on Node 24.13).
There was no frontend test framework. The suite uses Node's built-in test
runner and the already installed TypeScript compiler, adding no dependencies.
The small loader transpiles TSX in memory and ignores CSS imports; the Next.js
production build checks stylesheet integration.

Tests execute the installed react-markdown, rehype-highlight and highlight.js
pipeline and render the actual component with React DOM's server renderer.
Copy tests invoke the actual button handler with clipboard/window stubs and
a stubbed state hook; these tests do not claim to mount a browser DOM.

## Investigation

Installed versions: react-markdown 10.1.0, rehype-highlight 7.0.2,
highlight.js 11.11.1, lowlight 3.3.0, React/React DOM 19.2.4.
The pipeline is Markdown string -> remark/rehype code text -> highlighted
HAST spans -> React span children -> custom `pre` -> `CodeBlock`.
Converting those React children with `String(children)` introduces object
strings and commas before both rendering and copying.

The pre-existing recursive extraction in `Markdown.tsx` works when freshly
loaded. Before rebuilding, `.next/static/chunks/29g523r1njjq1.js` still contained
`code:String(n).replace(/\n$/,"")`, and old dev
chunks contained `String(children)`. Editing source alone does not update an
existing production build. Rebuild and restart the frontend, then reload
already open tabs. The remaining source defect was removing the last newline
from copied text while displaying it; the fix retains all parsed code text.

Coverage includes all requested languages, nested spans/JSON, real copy handler
arguments, multiple blocks, inline/other Markdown, indentation, tabs, trailing
blank lines/spaces, punctuation, Unicode, literal `[object Object]`, unknown
languages, indented blocks, empty fences and partially streamed fences.

The rebuilt production app was also checked in the in-app browser using a
temporary local SSE response fixture, with no live backend or model calls.
Python, JSON, plaintext and unlabelled blocks rendered correctly and their
actual clipboard contents matched the rendered source, including whitespace.
Whole-message copying retained the original Markdown. Dark/light theme checks
used the existing theme controls and restored the initial theme afterward.
