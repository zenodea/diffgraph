// Just enough ANSI for the terminal view: colours, cursor control, and measuring
// strings that contain escape codes.

export const ESC = "\x1b[";
export const reset = `${ESC}0m`;

export const fg = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;
export const bg = (r: number, g: number, b: number) => `${ESC}48;2;${r};${g};${b}m`;
export const bold = `${ESC}1m`;
export const dim = `${ESC}2m`;
export const italic = `${ESC}3m`;
export const inverse = `${ESC}7m`;
export const strike = `${ESC}9m`;

/** The browser view's dark palette, so the two feel like one tool. */
export const c = {
  text: fg(236, 235, 230),
  muted: fg(154, 154, 147),
  faint: fg(99, 99, 94),
  edge: fg(85, 85, 79),
  accent: fg(129, 151, 255),
  add: fg(87, 192, 108),
  mod: fg(106, 161, 242),
  del: fg(240, 114, 107),
  ren: fg(179, 148, 245),
  warn: fg(240, 167, 90),
  done: fg(87, 192, 108),
  selBg: bg(37, 44, 74),
  addBg: bg(21, 41, 26),
  delBg: bg(51, 24, 23),
  barBg: bg(27, 27, 26),
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const strip = (s: string) => s.replace(ANSI, "");
export const width = (s: string) => [...strip(s)].length;

/** Cuts a styled string to `max` visible columns, ending in "…" when it had to cut. */
export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = "";
  let seen = 0;
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (seen >= max - 1) return out + "…" + reset;
      out += ch;
      seen++;
    }
  }
  return out;
}

export const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

export const screen = {
  enter: `${ESC}?1049h${ESC}?25l`,
  leave: `${ESC}?25h${ESC}?1049l`,
  home: `${ESC}H`,
  clearLine: `${ESC}K`,
  clearBelow: `${ESC}J`,
};
