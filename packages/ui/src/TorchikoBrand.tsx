type TorchikoIconProps = {
  className?: string
}

type TorchikoBrandProps = {
  className?: string
  iconClassName?: string
  textClassName?: string
  textSizeClassName?: string
  gapClassName?: string
}

export function TorchikoIcon({ className = 'h-7 w-7' }: TorchikoIconProps) {
  return <img className={className} src="/torchiko-logo.svg" alt="" aria-hidden="true" />
}

export function TorchikoBrand({
  className = '',
  iconClassName = 'h-7 w-7 flex-shrink-0',
  textClassName = '',
  textSizeClassName = 'text-lg',
  gapClassName = 'gap-2.5',
}: TorchikoBrandProps) {
  return (
    <div className={`flex items-center ${gapClassName} ${className}`}>
      <TorchikoIcon className={iconClassName} />
      <span className={`${textSizeClassName} font-semibold tracking-tight ${textClassName}`}>
        Torchiko
      </span>
    </div>
  )
}
