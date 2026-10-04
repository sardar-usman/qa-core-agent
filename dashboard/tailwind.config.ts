import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Design tokens (PR F, part 1). Values live as CSS variables in
// src/index.css so both themes share the same class names. Fonts come from
// the bundled @fontsource packages (imported in src/main.tsx), never a CDN.
//
// Type scale: xs 11 (tiny labels), s 12.5 (labels), m 14 (body), section 15
// (section titles), title 20 (page title), l 28 (headline metrics), xl 32.
// The s / m / l names predate this pass and every page uses them, so the
// other pages inherit the new sizes without a layout change.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        xs: ['11px', '1.4'],
        s: ['12.5px', '1.45'],
        m: ['14px', '1.55'],
        section: ['15px', '1.4'],
        title: ['20px', '1.25'],
        l: ['28px', '1.1'],
        xl: ['32px', '1.05'],
      },
      colors: {
        bg: { 0: 'hsl(var(--bg-0))', 1: 'hsl(var(--bg-1))', 2: 'hsl(var(--bg-2))', 3: 'hsl(var(--bg-3))' },
        line: { DEFAULT: 'hsl(var(--line))', strong: 'hsl(var(--line-strong))' },
        fg: { DEFAULT: 'hsl(var(--text))', 2: 'hsl(var(--text-2))', 3: 'hsl(var(--text-3))' },
        accent: { DEFAULT: 'hsl(var(--accent))', soft: 'hsl(var(--accent) / 0.12)' },
        brand: { DEFAULT: 'hsl(var(--brand))', fg: 'hsl(var(--brand-fg))', soft: 'hsl(var(--brand) / 0.12)' },
        pass: { DEFAULT: 'hsl(var(--pass))', soft: 'hsl(var(--pass) / 0.12)' },
        rework: { DEFAULT: 'hsl(var(--rework))', soft: 'hsl(var(--rework) / 0.14)' },
        reject: { DEFAULT: 'hsl(var(--reject))', soft: 'hsl(var(--reject) / 0.12)' },
        finding: { DEFAULT: 'hsl(var(--finding))', soft: 'hsl(var(--finding) / 0.12)' },
        neutral: { DEFAULT: 'hsl(var(--neutral))', soft: 'hsl(var(--neutral) / 0.12)' },
        cost: { DEFAULT: 'hsl(var(--cost))', soft: 'hsl(var(--cost) / 0.12)' },
      },
      borderRadius: { lg: '12px', md: '9px', sm: '6px' },
      boxShadow: { lift: 'var(--shadow-lift)' },
      maxWidth: { content: '1280px' },
    },
  },
  plugins: [animate],
} satisfies Config;
