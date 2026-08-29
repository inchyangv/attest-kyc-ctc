import type { SVGProps } from 'react';

/** 24px outline icons, 1.75 stroke, round joins, in the same voice as the explorer's icon set. */
const PATHS = {
  shield: <><path d="M12 3l7 3v5.2c0 4.6-3 8.3-7 9.8-4-1.5-7-5.2-7-9.8V6l7-3Z" /><path d="m9 12 2 2 4-4" /></>,
  cube: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
  swatch: <><circle cx="12" cy="12" r="9" /><circle cx="8.5" cy="10.5" r="1" fill="currentColor" /><circle cx="12.5" cy="7.5" r="1" fill="currentColor" /><circle cx="16" cy="10.5" r="1" fill="currentColor" /><path d="M12 21a2.5 2.5 0 0 1 0-5h1.5a2 2 0 0 0 0-4H12" /></>,
  external: <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M19 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5.5" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a1 1 0 0 1 1-1h9" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  warning: <><path d="M12 4 21 20H3L12 4Z" /><path d="M12 10v4M12 17h.01" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" /><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  gauge: <><path d="M4 16a8 8 0 1 1 16 0" /><path d="m12 16 4-5" /></>,
  hash: <path d="M9 4 7 20M17 4l-2 16M4 9h17M3 15h17" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l2 2M14.5 8.5 17 11" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  wallet: <><path d="M3 7a2 2 0 0 1 2-2h14v4" /><path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2Z" /><circle cx="16.5" cy="14" r="1" fill="currentColor" /></>,
  policy: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 12h6M9 16h6" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5M3 17l9 5 9-5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  block: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className} {...rest}>
      {PATHS[name]}
    </svg>
  );
}

/** Creditcoin network mark (from the explorer's network_icon.svg). Used only to credit the network. */
export function CreditcoinMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" fill="currentColor" aria-hidden className={className}>
      <path fillRule="evenodd" clipRule="evenodd" d="M15.0001 27.0331C19.423 27.0331 23.2968 24.6153 25.3845 21.044L27.9945 22.5276C25.3845 26.9782 20.5494 30 15.0001 30C6.70336 30 0 23.2967 0 15C0 6.7033 6.70336 0 15.0001 0C20.5494 0 25.4121 3.02182 27.9945 7.5L25.3845 9.01091C23.324 5.43955 19.4506 3.02182 15.0001 3.02182C8.3792 3.02182 2.99441 8.40648 2.99441 15.0276C2.99441 21.6484 8.3792 27.0331 15.0001 27.0331ZM17.6223 13.517H30.0123V16.4843H17.6223C17.1277 17.3908 16.1387 17.9952 15.0398 17.9952C13.3914 17.9952 12.0453 16.649 12.0453 15.0007C12.0453 13.3524 13.3914 12.0061 15.0398 12.0061C16.1387 12.0061 17.1001 12.6106 17.6223 13.517Z" />
    </svg>
  );
}
