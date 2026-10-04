import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Design tokens (PR F, part 1). Values live as CSS variables in
// src/index.css so both themes share the same class names. Fonts come from
// the bundled @fontsource-variable packages (imported in src/main.tsx), never
// a CDN: Geist Sans for all UI text and all numbers (tabular figures on),
// Geist Mono only for run ids, commands and code.
//
// Type scale: xs 11, s 12 (labels), m 13 (body and tables), section 15
// semibold, title 22 semibold (page titles), l 24 semibold (key metrics),
// xl 28. The s / m / l names predate this pass and every page uses them, so
// the other pages inherit the scale without a layout change.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist Variable', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['Geist Mono Variable', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        xs: ['11px', '1.35'],
        s: ['12px', '1.4'],
        m: ['13px', '1.45'],
        section: ['15px', '1.3'],
        title: ['22px', '1.2'],
        l: ['24px', '1.1'],
        xl: ['28px', '1.05'],
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
