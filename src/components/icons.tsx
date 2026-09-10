/**
 * 内联 SVG 小图标集。
 * 全部用 currentColor 描边，跟着文字颜色走；线条略抖动，配手账风。
 */
import type { SVGProps } from 'react'

export type IconName =
  | 'edit'
  | 'copy'
  | 'trash'
  | 'image'
  | 'share'
  | 'check'
  | 'plus'
  | 'download'
  | 'upload'
  | 'info'
  | 'broom'
  | 'seed'
  | 'lock'

const PATHS: Record<IconName, { d: string[]; fill?: boolean }> = {
  edit: { d: ['M4 20h4L19 9a2.6 2.6 0 0 0-3.7-3.7L4 16.6V20z', 'M13.5 6.5 17.5 10.5'] },
  copy: {
    d: [
      'M8.5 8.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 7 19v-9a1.5 1.5 0 0 1 1.5-1.5z',
      'M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5',
    ],
  },
  trash: {
    d: [
      'M4.5 7h15',
      'M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2',
      'M6.5 7l1 12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-12',
      'M10.5 11v5.5M13.5 11v5.5',
    ],
  },
  image: {
    d: [
      'M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z',
      'M4 16l4.6-4.4 3.2 3 3-2.6L20 16',
      'M9 10.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z',
    ],
  },
  share: {
    d: [
      'M12 15.5V4.5',
      'M8 8l4-3.5L16 8',
      'M5 14v4.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V14',
    ],
  },
  check: { d: ['M5 12.5 10 17.5 19 7'] },
  plus: { d: ['M12 5.5v13', 'M5.5 12h13'] },
  download: { d: ['M12 4.5v11', 'M8 11.5l4 4 4-4', 'M5 19.5h14'] },
  upload: { d: ['M12 19.5v-11', 'M8 12.5l4-4 4 4', 'M5 4.5h14'] },
  info: {
    d: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z', 'M12 11v5.5', 'M12 8.2v.1'],
  },
  broom: {
    d: [
      'M14.5 4.5 9 10',
      'M8 9l7 7',
      'M11.5 12.5 5.5 19.5l3-1.5 1.5 1.5 5.5-6.5',
    ],
  },
  seed: {
    d: [
      'M12 20.5c0-5 2.5-8 7-9.5-1 5-3 8-7 9.5z',
      'M12 20.5c0-5-2.5-8.5-7-10 1 5.5 3 8.5 7 10z',
      'M12 20.5V12',
    ],
  },
  lock: {
    d: [
      'M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
      'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
    ],
  },
}

export function CIcon({
  name,
  size = 18,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const icon = PATHS[name]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {icon.d.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
