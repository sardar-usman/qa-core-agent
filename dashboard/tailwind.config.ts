import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Design tokens from the plan (section 8): Inter, three sizes two weights,
// semantic colors, one cost accent. Values live as CSS variables in
// src/index.css so both themes share the same class names.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'], mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'] },
      fontSize: { s: ['12px', '1.4'], m: ['13.5px', '1.5'], l: ['24px', '1.1'] },
      colors: {
        bg: { 0: 'hsl(var(--bg-0))', 1: 'hsl(var(--bg-1))', 2: 'hsl(var(--bg-2))', 3: 'hsl(var(--bg-3))' },
        line: { DEFAULT: 'hsl(var(--line))', strong: 'hsl(var(--line-strong))' },
        fg: { DEFAULT: 'hsl(var(--text))', 2: 'hsl(var(--text-2))', 3: 'hsl(var(--text-3))' },
        accent: { DEFAULT: 'hsl(var(--accent))', soft: 'hsl(var(--accent) / 0.12)' },
        pass: { DEFAULT: 'hsl(var(--pass))', soft: 'hsl(var(--pass) / 0.12)' },
        rework: { DEFAULT: 'hsl(var(--rework))', soft: 'hsl(var(--rework) / 0.14)' },
        reject: { DEFAULT: 'hsl(var(--reject))', soft: 'hsl(var(--reject) / 0.12)' },
        finding: { DEFAULT: 'hsl(var(--finding))', soft: 'hsl(var(--finding) / 0.12)' },
        neutral: { DEFAULT: 'hsl(var(--neutral))', soft: 'hsl(var(--neutral) / 0.12)' },
        cost: { DEFAULT: 'hsl(var(--cost))', soft: 'hsl(var(--cost) / 0.12)' },
      },
      borderRadius: { lg: '12px', md: '9px', sm: '6px' },
    },
  },
  plugins: [animate],
} satisfies Config;
