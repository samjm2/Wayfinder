/* Wayfinder brand mark — a location pin holding a dawn landscape
   (sun rising over topographic ridgelines). Matches the "Dawn /
   Horizon" design language. Swap for a real asset later by dropping
   a PNG/SVG in /public and pointing <Logo> at it. */

interface Props {
  size?: number;
  className?: string;
}

export default function Logo({ size = 32, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <defs>
        <linearGradient id="wf-pin" x1="24" y1="2" x2="24" y2="46" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2c5e45" />
          <stop offset="1" stopColor="#1a271f" />
        </linearGradient>
        <linearGradient id="wf-sky" x1="24" y1="8" x2="24" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f3d8b9" />
          <stop offset="1" stopColor="#fae7c6" />
        </linearGradient>
        <radialGradient id="wf-sun" cx="0.5" cy="0.5" r="0.5">
          <stop stopColor="#fff3d6" />
          <stop offset="1" stopColor="#e8a24a" />
        </radialGradient>
        <clipPath id="wf-window">
          <circle cx="24" cy="19" r="13" />
        </clipPath>
      </defs>

      {/* pin teardrop */}
      <path
        d="M24 2C14.6 2 7 9.4 7 18.7c0 7 5.2 14.4 15.6 25.7a1.9 1.9 0 0 0 2.8 0C35.8 33.1 41 25.7 41 18.7 41 9.4 33.4 2 24 2Z"
        fill="url(#wf-pin)"
      />

      {/* landscape window */}
      <g clipPath="url(#wf-window)">
        <rect x="11" y="6" width="26" height="26" fill="url(#wf-sky)" />
        {/* sun, upper right */}
        <circle cx="29.5" cy="15.5" r="3.6" fill="url(#wf-sun)" />
        {/* ridgelines */}
        <path d="M11 27c4-5 7-3 10 0s6 2 9-2 5-1 7 1v9H11Z" fill="#79b98c" />
        <path d="M11 30c5-4 9 0 13 1s8-2 13 1v3H11Z" fill="#2c5e45" />
      </g>

      {/* inner rim */}
      <circle cx="24" cy="19" r="13" stroke="#fffefb" strokeOpacity="0.85" strokeWidth="1.6" />
    </svg>
  );
}
