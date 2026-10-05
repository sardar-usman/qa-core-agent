import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Design tokens (PR F, part 1). Values live as CSS variables in
// src/index.css so both themes share the same class names. Fonts come from
// the bundled @fontsource-variable packages (imported in src/main.tsx), never
// a CDN: Plus Jakarta Sans for all UI text and all numbers (tabular figures
// on), Geist Mono only for run ids, commands and code.
//
// Type scale (design system, invariant 68): exactly seven sizes, replacing
// Tailwind's defaults entirely (theme.fontSize, not extend), so no page can
// reach for text-sm or text-xl. Weights are 400, 500 and 600 only. The
// role map in docs/ui/design-system.md says which size each element takes.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    fontSize: {
      display: ['32px', { lineHeight: '40px', letterSpacing: '-0.02em' }],
      title: ['24px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
      heading: ['18px', { lineHeight: '26px', letterSpacing: '-0.01em' }],
      subheading: ['16px', { lineHeight: '24px', letterSpacing: '0' }],
      body: ['14px', { lineHeight: '22px', letterSpacing: '0' }],
      small: ['13px', { lineHeight: '20px', letterSpacing: '0' }],
      caption: ['12px', { lineHeight: '16px', letterSpacing: '0' }],
    },
    // Radius tokens: lg 12 (cards), md 8 (buttons, inputs), sm 6 (badges), full for pills. No xl.
    borderRadius: { none: '0', sm: '6px', DEFAULT: '8px', md: '8px', lg: '12px', full: '9999px' },
    extend: {
      fontFamily: {
        sans: ['Plus Jakarta Sans Variable', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['Geist Mono Variable', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        bg: { 0: 'hsl(var(--bg-0))', 1: 'hsl(var(--bg-1))', 2: 'hsl(var(--bg-2))', 3: 'hsl(var(--bg-3))' },
        line: { DEFAULT: 'hsl(var(--line))', strong: 'hsl(var(--line-strong))' },
        fg: { DEFAULT: 'hsl(var(--text))', 2: 'hsl(var(--text-2))', 3: 'hsl(var(--text-3))' },
        accent: { DEFAULT: 'hsl(var(--accent))', soft: 'hsl(var(--accent) / 0.12)' },
        'nav-active': { DEFAULT: 'hsl(var(--nav-active-bg))', fg: 'hsl(var(--nav-active-fg))' },
        brand: { DEFAULT: 'hsl(var(--brand))', fg: 'hsl(var(--brand-fg))', soft: 'hsl(var(--brand) / 0.12)' },
        pass: { DEFAULT: 'hsl(var(--pass))', soft: 'hsl(var(--pass) / 0.12)' },
        rework: { DEFAULT: 'hsl(var(--rework))', soft: 'hsl(var(--rework) / 0.14)' },
        reject: { DEFAULT: 'hsl(var(--reject))', soft: 'hsl(var(--reject) / 0.12)' },
        finding: { DEFAULT: 'hsl(var(--finding))', soft: 'hsl(var(--finding) / 0.12)' },
        neutral: { DEFAULT: 'hsl(var(--neutral))', soft: 'hsl(var(--neutral) / 0.12)' },
        cost: { DEFAULT: 'hsl(var(--cost))', soft: 'hsl(var(--cost) / 0.12)' },
      },
      boxShadow: { lift: 'var(--shadow-lift)' },
      maxWidth: { content: '1280px' },
    },
  },
  plugins: [animate],
} satisfies Config;
