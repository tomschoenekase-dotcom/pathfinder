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
  return (
    <span
      className={`${className} inline-flex min-w-0 max-w-full items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap text-[0.7em] font-semibold leading-none tracking-tight`}
      aria-hidden="true"
    >
      Torchiko
    </span>
  )
}

export function TorchikoBrand({
  className = '',
  textClassName = '',
  textSizeClassName = 'text-lg',
  gapClassName = 'gap-2.5',
}: TorchikoBrandProps) {
  return (
    <div className={`flex items-center ${gapClassName} ${className}`}>
      <span className={`${textSizeClassName} font-semibold tracking-tight ${textClassName}`}>
        Torchiko
      </span>
    </div>
  )
}
