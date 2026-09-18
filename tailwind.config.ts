import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      /*
        결과가 도착할 때 쓰는 등장 동작.

        위로 4px 올라오며 나타난다 — 방향이 "새로 온 것" 을 말한다. 6px 를
        넘기면 자리를 잡는 게 눈에 띄어 읽기가 늦어진다.
        나가는 건 만들지 않았다. 이 박스는 바뀔 때 내용만 갈리지 사라지지
        않는다 — 쓰지 않을 것을 미리 만들지 않는다.
      */
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        /* 스켈레톤이 왼쪽에서 오른쪽으로 훑고 지나간다. */
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        // 진입은 ease-out. 빨리 나타나고 천천히 멎는 게 자연스럽다.
        'fade-up': 'fade-up 180ms ease-out',
        shimmer: 'shimmer 1.4s infinite',
      },
    },
  },
  plugins: [],
};

export default config;
