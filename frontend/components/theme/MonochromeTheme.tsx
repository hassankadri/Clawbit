"use client";

/*
 * Legacy compatibility component.
 *
 * Clawbit now handles Light/Dark styling through:
 * - globals.css theme tokens
 * - explicit component theme styles
 *
 * Do not inject global class overrides here.
 *
 * This component temporarily remains because some
 * existing components may still import it.
 */
export default function MonochromeTheme() {
  return null;
}