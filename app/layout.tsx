import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Canvas for All — Make a mark together",
  description: "A shared 100 × 100 canvas for live social experiments.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
