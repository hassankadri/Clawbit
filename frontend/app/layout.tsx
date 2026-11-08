
import type { Metadata, Viewport } from "next";

import ThemeProvider from "@/components/providers/ThemeProvider";
import AppShell from "@/components/layout/AppShell";
import AuthProvider from "@/components/auth/AuthProvider";
import MCPApprovalDialog from "@/components/mcp/MCPApprovalDialog";

import "./globals.css";
import "./history-toolbar.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Clawbit AI",
  description: "Your intelligent AI workspace",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning className="bg-background text-foreground antialiased">
        <ThemeProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
            <MCPApprovalDialog />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
