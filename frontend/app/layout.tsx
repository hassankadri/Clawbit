import type { Metadata } from "next";

import ThemeProvider from "@/components/providers/ThemeProvider";
import AppShell from "@/components/layout/AppShell";
import AuthProvider from "@/components/auth/AuthProvider";

import "./globals.css";
import "./history-toolbar.css";

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
      <body className="bg-background text-foreground antialiased">
        <ThemeProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}