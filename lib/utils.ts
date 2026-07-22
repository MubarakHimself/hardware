import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatTimestampUrl(videoId: string, seconds: number) {
  return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
}

function srgbChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Pick readable avatar text for catalog-provided hex accent colours. */
export function contrastTextColor(background: string): "#ffffff" | "#0a0d0b" {
  const match = background.trim().match(/^#([\da-f]{6})$/i);
  if (!match) return "#ffffff";
  const value = Number.parseInt(match[1], 16);
  const luminance =
    0.2126 * srgbChannel((value >> 16) & 0xff) +
    0.7152 * srgbChannel((value >> 8) & 0xff) +
    0.0722 * srgbChannel(value & 0xff);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkLuminance =
    0.2126 * srgbChannel(10) +
    0.7152 * srgbChannel(13) +
    0.0722 * srgbChannel(11);
  const darkContrast = (luminance + 0.05) / (darkLuminance + 0.05);
  return whiteContrast >= darkContrast ? "#ffffff" : "#0a0d0b";
}
