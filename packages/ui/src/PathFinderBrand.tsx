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
  return <img className={className} src="/torchiko-logo.svg" alt="" aria-hidden="true" />
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
        Torchiko
      </span>
    </div>
  )
}
