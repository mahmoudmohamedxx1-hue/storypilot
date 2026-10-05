export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="spg" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#315CEA" />
          <stop offset="0.55" stopColor="#5B8DEF" />
          <stop offset="1" stopColor="#19C3B8" />
        </linearGradient>
      </defs>
      <path
        d="M24 4C13 4 4 12.5 4 23c0 4.6 1.8 8.8 4.9 12.1L6.8 42.4c-.4 1.2.8 2.3 2 1.8l8.1-3.2c2.2.7 4.6 1 7.1 1 11 0 20-8.5 20-19S35 4 24 4Z"
        fill="url(#spg)"
      />
      <path
        d="M17.5 24.2a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0ZM26.3 24.2a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0ZM35.1 24.2a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z"
        fill="#fff"
      />
    </svg>
  )
}
