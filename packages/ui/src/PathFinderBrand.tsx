type PathFinderIconProps = {
  className?: string
}

type PathFinderBrandProps = {
  className?: string
  iconClassName?: string
  textClassName?: string
  textSizeClassName?: string
  gapClassName?: string
}

export function PathFinderIcon({ className = 'h-7 w-7' }: PathFinderIconProps) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="#1F4E8C"
        d="M16 3C10.477 3 6 7.477 6 13c0 3.09 1.38 5.857 3.563 7.746L16 29l6.437-8.254A9.956 9.956 0 0 0 26 13c0-5.523-4.477-10-10-10z"
      />
      <circle fill="white" cx="16" cy="13" r="3.5" />
    </svg>
  )
}

export function PathFinderBrand({
  className = '',
  iconClassName = 'h-7 w-7 flex-shrink-0',
  textClassName = '',
  textSizeClassName = 'text-lg',
  gapClassName = 'gap-2.5',
}: PathFinderBrandProps) {
  return (
    <div className={`flex items-center ${gapClassName} ${className}`}>
      <PathFinderIcon className={iconClassName} />
      <span className={`${textSizeClassName} font-semibold tracking-tight ${textClassName}`}>
        PathFinder
      </span>
    </div>
  )
}
