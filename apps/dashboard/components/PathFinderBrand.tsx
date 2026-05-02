type PathFinderBrandProps = {
  className?: string
  textClassName?: string
}

export function PathFinderBrand({ className = '' }: PathFinderBrandProps) {
  return (
    <div className={`flex items-center ${className}`}>
      <div className="rounded-2xl bg-pf-deep p-3">
        <img src="/pathfinder-logo.png" alt="PathFinder" className="h-36 w-auto" />
      </div>
    </div>
  )
}
