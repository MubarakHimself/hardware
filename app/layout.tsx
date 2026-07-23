import type { Metadata } from "next";
import {
  ThemeProvider,
  themeBootstrapScript,
} from "@/components/hardware/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000",
  ),
  title: {
    default: "Hardware — Personal project intelligence",
    template: "%s · Hardware",
  },
  description:
    "A local, source-grounded library of open-source projects discovered across YouTube videos.",
  applicationName: "Hardware",
  robots: {
    index: false,
    follow: false,
  },
  openGraph: {
    type: "website",
    siteName: "Hardware",
    title: "Hardware — Personal project intelligence",
    description:
      "A local, source-grounded library of open-source projects discovered across YouTube videos.",
    images: [
      {
        url: "/og-local.jpg",
        width: 1200,
        height: 675,
        alt: "Hardware personal open-source project library",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Hardware — Personal project intelligence",
    description:
      "A local, source-grounded library of open-source projects discovered across YouTube videos.",
    images: ["/og-local.jpg"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
