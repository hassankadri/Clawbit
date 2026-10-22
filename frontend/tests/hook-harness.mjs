import React from "react";

export function hookHarness(renderHook) {
  const originals = Object.fromEntries(["useState", "useRef", "useEffect"].map((key) => [key, React[key]]));
  const cells = [];
  let cursor = 0;
  let updates = 0;
  let pendingEffects = [];
  React.useState = (initial) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
    return [cells[index], (next) => {
      updates++;
      cells[index] = typeof next === "function" ? next(cells[index]) : next;
    }];
  };
  React.useRef = (initial) => {
    const index = cursor++;
    return cells[index] ??= { current: initial };
  };
  React.useEffect = (effect, dependencies) => {
    const index = cursor++;
    const previous = cells[index];
    if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
      pendingEffects.push(() => {
        previous?.cleanup?.();
        cells[index] = { dependencies, cleanup: effect() };
      });
    }
  };
  return {
    render() {
      cursor = 0;
      const value = renderHook();
      for (const effect of pendingEffects) effect();
      pendingEffects = [];
      return value;
    },
    get updates() { return updates; },
    close() {
      for (const cell of cells) cell?.cleanup?.();
      Object.assign(React, originals);
    },
  };
}
