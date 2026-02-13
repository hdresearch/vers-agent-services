/**
 * Dynamic OG image generation for shared reports.
 * Produces a 1200x630 SVG card with report title, author, and branding.
 * Zero external dependencies — pure SVG string generation.
 */

const WIDTH = 1200;
const HEIGHT = 630;
const BG = "#111111";
const ACCENT = "#00ffc8";
const TITLE_COLOR = "#ffffff";
const BRAND_COLOR = "#555555";
const PADDING_X = 80;
const TITLE_Y_START = 200;
const TITLE_LINE_HEIGHT = 52;
const MAX_CHARS_PER_LINE = 40;
const MAX_LINES = 3;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Word-wrap text to fit within maxChars per line, up to maxLines.
 * Truncates with ellipsis if content overflows.
 */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (lines.length >= maxLines) break;

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = word;
      } else {
        // Single word longer than maxChars
        lines.push(word.slice(0, maxChars - 1) + "…");
        current = "";
      }
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  } else if (current && lines.length === maxLines) {
    // Overflow — add ellipsis to last line
    const last = lines[maxLines - 1];
    if (last && last.length > maxChars - 1) {
      lines[maxLines - 1] = last.slice(0, maxChars - 1) + "…";
    } else {
      lines[maxLines - 1] = last + "…";
    }
  }

  if (lines.length === 0 && text.length > 0) {
    lines.push(text.slice(0, maxChars - 1) + "…");
  }

  return lines;
}

export function generateOgImage(title: string, author: string): string {
  const titleLines = wrapText(title, MAX_CHARS_PER_LINE, MAX_LINES);

  const titleElements = titleLines
    .map((line, i) => {
      const y = TITLE_Y_START + i * TITLE_LINE_HEIGHT;
      return `<text x="${PADDING_X}" y="${y}" font-family="'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace" font-size="40" font-weight="bold" fill="${TITLE_COLOR}">${escapeXml(line)}</text>`;
    })
    .join("\n    ");

  const authorY = TITLE_Y_START + titleLines.length * TITLE_LINE_HEIGHT + 40;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>

  <!-- Accent line at top -->
  <rect x="0" y="0" width="${WIDTH}" height="4" fill="${ACCENT}"/>

  <!-- Subtle accent glow -->
  <rect x="${PADDING_X}" y="${TITLE_Y_START - 80}" width="60" height="3" fill="${ACCENT}" opacity="0.6" rx="1"/>

  <!-- Title -->
  ${titleElements}

  <!-- Author -->
  <text x="${PADDING_X}" y="${authorY}" font-family="'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace" font-size="22" fill="${ACCENT}">@${escapeXml(author)}</text>

  <!-- Branding -->
  <text x="${WIDTH - PADDING_X}" y="${HEIGHT - 40}" font-family="'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace" font-size="16" fill="${BRAND_COLOR}" text-anchor="end">Vers Fleet Reports</text>

  <!-- Bottom accent line -->
  <rect x="0" y="${HEIGHT - 4}" width="${WIDTH}" height="4" fill="${ACCENT}" opacity="0.3"/>
</svg>`;
}
