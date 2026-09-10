/** 手账胶带装饰。纯装饰，不进无障碍树。 */

export type TapeColor = 'orange' | 'blue' | 'green' | 'pink' | 'yellow'

/** 分类 → 胶带颜色。没匹配上的用默认的橘色。 */
const CATEGORY_TAPE: Record<string, TapeColor> = {
  硬菜: 'pink',
  甜品: 'pink',
  素菜: 'green',
  凉菜: 'green',
  汤羹: 'blue',
  主食: 'yellow',
  家常热菜: 'orange',
}

export function tapeColorOf(category: string | undefined): TapeColor {
  return (category && CATEGORY_TAPE[category]) || 'orange'
}

export function Tape({
  variant = 'center',
  color = 'orange',
}: {
  variant?: 'center' | 'left' | 'right'
  color?: TapeColor
}) {
  const cls = [
    'tape',
    variant === 'center' ? '' : `tape-${variant}`,
    color === 'orange' ? '' : `tape-${color}`,
  ]
    .filter(Boolean)
    .join(' ')
  return <span className={cls} aria-hidden="true" />
}
