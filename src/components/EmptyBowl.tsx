/**
 * 空状态插画：一只空碗 + 筷子。内联 SVG，线条抖动一点，模仿手绘。
 * 不引图片资源，保证单文件打包后体积不变。
 */
export function EmptyBowl({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 160 130"
      fill="none"
      role="img"
      aria-label="空碗"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 筷子 */}
      <path
        d="M28 20 L62 62"
        stroke="var(--accent)"
        strokeWidth="3.4"
        opacity="0.85"
      />
      <path
        d="M42 14 L74 56"
        stroke="var(--accent)"
        strokeWidth="3.4"
        opacity="0.65"
      />

      {/* 热气 */}
      <path
        d="M76 30 q5 -8 0 -16 q-5 -8 0 -14"
        stroke="var(--ink-faint)"
        strokeWidth="2.4"
        opacity="0.8"
      />
      <path
        d="M96 34 q5 -7 0 -14 q-5 -7 0 -12"
        stroke="var(--ink-faint)"
        strokeWidth="2.4"
        opacity="0.55"
      />

      {/* 碗口 */}
      <ellipse
        cx="80"
        cy="74"
        rx="52"
        ry="12"
        stroke="var(--ink-soft)"
        strokeWidth="2.4"
      />
      {/* 碗身：两段贝塞尔拼出略不对称的弧 */}
      <path
        d="M28 74 c2 22 18 38 52 38 c34 0 50 -16 52 -38"
        stroke="var(--ink-soft)"
        strokeWidth="2.4"
      />
      {/* 碗内虚线，表示「空」 */}
      <ellipse
        cx="80"
        cy="74"
        rx="38"
        ry="8"
        stroke="var(--ink-faint)"
        strokeWidth="1.8"
        strokeDasharray="6 5"
      />
      {/* 碗底 */}
      <path
        d="M62 112 h36"
        stroke="var(--ink-soft)"
        strokeWidth="2.2"
        opacity="0.7"
      />

      {/* 几点手绘感的小装饰 */}
      <path d="M18 96 q4 -5 8 0" stroke="var(--ink-faint)" strokeWidth="2" />
      <path d="M138 60 q4 -5 8 0" stroke="var(--ink-faint)" strokeWidth="2" />
      <circle cx="132" cy="98" r="2.4" fill="var(--rule)" stroke="none" />
      <circle cx="24" cy="52" r="2" fill="var(--rule)" stroke="none" />
    </svg>
  )
}
