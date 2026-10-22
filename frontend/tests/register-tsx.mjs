// Run the real TSX component with Node's test runner and the installed compiler.
// CSS is checked by the production build; Node cannot import stylesheets.
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const path = new URL(`../${specifier.slice(2)}`, import.meta.url);
      for (const suffix of [".ts", ".tsx", ""]) {
        const candidate = new URL(path.href + suffix);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "commonjs", source: "", shortCircuit: true };
    }

    if (url.endsWith(".tsx") || url.endsWith(".ts")) {
      const { outputText } = ts.transpileModule(
        readFileSync(new URL(url), "utf8"),
        {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
            target: ts.ScriptTarget.ES2017,
          },
        },
      );
      // Native CJS requires need explicit paths for local TypeScript modules.
      const source = outputText.replace(/require\(["']((?:@\/|\.\.?\/)[^"']+)["']\)/g, (_, specifier) => {
        const base = specifier.startsWith("@/")
          ? new URL(`../${specifier.slice(2)}`, import.meta.url)
          : new URL(specifier, url);
        for (const suffix of [".ts", ".tsx"]) {
          const candidate = new URL(base.href + suffix);
          if (existsSync(candidate)) return `require(${JSON.stringify(fileURLToPath(candidate))})`;
        }
        return `require(${JSON.stringify(specifier)})`;
      });
      return { format: "commonjs", source, shortCircuit: true };
    }

    return nextLoad(url, context);
  },
});
